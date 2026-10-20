import { describe, expect, it, vi } from "vitest";
import type { DogView } from "../shared/diary.js";
import { createDogDiary, tinybirdStore } from "./dog-diary.js";

const resting: DogView = { dog_visible: true, dog_activity: "resting", dog_location: "bed" };
const atDoor: DogView = { dog_visible: true, dog_activity: "moving", dog_location: "door" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let clock = Date.parse("2026-09-28T09:00:00Z");
const reading = (view: DogView, description = "The dog is lying on its bed.") => ({ description, view, observedAt: (clock += 12_000), model: "LFM2.5-VL-3B", camera: "home" as const });
const tinybird = (remote: typeof fetch) => tinybirdStore({ token: "synthetic-token-do-not-expose", host: "https://api.us-west-2.aws.tinybird.co" }, remote);
const sent = (init?: RequestInit) => String(init?.body).trim().split("\n").map(line => JSON.parse(line) as { entry_id: string });
const row = (entry_id: string, observed_at: string, description: string) => ({ entry_id, observed_at, description, dog_visible: "yes", activity: "resting", location: "bed", model: "LFM2.5-VL-3B", camera: "home" });

describe("dog diary", () => {
  it("adds an entry only when two readings confirm the dog's activity or place changed", async () => {
    const diary = createDogDiary(() => null);
    expect(diary.observe(reading(resting))).toBeNull();
    expect(diary.observe(reading(resting, "A dog rests on a cushion."))).toMatchObject({ dog_activity: "resting", description: "A dog rests on a cushion." });
    // New wording for the same state is not a change.
    expect(diary.observe(reading(resting, "The dog is asleep in its bed."))).toBeNull();
    // One misread image never becomes an entry.
    expect(diary.observe(reading(atDoor))).toBeNull();
    expect(diary.observe(reading(resting))).toBeNull();
    // Vague readings are no change, and do not cancel one that is waiting for confirmation.
    const vague: DogView = { dog_visible: true, dog_activity: "unknown", dog_location: "unknown" };
    expect(diary.observe(reading(vague))).toBeNull();
    expect(diary.observe(reading(vague))).toBeNull();
    expect(diary.observe(reading(atDoor))).toBeNull();
    expect(diary.observe(reading({ dog_visible: "unknown", dog_activity: "unknown", dog_location: "unknown" }))).toBeNull();
    expect(diary.observe(reading(atDoor, "The dog waits by the door."))).toMatchObject({ dog_location: "door" });
    const listing = await diary.list();
    expect(listing.storage).toBe("memory");
    expect(listing.entries.map(entry => entry.dog_location)).toEqual(["door", "bed"]);
    expect(listing.message).toContain("npm run tinybird:setup");
  });

  it("reads entries back newest first without repeats", async () => {
    const remote = vi.fn<typeof fetch>();
    remote.mockResolvedValueOnce(json({ successful_rows: 1, quarantined_rows: 0 }, 202));
    const diary = createDogDiary(() => tinybird(remote));
    diary.observe(reading(resting));
    const entry = diary.observe(reading(resting))!;
    const older = row("older", "2026-09-28 08:00:00.000", "The dog sleeps in its crate.");
    remote.mockResolvedValueOnce(json({ data: [row(entry.entry_id, entry.observed_at, entry.description), older, older] }));
    const listing = await diary.list();
    expect(sent(remote.mock.calls[0][1])).toEqual([expect.objectContaining({ entry_id: entry.entry_id, dog_visible: "yes", activity: "resting", location: "bed", camera: "home" })]);
    expect(listing.entries.map(item => item.entry_id)).toEqual([entry.entry_id, "older"]);
    expect(listing.entries[1]).toMatchObject({ observed_at: "2026-09-28T08:00:00.000Z", dog_visible: true, saved: true });
  });

  it("keeps an unconfirmed entry and sends it again on the next refresh or entry", async () => {
    const remote = vi.fn<typeof fetch>();
    remote.mockResolvedValueOnce(json({ error: "echo synthetic-token-do-not-expose" }, 503));
    let clock = Date.parse("2026-09-28T10:00:00Z");
    const diary = createDogDiary(() => tinybird(remote), () => clock);
    diary.observe(reading(resting));
    const first = diary.observe(reading(resting))!;
    // The refresh retries the write, which fails again; a table that is not deployed yet reads as HTTP 404.
    remote.mockResolvedValueOnce(json({ error: "still down" }, 503));
    remote.mockResolvedValueOnce(json({ error: "Resource not found" }, 404));
    const failed = await diary.list();
    expect(failed.entries).toEqual([expect.objectContaining({ entry_id: first.entry_id, saved: false })]);
    expect(failed.message).toContain("try again");
    expect(String(remote.mock.calls[1][0])).toContain("/v0/events?name=dog_diary");
    expect(JSON.stringify(failed)).not.toContain("synthetic-token");
    remote.mockResolvedValueOnce(json({ successful_rows: 2, quarantined_rows: 0 }, 202));
    diary.observe(reading(atDoor));
    const second = diary.observe(reading(atDoor))!;
    // A failed read is tried again a minute later, not on every refresh.
    clock += 60_000;
    remote.mockResolvedValueOnce(json({ data: [] }));
    await diary.list();
    expect(sent(remote.mock.calls[3][1]).map(item => item.entry_id)).toEqual([first.entry_id, second.entry_id]);
    expect(remote).toHaveBeenCalledTimes(5);
  });

  it("reads the saved diary once, then keeps it up to date itself, to stay within Tinybird's daily reads", async () => {
    const remote = vi.fn<typeof fetch>(async (input, init) => init?.method === "POST" ? json({ successful_rows: 1, quarantined_rows: 0 }, 202) : json({ data: [] }));
    const diary = createDogDiary(() => tinybird(remote));
    await diary.list();
    diary.observe(reading(resting));
    const entry = diary.observe(reading(resting))!;
    for (let refresh = 0; refresh < 5; refresh++) await diary.list();
    const listing = await diary.list();
    expect(listing.entries.map(item => item.entry_id)).toEqual([entry.entry_id]);
    expect(remote.mock.calls.filter(([input]) => String(input).includes("/v0/sql"))).toHaveLength(1);
  });

  it("picks up from the newest saved entry after a restart, so an unchanged dog is not logged again", async () => {
    const remote = vi.fn<typeof fetch>();
    remote.mockResolvedValueOnce(json({ data: [row("earlier", "2026-09-28 08:00:00.000", "The dog sleeps in its crate.")] }));
    const diary = createDogDiary(() => tinybird(remote));
    await diary.list();
    expect(diary.observe(reading(resting))).toBeNull();
    expect(diary.observe(reading(resting))).toBeNull();
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it("saves to Tinybird through the Events API and reads the diary back with SQL", async () => {
    const remote = vi.fn<typeof fetch>();
    remote.mockResolvedValueOnce(json({ successful_rows: 1, quarantined_rows: 0 }, 202));
    const diary = createDogDiary(() => tinybirdStore({ token: "synthetic-token-do-not-expose", host: "https://api.us-west-2.aws.tinybird.co/" }, remote));
    diary.observe(reading(resting));
    const entry = diary.observe(reading(resting))!;
    remote.mockResolvedValueOnce(json({ data: [row(entry.entry_id, entry.observed_at.replace("T", " ").replace("Z", ""), entry.description)] }));
    const listing = await diary.list();
    const [writeUrl, write] = remote.mock.calls[0];
    expect(String(writeUrl)).toBe("https://api.us-west-2.aws.tinybird.co/v0/events?name=dog_diary&wait=true");
    expect(new Headers(write?.headers).get("authorization")).toBe("Bearer synthetic-token-do-not-expose");
    expect(new Headers(write?.headers).get("content-type")).toBe("application/x-ndjson");
    expect(String(write?.body).trim().split("\n").map(line => JSON.parse(line).entry_id)).toEqual([entry.entry_id]);
    const readUrl = new URL(String(remote.mock.calls[1][0]));
    expect(readUrl.pathname).toBe("/v0/sql");
    expect(readUrl.searchParams.get("q")).toMatch(/^SELECT .* FROM dog_diary ORDER BY observed_at DESC LIMIT 100 FORMAT JSON$/);
    expect(listing).toMatchObject({ storage: "tinybird", place: "Tinybird · dog_diary", message: "Saved in Tinybird · dog_diary" });
    expect(listing.entries).toEqual([expect.objectContaining({ entry_id: entry.entry_id, observed_at: entry.observed_at, saved: true })]);
    expect(JSON.stringify(listing)).not.toContain("synthetic-token");
  });

  it("does not count rows Tinybird set aside as saved", async () => {
    const remote = vi.fn<typeof fetch>();
    remote.mockResolvedValueOnce(json({ successful_rows: 0, quarantined_rows: 1 }, 202));
    const diary = createDogDiary(() => tinybirdStore({ token: "synthetic-token-do-not-expose", host: "https://api.us-west-2.aws.tinybird.co" }, remote));
    diary.observe(reading(atDoor));
    diary.observe(reading(atDoor));
    remote.mockResolvedValueOnce(json({ successful_rows: 0, quarantined_rows: 1 }, 202));
    remote.mockResolvedValueOnce(json({ data: [] }));
    const listing = await diary.list();
    expect(listing.entries).toEqual([expect.objectContaining({ dog_location: "door", saved: false })]);
    expect(listing.message).toContain("Tinybird has not confirmed");
  });
});

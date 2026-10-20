import { describe, expect, it, vi } from "vitest";
import { createDogLog } from "./dog-log.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const target = { token: "synthetic-token-do-not-expose", host: "https://api.us-west-2.aws.tinybird.co" };
const rows = (init?: RequestInit) => String(init?.body).trim().split("\n").map(line => JSON.parse(line));

describe("PetAnalytics log", () => {
  it("batches camera readings and confirms events before calling them saved", async () => {
    const remote = vi.fn<typeof fetch>().mockResolvedValue(json({ successful_rows: 2, quarantined_rows: 0 }, 202));
    const log = createDogLog(() => target, remote, () => Date.parse("2026-09-28T07:40:00Z"));
    try {
      log.recordReading({ dog_visible: true, dog_activity: "eating", dog_location: "floor", person_visible: true }, Date.parse("2026-09-28T07:39:00Z"), "home");
      log.recordReading({ dog_visible: false, dog_activity: "unknown", dog_location: "unknown" }, Date.parse("2026-09-28T07:39:12Z"), "home");
      await log.flush();
      const [url, init] = remote.mock.calls[0];
      expect(String(url)).toBe("https://api.us-west-2.aws.tinybird.co/v0/events?name=dog_readings");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-token-do-not-expose");
      expect(rows(init)).toEqual([
        { observed_at: "2026-09-28T07:39:00.000Z", dog_visible: "yes", activity: "eating", location: "floor", person_visible: "yes", camera: "home" },
        { observed_at: "2026-09-28T07:39:12.000Z", dog_visible: "no", activity: "unknown", location: "unknown", person_visible: "unknown", camera: "home" }
      ]);
      remote.mockResolvedValueOnce(json({ successful_rows: 1, quarantined_rows: 0 }, 202));
      const played = await log.recordEvent("comfort", "dog-music", "camera");
      expect(String(remote.mock.calls[1][0])).toBe("https://api.us-west-2.aws.tinybird.co/v0/events?name=dog_events&wait=true");
      expect(played).toMatchObject({ kind: "comfort", detail: "dog-music", source: "camera", observed_at: "2026-09-28T07:40:00.000Z" });
      expect(rows(remote.mock.calls[1][1])[0].event_id).toBe(played.event_id);
    } finally { log.dispose(); }
  });

  it("sends sound minutes to their own table with the readings", async () => {
    const remote = vi.fn<typeof fetch>().mockResolvedValue(json({ successful_rows: 1, quarantined_rows: 0 }, 202));
    const log = createDogLog(() => target, remote);
    try {
      log.recordSound({ observed_at: "2026-09-28T07:39:00.000Z", camera: "home", heard_seconds: 60, crying_seconds: 12, barking_seconds: 0 });
      await log.flush();
      expect(String(remote.mock.calls[0][0])).toBe("https://api.us-west-2.aws.tinybird.co/v0/events?name=dog_sounds");
      expect(rows(remote.mock.calls[0][1])).toEqual([{ observed_at: "2026-09-28T07:39:00.000Z", camera: "home", heard_seconds: 60, crying_seconds: 12, barking_seconds: 0 }]);
    } finally { log.dispose(); }
  });

  it("keeps readings for the next batch after a passing failure", async () => {
    const remote = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({ successful_rows: 2, quarantined_rows: 0 }, 202));
    const log = createDogLog(() => target, remote);
    try {
      log.recordReading({ dog_visible: true, dog_activity: "resting", dog_location: "bed", person_visible: false }, 1_000, "home");
      await log.flush();
      log.recordReading({ dog_visible: true, dog_activity: "moving", dog_location: "door", person_visible: false }, 13_000, "home");
      await log.flush();
      expect(rows(remote.mock.calls[1][1]).map(row => row.activity)).toEqual(["resting", "moving"]);
      expect(log.status()).toEqual({ ready: true, problem: null });
    } finally { log.dispose(); }
  });

  it("counts a batch of readings as sent once Tinybird accepts it, and does not send quarantined rows again", async () => {
    const remote = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ successful_rows: 1, quarantined_rows: 1 }, 202)).mockResolvedValueOnce(json({}, 202));
    const log = createDogLog(() => target, remote);
    try {
      log.recordReading({ dog_visible: true, dog_activity: "resting", dog_location: "bed" }, 1_000, "home");
      log.recordReading({ dog_visible: true, dog_activity: "moving", dog_location: "floor" }, 13_000, "home");
      await log.flush();
      log.recordReading({ dog_visible: true, dog_activity: "playing", dog_location: "floor" }, 25_000, "home");
      await log.flush();
      expect(rows(remote.mock.calls[1][1]).map(row => row.activity)).toEqual(["playing"]);
      expect(log.status()).toEqual({ ready: true, problem: null });
    } finally { log.dispose(); }
  });

  it("stops writing and says what to do when the tables are missing, without passing on Tinybird's reply", async () => {
    const remote = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "echo synthetic-token-do-not-expose" }, 404));
    const log = createDogLog(() => target, remote);
    try {
      const failure = await log.recordEvent("comfort", "dog-music", "camera").catch(reason => reason);
      expect(failure).toMatchObject({ status: 409 });
      expect(failure.message).toContain("npm run tinybird:setup");
      expect(failure.message).not.toContain("synthetic-token");
      expect(log.status().ready).toBe(false);
      log.recordReading({ dog_visible: true, dog_activity: "resting", dog_location: "bed" }, 1_000, "home");
      await log.flush();
      expect(remote).toHaveBeenCalledTimes(1);
    } finally { log.dispose(); }
  });

  it("stops only the sound minutes when the sound table is missing, and reads the rest of the week without them", async () => {
    const remote = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      const sql = url.searchParams.get("q") ?? "";
      if (url.searchParams.get("name") === "dog_sounds" || sql.includes("FROM dog_sounds")) return json({ error: "Resource not found" }, 404);
      if (url.searchParams.get("name")) return json({ successful_rows: 1, quarantined_rows: 0 }, 202);
      return json({ data: sql.includes("FROM dog_readings") ? [{ t: "1790582400000", dog_visible: "yes", activity: "resting", location: "bed", person_visible: "no" }] : [] });
    });
    const log = createDogLog(() => target, remote);
    try {
      log.recordSound({ observed_at: "2026-09-28T07:39:00.000Z", camera: "home", heard_seconds: 60, crying_seconds: 12, barking_seconds: 0 });
      await log.flush();
      expect(log.soundProblem()).toContain("dog_sounds");
      expect(log.status()).toEqual({ ready: true, problem: null });
      // No more sound minutes are sent, while readings carry on.
      log.recordSound({ observed_at: "2026-09-28T07:40:00.000Z", camera: "home", heard_seconds: 60, crying_seconds: 0, barking_seconds: 0 });
      log.recordReading({ dog_visible: true, dog_activity: "resting", dog_location: "bed", person_visible: false }, 1_000, "home");
      await log.flush();
      const writes = remote.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("name")).filter(Boolean);
      expect(writes).toEqual(["dog_sounds", "dog_readings"]);
      const result = await log.read(7);
      expect(result.readings).toHaveLength(1);
      expect(result.sounds).toEqual([]);
      expect(remote.mock.calls.some(([input]) => new URL(String(input)).searchParams.get("q")?.includes("FROM dog_sounds"))).toBe(false);
    } finally { log.dispose(); }
  });

  it("keeps sound minutes for the next batch after a passing failure", async () => {
    const remote = vi.fn<typeof fetch>().mockResolvedValueOnce(json({}, 503)).mockResolvedValue(json({ successful_rows: 2, quarantined_rows: 0 }, 202));
    const log = createDogLog(() => target, remote);
    try {
      log.recordSound({ observed_at: "2026-09-28T07:39:00.000Z", camera: "home", heard_seconds: 60, crying_seconds: 12, barking_seconds: 0 });
      await log.flush();
      expect(log.soundProblem()).toBeNull();
      log.recordSound({ observed_at: "2026-09-28T07:40:00.000Z", camera: "home", heard_seconds: 60, crying_seconds: 0, barking_seconds: 0 });
      await log.flush();
      expect(rows(remote.mock.calls[1][1]).map(row => row.observed_at)).toEqual(["2026-09-28T07:39:00.000Z", "2026-09-28T07:40:00.000Z"]);
    } finally { log.dispose(); }
  });

  it("finds a missing sound table on reading too, while a passing failure still fails the read", async () => {
    let soundReply = 503;
    const remote = vi.fn<typeof fetch>(async input => {
      const sql = new URL(String(input)).searchParams.get("q") ?? "";
      return sql.includes("FROM dog_sounds") ? json({}, soundReply) : json({ data: [] });
    });
    const log = createDogLog(() => target, remote);
    try {
      await expect(log.read(7)).rejects.toMatchObject({ status: 502 });
      expect(log.soundProblem()).toBeNull();
      soundReply = 400;
      expect(await log.read(7)).toEqual({ readings: [], sounds: [], events: [] });
      expect(log.soundProblem()).toContain("npm run tinybird:setup");
      expect(log.status().ready).toBe(true);
    } finally { log.dispose(); }
  });

  it("reads the last week through the SQL API", async () => {
    const remote = vi.fn<typeof fetch>(async input => {
      const sql = new URL(String(input)).searchParams.get("q") ?? "";
      return sql.includes("FROM dog_readings")
        ? json({ data: [{ t: "1790582400000", dog_visible: "yes", activity: "resting", location: "bed", person_visible: "no" }] })
        : sql.includes("FROM dog_sounds")
          ? json({ data: [{ t: "1790582400000", heard_seconds: 58, crying_seconds: 20, barking_seconds: 0 }] })
          : json({ data: [{ event_id: "e1", t: 1790582460000, kind: "comfort", detail: "dog-music", source: "camera" }] });
    });
    const log = createDogLog(() => target, remote);
    try {
      const result = await log.read(7);
      const queries = remote.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("q"));
      expect(queries.every(sql => sql?.includes("observed_at > now() - INTERVAL 7 DAY") && sql.endsWith("FORMAT JSON"))).toBe(true);
      expect(result).toEqual({
        readings: [{ t: 1790582400000, visible: "yes", activity: "resting", location: "bed", person: "no" }],
        sounds: [{ t: 1790582400000, heard: 58, crying: 20, barking: 0 }],
        events: [{ id: "e1", t: 1790582460000, kind: "comfort", detail: "dog-music", source: "camera" }]
      });
    } finally { log.dispose(); }
  });

  it("does nothing, and says so, when Tinybird is not set up", async () => {
    const remote = vi.fn<typeof fetch>();
    const log = createDogLog(() => null, remote);
    try {
      log.recordReading({ dog_visible: true, dog_activity: "resting", dog_location: "bed" }, 1_000, "home");
      await log.flush();
      await expect(log.recordEvent("comfort", "dog-music", "camera")).rejects.toMatchObject({ status: 409 });
      expect(remote).not.toHaveBeenCalled();
      expect(log.status().problem).toContain("npm run tinybird:setup");
    } finally { log.dispose(); }
  });
});

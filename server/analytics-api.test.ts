import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAnalyticsRouter } from "./analytics-api.js";
import type { createDogLog, Reading } from "./dog-log.js";

const now = Date.parse("2026-09-28T20:00:00Z");
const minutes = (count: number, from = now - 10 * 3_600_000): Reading[] => Array.from({ length: count }, (_, index) => ({ t: from + index * 60_000, visible: "yes", activity: index % 3 ? "resting" : "moving", location: "bed", person: "no" }));

function fakeLog(readings: Reading[], ready = true) {
  return {
    status: () => ready ? { ready: true, problem: null } : { ready: false, problem: "Tinybird is not set up. Run npm run tinybird:setup, then restart DogMaAI." },
    read: vi.fn(async () => ({ readings, sounds: [], events: [] })),
    recordEvent: vi.fn(async (kind: string, detail: string, source: string) => ({ event_id: "e0000000-0000-4000-8000-000000000001", observed_at: new Date(now).toISOString(), kind, detail, source })),
    recordReading: vi.fn(), flush: vi.fn(async () => {}), dispose: vi.fn()
  } as unknown as ReturnType<typeof createDogLog> & { read: ReturnType<typeof vi.fn>; recordEvent: ReturnType<typeof vi.fn> };
}

let server: Server | undefined;
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });
async function start(log: ReturnType<typeof fakeLog>, clock: () => number = () => now, soundProblem: () => string | null = () => null, soundTuning: () => { cutoff: number; set_at: string } | null = () => null) {
  const app = express();
  app.use("/api/manager", createAnalyticsRouter({ log, dogName: "Simba", timeZone: "UTC", now: clock, soundProblem, soundTuning }));
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  const port = (server.address() as AddressInfo).port;
  return (path: string, body?: unknown, headers: Record<string, string> = { Host: "localhost:3001", "X-Nightwatch-Local": "1" }) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}/api/manager${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...headers, "Content-Type": "application/json" } }, response => {
      let text = ""; response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
    });
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe("PetAnalytics routes", () => {
  it("shows the labelled sample week until eight hours of the dog's own watching, and the real data on request", async () => {
    const call = await start(fakeLog(minutes(90)));
    const sample = await call("/analytics");
    expect(sample.status).toBe(200);
    expect(sample.body).toMatchObject({ sample: true, dog_name: "Simba", real_watched_hours: 1.5, needed_hours: 8, logging: true });
    const real = await call("/analytics?view=real");
    expect(real.body).toMatchObject({ sample: false, watched_minutes: 90 });
  });

  it("switches to the dog's own data once it covers enough watching", async () => {
    const call = await start(fakeLog(minutes(9 * 60)));
    expect((await call("/analytics")).body).toMatchObject({ sample: false, watched_minutes: 540 });
  });

  it("keeps showing the last data it read when Tinybird does not answer, with logging still on", async () => {
    let time = now;
    const log = fakeLog(minutes(9 * 60));
    const call = await start(log, () => time);
    expect((await call("/analytics")).body).toMatchObject({ sample: false, watched_minutes: 540, read_problem: null });
    // Within 10 minutes the last read is used again, without asking Tinybird.
    time += 5 * 60_000;
    await call("/analytics");
    expect(log.read).toHaveBeenCalledTimes(1);
    log.read.mockRejectedValueOnce(new Error("Tinybird could not be read. Try again in a moment."));
    time += 6 * 60_000;
    const after = (await call("/analytics")).body;
    expect(after).toMatchObject({ sample: false, watched_minutes: 540, logging: true });
    expect(after.read_problem).toContain("last data it sent");
    expect(log.read).toHaveBeenCalledTimes(2);
  });

  it("explains tables that turn out to be missing once, as the setup problem", async () => {
    const log = fakeLog([]);
    let ready = true;
    const missing = "Tinybird does not have the PetAnalytics tables yet, or the token cannot use them. Run npm run tinybird:setup, then restart DogMaAI.";
    log.status = () => ready ? { ready: true, problem: null } : { ready: false, problem: missing };
    log.read.mockImplementationOnce(async () => { ready = false; throw new Error(missing); });
    const body = (await (await start(log))("/analytics")).body;
    expect(body).toMatchObject({ sample: true, logging: false, logging_problem: missing, read_problem: null });
  });

  it("explains a missing Tinybird setup and still shows the sample", async () => {
    const log = fakeLog([], false);
    const call = await start(log);
    const result = await call("/analytics");
    expect(result.body).toMatchObject({ sample: true, logging: false });
    expect(result.body.logging_problem).toContain("npm run tinybird:setup");
    expect(log.read).not.toHaveBeenCalled();
  });

  it("logs comfort sounds with checked input, for the local manager only, and no longer takes meals", async () => {
    const log = fakeLog([]);
    const call = await start(log);
    expect((await call("/log/comfort", { sound: "dog-music" }, {})).status).toBe(403);
    expect((await call("/log/comfort", { sound: "dog-music" })).status).toBe(200);
    expect((await call("/log/comfort", { sound: "found:Birdsong (Robin)" })).status).toBe(200);
    expect((await call("/log/comfort", { sound: "<script>" })).status).toBe(400);
    const meal = await new Promise<number>(resolve => { const request = httpRequest(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/api/manager/log/meal`, { method: "POST", headers: { Host: "localhost:3001", "X-Nightwatch-Local": "1" } }, response => { response.resume(); resolve(response.statusCode!); }); request.end(); });
    expect(meal).toBe(404);
    expect(log.recordEvent.mock.calls).toEqual([["comfort", "dog-music", "manager"], ["comfort", "found:Birdsong (Robin)", "manager"]]);
  });

  it("says why crying cannot be shown yet", async () => {
    const call = await start(fakeLog(minutes(90)), () => now, () => "Crying is not heard yet: the sound model is not set up.");
    expect((await call("/analytics")).body.sound_problem).toContain("sound model");
  });

  it("says when the crying cut-off was tuned, with the dog's own data only", async () => {
    const tuned = { cutoff: 0.08, set_at: "2026-09-27T09:00:00.000Z" };
    const call = await start(fakeLog(minutes(90)), () => now, () => null, () => tuned);
    expect((await call("/analytics")).body.sound_tuning).toBeNull();
    expect((await call("/analytics?view=real")).body.sound_tuning).toEqual(tuned);
  });
});

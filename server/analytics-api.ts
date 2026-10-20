import express, { Router } from "express";
import type { createDogLog, LoggedEvent, Reading, SoundReading } from "./dog-log.js";
import { LogError } from "./dog-log.js";
import { requireLocalManager } from "./manager-api.js";
import { buildAnalytics, watchedHours } from "./pet-analytics.js";
import { sampleWeek } from "./sample-week.js";

export interface AnalyticsOptions {
  log: ReturnType<typeof createDogLog>;
  dogName: string;
  timeZone: string;
  now?: () => number;
  /** Hours of the dog's own watching before PetAnalytics switches from the sample week. */
  neededHours?: number;
  /** Why crying cannot be heard yet, such as a sound model that is not set up, or null when it can. */
  soundProblem?: () => string | null;
  /** The crying cut-off tuned to the dog in Settings, and when, or null while the default is in use. */
  soundTuning?: () => { cutoff: number; set_at: string } | null;
}
const refreshEvery = 10 * 60_000;
const comfortSound = /^(dog-music|dog-noise|found:[\p{L}\p{N} ,.'&()-]{1,80})$/u;

export function createAnalyticsRouter({ log, dogName, timeZone, now = Date.now, neededHours = 8, soundProblem = () => null, soundTuning = () => null }: AnalyticsOptions) {
  const router = Router();
  router.use(requireLocalManager);
  // The last good read of Tinybird. A read is three queries and Tinybird's free plan allows 1,000 a day, so it is refreshed
  // at most every 10 minutes (and after logging a comfort sound), and kept when a later read fails, so a passing outage
  // does not swap the dog's week for the sample.
  let cached: { at: number; data: { readings: Reading[]; sounds: SoundReading[]; events: LoggedEvent[] } } | null = null;

  router.get("/analytics", async (request, response) => {
    let failure: unknown = null;
    if (log.status().ready && (!cached || now() - cached.at > refreshEvery)) {
      try { cached = { at: now(), data: await log.read(7) }; }
      catch (reason) { failure = reason ?? new Error("Tinybird could not be read."); }
    }
    // A read can find the tables missing, so the logging state is taken after it. That is explained once, as the
    // logging problem; a passing failure gets its own notice.
    const status = log.status();
    const readProblem = failure && status.ready ? cached ? "Tinybird could not be read just now, so this shows the last data it sent." : failure instanceof Error ? failure.message : "Tinybird could not be read." : null;
    const real = status.ready && cached ? cached.data : { readings: [] as Reading[], sounds: [] as SoundReading[], events: [] as LoggedEvent[] };
    const hours = watchedHours(real.readings);
    const useReal = request.query.view === "real" || hours >= neededHours;
    const data = useReal ? real : sampleWeek(now());
    response.json(buildAnalytics({ ...data, now: now(), timeZone, dogName, sample: !useReal, realWatchedHours: hours, neededHours, logging: status.ready, loggingProblem: status.problem, readProblem, soundProblem: soundProblem(), soundTuning: useReal ? soundTuning() : null }));
  });

  async function record(response: express.Response, work: () => Promise<unknown>) {
    try {
      const saved = await work();
      if (cached) cached.at = 0;
      return response.json(saved);
    } catch (reason) {
      return response.status(reason instanceof LogError ? reason.status : 502).json({ error: reason instanceof Error ? reason.message : "Saving to Tinybird failed." });
    }
  }
  router.post("/log/comfort", express.json({ limit: "1kb" }), (request, response) => {
    const sound = typeof request.body?.sound === "string" ? request.body.sound.trim() : "";
    if (!comfortSound.test(sound)) return response.status(400).json({ error: "Name the sound that started." });
    return record(response, async () => ({ logged: await log.recordEvent("comfort", sound, "manager") }));
  });
  return router;
}

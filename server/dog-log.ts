import { randomUUID } from "node:crypto";
import type { DogView } from "../shared/diary.js";
import type { TinybirdTarget } from "./dog-diary.js";

// What PetAnalytics reads back: one row per camera reading, one per minute the microphone was heard, and the comfort
// sounds DogMaAI played.
export interface Reading { t: number; visible: string; activity: string; location: string; person: string }
export interface SoundReading { t: number; heard: number; crying: number; barking: number }
export interface LoggedEvent { id: string; t: number; kind: string; detail: string; source: string }
export type EventKind = "comfort";
export interface EventRow { event_id: string; observed_at: string; kind: EventKind; detail: string; source: string }

export class LogError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const yesNo = (value: boolean | "unknown" | undefined) => value === true ? "yes" : value === false ? "no" : "unknown";
const missingTables = "Tinybird does not have the PetAnalytics tables yet, or the token cannot use them. Run npm run tinybird:setup, then restart DogMaAI.";
const missingSounds = "Crying is not saved: Tinybird does not have the dog_sounds table yet, or the token cannot use it. Run npm run tinybird:setup, then restart DogMaAI.";
// A missing table or a token without access does not fix itself.
const lasting = (reason: unknown) => [400, 401, 403, 404].includes((reason as { status?: number }).status ?? 0);

// Sends every camera reading, sound minute and event to Tinybird. Readings and sound minutes are batched every 30 seconds;
// events are confirmed before they count as saved. Keys are used only here, on the server.
export function createDogLog(target: () => TinybirdTarget | null, fetcher: typeof fetch = fetch, now = Date.now) {
  const queues: Record<"dog_readings" | "dog_sounds", object[]> = { dog_readings: [], dog_sounds: [] };
  let problem: string | null = null;
  // The sound table came later than the others, so a workspace set up before it stops only the sound minutes.
  let soundProblem: string | null = null;
  let flushing: Promise<void> = Promise.resolve();
  const timer = setInterval(() => void flush(), 30_000);
  timer.unref();

  const host = (config: TinybirdTarget) => (config.host.includes("://") ? config.host : `https://${config.host}`).replace(/\/$/, "");
  async function send(table: "dog_readings" | "dog_sounds" | "dog_events", rows: object[], wait: boolean) {
    const config = target();
    if (!config) throw new LogError(409, "Tinybird is not set up. Run npm run tinybird:setup, then restart DogMaAI.");
    const response = await fetcher(`${host(config)}/v0/events?name=${table}${wait ? "&wait=true" : ""}`, {
      method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/x-ndjson" },
      body: rows.map(row => JSON.stringify(row)).join("\n") + "\n", redirect: "error", signal: AbortSignal.timeout(15_000)
    });
    // Response bodies are never passed on; they can repeat request details.
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error("Tinybird write failed"), { status: response.status }); }
    const result = await response.json().catch(() => ({})) as { successful_rows?: number; quarantined_rows?: number };
    // An event must be confirmed row by row. A batch of readings counts as delivered once Tinybird accepts it: rows it
    // sets aside in quarantine would fail again, and sending the batch again would repeat the rows it kept.
    if (wait && (Number(result.successful_rows) !== rows.length || Number(result.quarantined_rows ?? 0) > 0)) throw Object.assign(new Error("Tinybird did not confirm the rows"), { status: 0 });
  }
  // Writing to a missing table stops until DogMaAI restarts after setup.
  function note(reason: unknown, table?: "dog_sounds") {
    if (!lasting(reason)) return;
    if (table === "dog_sounds") { soundProblem = missingSounds; queues.dog_sounds = []; }
    else problem = missingTables;
  }

  function recordReading(view: DogView, observedAt: number, camera: string) {
    if (!target() || problem) return;
    queues.dog_readings.push({ observed_at: new Date(observedAt).toISOString(), dog_visible: yesNo(view.dog_visible), activity: view.dog_activity, location: view.dog_location, person_visible: yesNo(view.person_visible), camera });
    if (queues.dog_readings.length >= 20) void flush();
  }
  /** One minute of the camera's microphone: how many seconds were heard, and how many of them were crying or barking. */
  function recordSound(minute: { observed_at: string; camera: string; heard_seconds: number; crying_seconds: number; barking_seconds: number }) {
    if (!target() || problem || soundProblem) return;
    queues.dog_sounds.push(minute);
  }
  function flush() {
    flushing = flushing.then(async () => {
      for (const table of ["dog_readings", "dog_sounds"] as const) {
        const stopped = () => problem !== null || (table === "dog_sounds" && soundProblem !== null);
        if (!queues[table].length || stopped() || !target()) continue;
        const rows = queues[table].splice(0, 200);
        try {
          await send(table, rows, false);
        } catch (reason) {
          note(reason, table === "dog_sounds" ? table : undefined);
          // A passing failure keeps the rows for the next batch, up to about an hour and a half of readings.
          if (!stopped()) queues[table] = [...rows, ...queues[table]].slice(-500);
        }
      }
    });
    return flushing;
  }
  async function recordEvent(kind: EventKind, detail: string, source: string): Promise<EventRow> {
    if (problem) throw new LogError(409, problem);
    const row: EventRow = { event_id: randomUUID(), observed_at: new Date(now()).toISOString(), kind, detail: detail.slice(0, 120), source };
    try {
      await send("dog_events", [row], true);
      return row;
    } catch (reason) {
      if (reason instanceof LogError) throw reason;
      note(reason);
      throw new LogError(problem ? 409 : 502, problem ?? "Tinybird did not confirm the entry. Try again in a moment.");
    }
  }

  async function query(sql: string): Promise<Record<string, unknown>[]> {
    const config = target();
    if (!config) throw new LogError(409, "Tinybird is not set up. Run npm run tinybird:setup, then restart DogMaAI.");
    const response = await fetcher(`${host(config)}/v0/sql?q=${encodeURIComponent(`${sql} FORMAT JSON`)}`, { headers: { Authorization: `Bearer ${config.token}` }, redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error("Tinybird query failed"), { status: response.status }); }
    const data = ((await response.json()) as { data?: unknown }).data;
    return Array.isArray(data) ? data as Record<string, unknown>[] : [];
  }
  // The last few days of readings and events, oldest first. The latest readings are sent first so the page is current.
  async function read(days: number): Promise<{ readings: Reading[]; sounds: SoundReading[]; events: LoggedEvent[] }> {
    await flush();
    const since = `observed_at > now() - INTERVAL ${Math.max(1, Math.min(31, Math.round(days)))} DAY`;
    try {
      const [readings, sounds, events] = await Promise.all([
        query(`SELECT toUnixTimestamp64Milli(observed_at) AS t, dog_visible, activity, location, person_visible FROM dog_readings WHERE ${since} ORDER BY observed_at LIMIT 250000`),
        // Without the sound table, the page still shows everything else, with crying marked as not heard.
        soundProblem ? Promise.resolve([]) : query(`SELECT toUnixTimestamp64Milli(observed_at) AS t, heard_seconds, crying_seconds, barking_seconds FROM dog_sounds WHERE ${since} ORDER BY observed_at LIMIT 20000`)
          .catch(reason => { if (!lasting(reason)) throw reason; note(reason, "dog_sounds"); return []; }),
        query(`SELECT event_id, toUnixTimestamp64Milli(observed_at) AS t, kind, detail, source FROM dog_events WHERE ${since} ORDER BY observed_at LIMIT 20000`)
      ]);
      return {
        readings: readings.map(row => ({ t: Number(row.t), visible: String(row.dog_visible), activity: String(row.activity), location: String(row.location), person: String(row.person_visible) })),
        sounds: sounds.map(row => ({ t: Number(row.t), heard: Number(row.heard_seconds), crying: Number(row.crying_seconds), barking: Number(row.barking_seconds) })),
        events: events.map(row => ({ id: String(row.event_id), t: Number(row.t), kind: String(row.kind), detail: String(row.detail), source: String(row.source) }))
      };
    } catch (reason) {
      note(reason);
      throw reason instanceof LogError ? reason : new LogError(problem ? 409 : 502, problem ?? "Tinybird could not be read. Try again in a moment.");
    }
  }

  function status() {
    if (!target()) return { ready: false, problem: "Tinybird is not set up. Run npm run tinybird:setup, then restart DogMaAI." };
    return { ready: !problem, problem };
  }
  return { recordReading, recordSound, recordEvent, read, flush, status, soundProblem: () => soundProblem, dispose: () => clearInterval(timer) };
}

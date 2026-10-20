import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { DiaryEntry, DiaryListing, DogView } from "../shared/diary.js";
import { requireLocalManager } from "./manager-api.js";

export interface TinybirdTarget { token: string; host: string }
export interface DiaryObservation { description: string; view: DogView; observedAt: number; model: string; camera: DiaryEntry["camera"] }

const table = "dog_diary";
const keep = 50;
const viewKey = (view: DogView) => `${view.dog_visible}|${view.dog_activity}|${view.dog_location}`;
// A reading can confirm a change only if it says the dog is gone, or says both what it is doing and where.
const complete = (view: DogView) => view.dog_visible === false || (view.dog_visible === true && view.dog_activity !== "unknown" && view.dog_location !== "unknown");
const rowSchema = z.object({
  entry_id: z.coerce.string(), observed_at: z.coerce.string(), description: z.coerce.string(), dog_visible: z.coerce.string(),
  activity: z.coerce.string(), location: z.coerce.string(), model: z.coerce.string(), camera: z.coerce.string()
});
export type DiaryRow = z.infer<typeof rowSchema>;
const columns = "entry_id, observed_at, description, dog_visible, activity, location, model, camera";

// Where the diary is kept. write resolves only when the store confirmed every row; failures carry the HTTP status.
export interface DiaryStore {
  readonly kind: "tinybird";
  readonly name: string;
  readonly place: string;
  write(rows: DiaryRow[]): Promise<void>;
  read(limit: number): Promise<DiaryRow[]>;
}
const failure = (store: string, status: number) => Object.assign(new Error(`${store} request failed`), { status });

// Tinybird's Events API appends rows; with wait=true it answers once they are stored, counting any it had to set aside.
// Response bodies are never passed on; they can repeat request details.
export function tinybirdStore(target: TinybirdTarget, fetcher: typeof fetch = fetch): DiaryStore {
  const host = target.host.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${target.token}` };
  return {
    kind: "tinybird", name: "Tinybird", place: `Tinybird · ${table}`,
    async write(rows) {
      const response = await fetcher(`${host}/v0/events?name=${table}&wait=true`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/x-ndjson" },
        body: rows.map(row => JSON.stringify(row)).join("\n") + "\n", redirect: "error", signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) { await response.body?.cancel(); throw failure("Tinybird", response.status); }
      const result = await response.json() as { successful_rows?: number; quarantined_rows?: number };
      if (Number(result.successful_rows) !== rows.length || Number(result.quarantined_rows ?? 0) > 0) throw failure("Tinybird", 0);
    },
    async read(limit) {
      const sql = `SELECT ${columns} FROM ${table} ORDER BY observed_at DESC LIMIT ${limit} FORMAT JSON`;
      const response = await fetcher(`${host}/v0/sql?q=${encodeURIComponent(sql)}`, { headers, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) { await response.body?.cancel(); throw failure("Tinybird", response.status); }
      return z.array(rowSchema).parse(((await response.json()) as { data?: unknown }).data);
    }
  };
}

// Every column is text apart from the time, as in the deployed Tinybird schema.
function toRow(entry: DiaryEntry): DiaryRow {
  return {
    entry_id: entry.entry_id, observed_at: entry.observed_at, description: entry.description,
    dog_visible: entry.dog_visible === true ? "yes" : entry.dog_visible === false ? "no" : "unknown",
    activity: entry.dog_activity, location: entry.dog_location, model: entry.model, camera: entry.camera
  };
}
const oneOf = <T extends string>(options: readonly T[], value: string): T | "unknown" => (options as readonly string[]).includes(value) ? value as T : "unknown";
// Stores can return a saved time as "YYYY-MM-DD HH:MM:SS.sss" in UTC.
function isoTime(value: string) {
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value) ? `${value.replace(" ", "T")}Z` : value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
function fromRow(row: DiaryRow): DiaryEntry {
  return {
    entry_id: row.entry_id, observed_at: isoTime(row.observed_at), description: row.description,
    dog_visible: row.dog_visible === "yes" ? true : row.dog_visible === "no" ? false : "unknown",
    dog_activity: oneOf(["resting", "moving", "playing", "eating"] as const, row.activity),
    dog_location: oneOf(["bed", "floor", "furniture", "door"] as const, row.location),
    model: row.model, camera: row.camera === "phone" ? "phone" : "home", saved: true
  };
}

// Keeps Liquid AI's descriptions of the dog as a diary: a new entry only when what the dog is doing, or where, changes.
export function createDogDiary(storeFor: () => DiaryStore | null, now = Date.now) {
  const recent: DiaryEntry[] = [];
  // Tinybird's free plan allows 1,000 reads a day and this server writes every entry itself, so the saved diary is read
  // once, then kept up to date here from the entries it adds. A failed read is tried again at most once a minute.
  let history: Map<string, DiaryEntry> | null = null;
  let lastRead = -Infinity;
  let recorded: string | null = null;
  let candidate: string | null = null;
  let problem = "";
  let writing: Promise<void> = Promise.resolve();

  // Writes run one at a time. Entries that failed are sent again with the next entry or refresh; reads drop repeated entry IDs.
  function save() {
    writing = writing.then(async () => {
      const store = storeFor();
      const unsaved = recent.filter(entry => !entry.saved).reverse();
      if (!store || !unsaved.length) return;
      try {
        await store.write(unsaved.map(toRow));
        for (const entry of unsaved) entry.saved = true;
        problem = "";
      } catch (reason) {
        const status = (reason as { status?: number }).status;
        problem = status === 401 || status === 403
          ? `${store.name} rejected the key or its permissions, so new entries are kept for this session only.`
          : `${store.name} has not confirmed the latest entries yet. DogMaAI will try again.`;
      }
    });
    return writing;
  }

  function observe(input: DiaryObservation): DiaryEntry | null {
    // Vague or unreadable descriptions neither confirm nor cancel a pending change.
    if (!complete(input.view)) return null;
    const key = viewKey(input.view);
    if (key === recorded) { candidate = null; return null; }
    // As in the monitoring rules, two matching readings confirm a change, so one misread image never becomes an entry.
    if (candidate !== key) { candidate = key; return null; }
    candidate = null;
    recorded = key;
    const entry: DiaryEntry = {
      entry_id: randomUUID(), observed_at: new Date(input.observedAt).toISOString(),
      description: input.description.replace(/\s+/g, " ").trim().slice(0, 300), ...input.view,
      model: input.model.slice(0, 80), camera: input.camera, saved: false
    };
    recent.unshift(entry);
    recent.splice(keep);
    void save();
    return entry;
  }

  async function list(): Promise<DiaryListing> {
    const store = storeFor();
    const session = () => recent.map(entry => ({ ...entry }));
    if (!store) return { entries: session(), storage: "memory", place: null, message: recent.length ? "Kept for this session only. Run npm run tinybird:setup to save the diary." : "No entries yet. Liquid AI adds one when your dog's activity or place changes." };
    // Each refresh also retries entries the store has not confirmed yet.
    if (recent.some(entry => !entry.saved)) void save();
    await writing;
    if (!history && now() - lastRead >= 60_000) {
      lastRead = now();
      try {
        const stored = new Map<string, DiaryEntry>();
        for (const row of await store.read(keep * 2)) if (!stored.has(row.entry_id)) stored.set(row.entry_id, fromRow(row));
        history = stored;
      } catch (reason) {
        // A table that is not deployed yet reads as HTTP 400 or 404.
        const status = (reason as { status?: number }).status;
        if ((status === 400 || status === 404) && !recent.some(entry => entry.saved)) return { entries: session(), storage: store.kind, place: store.place, message: problem || `Nothing saved in ${store.name} yet.` };
        return { entries: session(), storage: "memory", place: store.place, message: `${store.name} could not be read, so this shows only this session's entries.` };
      }
    }
    if (!history) return { entries: session(), storage: "memory", place: store.place, message: `${store.name} could not be read, so this shows only this session's entries.` };
    // This session's entries, saved or still waiting, with the saved diary read at the start.
    const merged = new Map<string, DiaryEntry>(recent.map(entry => [entry.entry_id, { ...entry }]));
    for (const [id, entry] of history) if (!merged.has(id)) merged.set(id, entry);
    const entries = [...merged.values()].sort((left, right) => right.observed_at.localeCompare(left.observed_at)).slice(0, keep);
    // After a restart, the newest saved entry is the state to compare against, so an unchanged dog is not logged again.
    if (recorded === null && candidate === null && entries[0]) recorded = viewKey(entries[0]);
    return { entries, storage: store.kind, place: store.place, message: problem || (entries.length ? `Saved in ${store.place}` : "No entries yet. Liquid AI adds one when your dog's activity or place changes.") };
  }

  const router = Router();
  router.use(requireLocalManager);
  router.get("/", async (_request, response) => { response.json(await list()); });
  return { observe, list, router };
}

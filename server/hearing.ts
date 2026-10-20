import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Router } from "express";
import { hearingActions, markDelaySeconds, markWindow, type CutoffSuggestion, type HearingAction, type HearingView, type HeardSecond } from "../shared/hearing.js";
import { defaultCutoffs, type SoundCutoffs } from "./dog-sounds.js";
import { requireLocalManager } from "./manager-api.js";

// The live "what it hears" check in Settings, and tuning the crying cut-off to the dog's own sounds. The last two minutes
// of scores stay in memory for the live view. Moments marked as crying or quiet keep only their scores, in a file on this
// computer, so the cut-off can be worked out from how this dog really sounds through this camera. Sound is never kept.

type Kind = "crying" | "quiet";
interface MarkedSecond { t: number; crying: number; barking: number }
interface Mark { kind: Kind; at: string; seconds: MarkedSecond[] }
interface Saved { crying_cutoff: number | null; set_at: string | null; marks: Mark[] }
export interface HearingOptions {
  file: string;
  dogName: string;
  now?: () => number;
  /** How long a mark waits for the camera's late sound; tests use 0. */
  markDelay?: number;
  /** Why crying is not being heard or saved, shown on the live view. */
  problem?: () => string | null;
}

const kept = 120;
const shownFor = 30_000;
const maxMarks = 400;
/** A cut-off needs 3 crying moments and 30 quiet seconds. */
export const needed = { moments: 3, quiet: 30 };
/** The tuned crying cut-off stays between these: never less sensitive than the default, and never so low that faint
 *  noise counts. */
export const cutoffRange = { lowest: 0.03, highest: defaultCutoffs.crying };

export class HearingError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const iso = (t: number) => new Date(t).toISOString();

/** The highest cut-off that still catches 4 in 5 of the crying moments marked, so that other sounds count as rarely as
 *  possible, kept within cutoffRange. A moment counts as caught if any of its seconds reaches the cut-off. */
export function suggestCutoff(marks: Mark[]): CutoffSuggestion {
  const moments = marks.filter(mark => mark.kind === "crying").map(mark => mark.seconds.reduce((highest, second) => Math.max(highest, second.crying), 0));
  const quiet = marks.filter(mark => mark.kind === "quiet").flatMap(mark => mark.seconds.map(second => second.crying));
  const needs = { crying_moments: Math.max(0, needed.moments - moments.length), quiet_seconds: Math.max(0, needed.quiet - quiet.length) };
  if (needs.crying_moments || needs.quiet_seconds) return { ready: false, needs, cutoff: null, moments: moments.length, caught: 0, quiet_seconds: quiet.length, false_alarms: 0 };
  const loudestFirst = [...moments].sort((left, right) => right - left);
  const fourInFive = loudestFirst[Math.ceil(moments.length * 0.8) - 1];
  const cutoff = Math.min(cutoffRange.highest, Math.max(cutoffRange.lowest, Math.floor(fourInFive * 100) / 100));
  return {
    ready: true, needs, cutoff, moments: moments.length, caught: moments.filter(value => value >= cutoff).length,
    quiet_seconds: quiet.length, false_alarms: quiet.filter(value => value >= cutoff).length
  };
}

// Only what the file should hold is read back: a cut-off in range, and marks with at least one scored second.
function restore(data: unknown): Saved {
  const value = (data ?? {}) as Partial<Saved>;
  const cutoff = typeof value.crying_cutoff === "number" && value.crying_cutoff >= cutoffRange.lowest && value.crying_cutoff <= cutoffRange.highest ? value.crying_cutoff : null;
  const marks = (Array.isArray(value.marks) ? value.marks : []).flatMap(mark => {
    if ((mark?.kind !== "crying" && mark?.kind !== "quiet") || !Array.isArray(mark.seconds)) return [];
    const seconds = mark.seconds.filter(second => Number.isFinite(second?.t) && Number.isFinite(second?.crying))
      .map(second => ({ t: Number(second.t), crying: Number(second.crying), barking: Number.isFinite(second.barking) ? Number(second.barking) : 0 }));
    return seconds.length ? [{ kind: mark.kind, at: String(mark.at ?? ""), seconds }] : [];
  }).slice(-maxMarks);
  return { crying_cutoff: cutoff, set_at: cutoff === null ? null : String(value.set_at ?? ""), marks };
}

export function createHearingCheck({ file, dogName, now = Date.now, markDelay = markDelaySeconds * 1000, problem = () => null }: HearingOptions) {
  const seconds: HeardSecond[] = [];
  let saved: Saved = { crying_cutoff: null, set_at: null, marks: [] };
  let writing: Promise<void> = Promise.resolve();
  let viewedAt = -Infinity;

  // Read once at start. A missing file starts afresh; a damaged one is set aside rather than overwritten.
  const loaded = (async () => {
    let text: string;
    try { text = await readFile(file, "utf8"); } catch { return; }
    try { saved = restore(JSON.parse(text)); } catch { await rename(file, `${file}.damaged`).catch(() => undefined); }
  })();

  // Written whole to a new file, then swapped in, so a crash never leaves half a file. A failed save is reported.
  function save() {
    const snapshot = JSON.stringify(saved, null, 1);
    const run = writing.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(`${file}.new`, snapshot, { mode: 0o600 });
      await rename(`${file}.new`, file);
    });
    writing = run.catch(() => undefined);
    return run;
  }

  const cutoffs = (): SoundCutoffs => ({ crying: saved.crying_cutoff ?? defaultCutoffs.crying, barking: defaultCutoffs.barking });
  function observe(second: HeardSecond) {
    seconds.push(second);
    if (seconds.length > kept) seconds.splice(0, seconds.length - kept);
  }
  /** Someone has the live view open, so the camera's sound is worth reading even when minutes cannot be saved. */
  const watching = () => now() - viewedAt < 5_000;
  const tuning = () => saved.crying_cutoff === null ? null : { cutoff: saved.crying_cutoff, set_at: saved.set_at ?? "" };

  function view(): HearingView {
    const recent = seconds.filter(second => now() - second.t <= shownFor);
    const last = recent.at(-1);
    return {
      dog_name: dogName,
      listening: last !== undefined && now() - last.t < 5_000,
      problem: problem(),
      seconds: recent.slice(-30),
      cutoffs: cutoffs(),
      default_cutoffs: { ...defaultCutoffs },
      tuned: tuning(),
      marks: {
        crying_moments: saved.marks.filter(mark => mark.kind === "crying").length,
        quiet_seconds: saved.marks.filter(mark => mark.kind === "quiet").reduce((sum, mark) => sum + mark.seconds.length, 0)
      },
      suggestion: suggestCutoff(saved.marks)
    };
  }

  // A second is only ever marked once. Crying outranks quiet: a second marked quiet by mistake moves over, and presses
  // under 5 seconds apart make one crying moment, so a long cry counts once.
  async function mark(kind: Kind) {
    const pressedAt = now();
    if (markDelay > 0) await new Promise(resolve => setTimeout(resolve, markDelay));
    const window = markWindow[kind];
    const around = seconds.filter(second => second.heard && second.t >= pressedAt - window.before * 1000 && second.t <= pressedAt + window.after * 1000)
      .map(second => ({ t: second.t, crying: round(second.crying), barking: round(second.barking) }));
    if (!around.length) throw new HearingError(409, "Nothing was heard around that press. Open the home camera on Overview, and check it is not playing a sound.");
    const markedAs = (which: Kind) => new Set(saved.marks.filter(item => item.kind === which).flatMap(item => item.seconds.map(second => second.t)));
    if (kind === "quiet") {
      const taken = new Set([...markedAs("crying"), ...markedAs("quiet")]);
      const fresh = around.filter(second => !taken.has(second.t));
      if (!fresh.length) throw new HearingError(409, "Those seconds are already marked.");
      saved.marks = [...saved.marks, { kind, at: iso(pressedAt), seconds: fresh }].slice(-maxMarks);
      return;
    }
    const crying = markedAs("crying");
    const fresh = around.filter(second => !crying.has(second.t));
    const moved = new Set(fresh.map(second => second.t));
    let marks = saved.marks.map(item => item.kind === "quiet" ? { ...item, seconds: item.seconds.filter(second => !moved.has(second.t)) } : item).filter(item => item.seconds.length);
    const latest = marks.at(-1);
    if (latest?.kind === "crying" && pressedAt - Date.parse(latest.at) < markWindow.crying.before * 1000) {
      marks = [...marks.slice(0, -1), { kind: "crying", at: iso(pressedAt), seconds: [...latest.seconds, ...fresh].sort((left, right) => left.t - right.t) }];
    } else {
      if (!fresh.length) throw new HearingError(409, "Those seconds are already marked as crying.");
      marks = [...marks, { kind: "crying", at: iso(pressedAt), seconds: fresh }];
    }
    saved.marks = marks.slice(-maxMarks);
  }

  async function act(action: HearingAction) {
    await loaded;
    if (action === "mark-crying" || action === "mark-quiet") {
      await mark(action === "mark-crying" ? "crying" : "quiet");
    } else if (action === "undo") {
      saved.marks = saved.marks.slice(0, -1);
    } else if (action === "clear") {
      saved.marks = [];
    } else if (action === "use-suggested") {
      const suggestion = suggestCutoff(saved.marks);
      if (!suggestion.ready || suggestion.cutoff === null) throw new HearingError(409, "Mark 3 crying moments and 30 quiet seconds first.");
      saved = { ...saved, crying_cutoff: suggestion.cutoff, set_at: iso(now()) };
    } else {
      saved = { ...saved, crying_cutoff: null, set_at: null };
    }
    try { await save(); }
    catch { throw new HearingError(500, "That could not be saved on this computer, so it lasts only until DogMaAI restarts."); }
    return view();
  }

  /** A line for Settings: the crying cut-off in use and where it came from. */
  function describe() {
    return saved.crying_cutoff === null
      ? `Crying cut-off ${defaultCutoffs.crying.toFixed(2)}, the default.`
      : `Crying cut-off ${saved.crying_cutoff.toFixed(2)}, tuned to ${dogName}'s own crying.`;
  }

  const router = Router();
  router.use(requireLocalManager);
  router.get("/", async (_request, response) => {
    await loaded;
    viewedAt = now();
    response.set("Cache-Control", "no-store").json(view());
  });
  router.post("/", async (request, response) => {
    const action = request.body?.action;
    if (!hearingActions.includes(action)) return response.status(400).json({ error: "Unknown action." });
    try {
      response.json(await act(action));
    } catch (reason) {
      if (reason instanceof HearingError) return response.status(reason.status).json({ error: reason.message });
      response.status(500).json({ error: "That did not work. Try again in a moment." });
    }
  });

  return { router, observe, cutoffs, view, act, describe, watching, tuning, loaded, flush: () => writing };
}

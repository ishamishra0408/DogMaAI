import type { HeardSecond, HeardSound, TopLabel } from "../shared/hearing.js";
import type { SoundScores } from "./yamnet.js";

// Listens to the home camera's microphone, about a second at a time, and counts how many seconds of each minute the dog was
// crying (a whimper or a howl) or barking. Only those counts are kept; the audio itself is never stored or sent anywhere.

export interface SoundCutoffs { crying: number; barking: number }
/** YAMNet's scores are not probabilities. These cut-offs are deliberately cautious; the crying one can be tuned to the dog's
 *  own sounds in Settings, from moments marked as crying or quiet. */
export const defaultCutoffs: SoundCutoffs = { crying: 0.2, barking: 0.2 };
export type DogSound = HeardSound;
type Scores = Pick<SoundScores, "whimperDog" | "howl" | "bark" | "yip" | "bowWow"> & Partial<Pick<SoundScores, "humanWhimper">>;
/** How much a second sounds like crying: a dog's whimper or howl, or a whimper, which is how a dog's soft whimper often
 *  scores through the camera's 8 kHz microphone. */
export const cryingScore = (scores: Scores) => Math.max(scores.whimperDog, scores.howl, scores.humanWhimper ?? 0);
export const barkingScore = (scores: Scores) => Math.max(scores.bark, scores.yip, scores.bowWow);
export function dogSound(scores: Scores, cutoffs: SoundCutoffs = defaultCutoffs): DogSound {
  const crying = cryingScore(scores);
  const barking = barkingScore(scores);
  const isCrying = crying >= cutoffs.crying;
  const isBarking = barking >= cutoffs.barking;
  if (isCrying && isBarking) return crying >= barking ? "crying" : "barking";
  return isCrying ? "crying" : isBarking ? "barking" : null;
}

export interface SoundMinute { observed_at: string; camera: string; heard_seconds: number; crying_seconds: number; barking_seconds: number }
export interface SoundListenerOptions {
  classify: (samples: Float32Array) => Promise<SoundScores & { top?: TopLabel[] }>;
  /** One sound row per minute that was listened to. */
  record: (minute: SoundMinute) => void;
  /** True while DogMaAI plays sound through the camera, which mutes the camera's microphone. */
  muted?: () => boolean;
  sampleRate?: number;
  /** Samples the model reads at once; YAMNet reads 0.975 seconds as exactly one window. */
  windowSize?: number;
  camera?: string;
  now?: () => number;
  /** The cut-offs in use, read for every second so a change applies at once. */
  cutoffs?: () => SoundCutoffs;
  /** Each second as it is heard, for the live view in Settings. Only scores, never sound. */
  onSecond?: (second: HeardSecond) => void;
}

const minute = 60_000;
// Samples below this level throughout a second are digital silence, as when the camera mutes its microphone.
const silentLevel = 4;

export function createSoundListener({ classify, record, muted = () => false, sampleRate = 16_000, windowSize = 15_600, camera = "home", now = Date.now, cutoffs = () => defaultCutoffs, onSecond }: SoundListenerOptions) {
  const seconds = windowSize / sampleRate;
  let buffer = new Float32Array(windowSize);
  let filled = 0;
  let loud = false;
  let current: { start: number; heard: number; crying: number; barking: number } | null = null;
  let queue: Promise<void> = Promise.resolve();
  let waiting = 0;

  function tally(at: number, heard: boolean, sound: DogSound) {
    const start = Math.floor(at / minute) * minute;
    if (current && current.start !== start) finishMinute();
    current ??= { start, heard: 0, crying: 0, barking: 0 };
    if (!heard) return;
    current.heard += seconds;
    if (sound === "crying") current.crying += seconds;
    if (sound === "barking") current.barking += seconds;
  }
  function finishMinute() {
    if (current && current.heard > 0) record({ observed_at: new Date(current.start).toISOString(), camera, heard_seconds: Math.round(current.heard), crying_seconds: Math.round(current.crying), barking_seconds: Math.round(current.barking) });
    current = null;
  }

  // The live view is only ever told about a second; a problem there never stops the counting.
  function tell(second: HeardSecond) {
    try { onSecond?.(second); } catch { /* Ignored. */ }
  }
  const unheard = (t: number, reason: NonNullable<HeardSecond["reason"]>): HeardSecond => ({ t, heard: false, reason, sound: null, crying: 0, barking: 0, top: [] });

  // Every second goes through one queue, so minutes are counted in order even while the model is busy.
  function second(samples: Float32Array, audible: boolean, at: number) {
    // While the camera plays DogMaAI's sound its microphone is off, so those seconds count as not heard, not as quiet.
    // If the model ever falls far behind, new seconds are skipped rather than queued.
    // A muted camera sends silence, so muted is checked first.
    const reason = muted() ? "muted" : !audible ? "quiet" : waiting > 5 ? "busy" : null;
    if (reason === null) waiting += 1;
    queue = queue.then(async () => {
      if (reason !== null) { tally(at, false, null); tell(unheard(at, reason)); return; }
      try {
        const scores = await classify(samples);
        const sound = dogSound(scores, cutoffs());
        tally(at, true, sound);
        tell({ t: at, heard: true, reason: null, sound, crying: cryingScore(scores), barking: barkingScore(scores), top: scores.top ?? [] });
      } catch {
        tally(at, false, null);
        tell(unheard(at, "failed"));
      } finally { waiting -= 1; }
    });
  }

  return {
    /** 16-bit samples from the camera, in any chunk size. */
    push(samples: Int16Array) {
      // The chunk ends now, so each second that ends inside it is dated back from its end: two seconds in one chunk never
      // share a time.
      const end = now();
      for (let index = 0; index < samples.length; index++) {
        const value = samples[index];
        if (value > silentLevel || value < -silentLevel) loud = true;
        buffer[filled++] = value / 32_768;
        if (filled === buffer.length) {
          second(buffer, loud, end - ((samples.length - 1 - index) / sampleRate) * 1000);
          buffer = new Float32Array(windowSize);
          filled = 0;
          loud = false;
        }
      }
    },
    /** Waits for the seconds in hand, then saves the minute in progress. */
    async flush() { await queue; finishMinute(); }
  };
}

// Sounds the manager can play on this computer or queue for a paired phone's speaker.
export const comfortActions = ["dog-music", "dog-noise", "stop"] as const;
export type ComfortAction = typeof comfortActions[number];
export const isComfortAction = (value: unknown): value is ComfortAction => comfortActions.includes(value as ComfortAction);
/** How loud the camera speaker plays. Normal is the original level; Loud is about 5 dB louder without clipping. */
export type SpeakerVolume = "soft" | "normal" | "loud";
export const speakerVolumes: readonly SpeakerVolume[] = ["soft", "normal", "loud"];

export const comfortLabels: Record<ComfortAction, string> = {
  "dog-music": "Playing calm music",
  "dog-noise": "Playing brown noise",
  stop: "Sound stopped"
};

export interface CalmNote { frequency: number; beat: number; beats: number; level: number }
// C major pentatonic from G3 to A4: consonant, low-to-middle pitches without shrill tones.
export const calmScale = [196, 220, 261.63, 293.66, 329.63, 392, 440];
// Root and fifth of C, A minor, F and G, held under each phrase.
const calmChords = [[130.81, 196], [110, 164.81], [87.31, 130.81], [98, 146.83]];
export const calmBeatSeconds = 60 / 56;
export const calmPhraseBeats = 8;

/**
 * One phrase of calm music: a held chord and long melody notes that mostly step down, then a short rest.
 * Behaviourists report long, falling tones settle dogs while short, rising ones excite them.
 */
export function calmPhrase(random: () => number, previous = 4): { notes: CalmNote[]; last: number } {
  const chord = calmChords[Math.floor(random() * calmChords.length)];
  const notes: CalmNote[] = chord.map(frequency => ({ frequency, beat: 0, beats: calmPhraseBeats, level: 0.35 }));
  // Phrases restart higher so the falling melody does not settle on its lowest note.
  let degree = previous <= 2 ? previous + 3 : previous;
  let beat = 0;
  while (beat < 6) {
    const beats = beat <= 4 && random() < 0.5 ? 3 : 2;
    notes.push({ frequency: calmScale[degree], beat, beats, level: 0.6 });
    beat += beats;
    degree = Math.max(0, Math.min(calmScale.length - 1, degree + (random() < 0.65 ? -1 : 1)));
  }
  return { notes, last: degree };
}

// The live "what it hears" check in Settings, and tuning the crying cut-off to the dog's own sounds. Only scores travel
// here; the sound itself is never kept or sent anywhere.

export type HeardSound = "crying" | "barking" | null;
export interface TopLabel { label: string; score: number }

/** One second of the home camera's microphone, as the YAMNet sound model heard it. */
export interface HeardSecond {
  t: number;
  heard: boolean;
  /** Why a second was not heard: near silence, the camera's microphone muted while DogMaAI plays a sound, or the model
   *  too busy or failing. */
  reason: "quiet" | "muted" | "busy" | "failed" | null;
  sound: HeardSound;
  /** How much the second sounds like crying: the highest of a dog's whimper, a howl and a whimper. */
  crying: number;
  /** How much it sounds like barking: the highest of a bark, a yip and a bow-wow. */
  barking: number;
  /** The three sounds YAMNet thought most likely. */
  top: TopLabel[];
}

export interface CutoffSuggestion {
  ready: boolean;
  /** What is still to mark before a cut-off can be worked out. */
  needs: { crying_moments: number; quiet_seconds: number };
  cutoff: number | null;
  /** Crying moments marked, and how many of them the cut-off catches. */
  moments: number;
  caught: number;
  /** Quiet seconds marked, and how many of them would count as crying. */
  quiet_seconds: number;
  false_alarms: number;
}

export interface HearingView {
  dog_name: string;
  /** A second came from the camera within the last few seconds. */
  listening: boolean;
  /** Why crying is not being heard or saved, such as a sound model or Tinybird table that is not set up. */
  problem: string | null;
  /** The seconds heard in the last 30, oldest first. */
  seconds: HeardSecond[];
  cutoffs: { crying: number; barking: number };
  default_cutoffs: { crying: number; barking: number };
  /** The crying cut-off worked out from this dog's marks, when one is in use. */
  tuned: { cutoff: number; set_at: string } | null;
  marks: { crying_moments: number; quiet_seconds: number };
  suggestion: CutoffSuggestion;
}

export const hearingActions = ["mark-crying", "mark-quiet", "undo", "clear", "use-suggested", "use-default"] as const;
export type HearingAction = typeof hearingActions[number];
/** The camera's sound reaches DogMaAI a moment late, so a mark is taken a few seconds after the press. A crying mark keeps
 *  the seconds from 5 before the press to 3 after it; a quiet mark keeps the 10 before it. */
export const markDelaySeconds = 3;
export const markWindow = { crying: { before: 5, after: 3 }, quiet: { before: 10, after: 1 } } as const;

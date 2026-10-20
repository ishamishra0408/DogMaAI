// PetAnalytics: seven days of what the camera saw, turned into answers for the dog's owner.

export type ActivityKey = "resting" | "moving" | "playing" | "eating";
export type SpotKey = "bed" | "floor" | "furniture" | "door";
export interface Source { name: string; url: string }

export interface HourStat {
  hour: number;
  watched_minutes: number;
  /** Share of the hour's watched time spent moving or playing; null when the hour was watched for less than 20 minutes. */
  active_share: number | null;
}
export interface DayStat {
  date: string;
  label: string;
  watched_minutes: number;
  active_minutes: number;
  naps: number;
  longest_nap_minutes: number;
}
export interface Nap { date: string; start_minute: number; minutes: number }
export interface SpotStat { spot: SpotKey; share: number; minutes: number }
export interface AloneHour { hour: number; minutes: number; restless_share: number | null }
export interface AloneStat {
  watched_minutes: number;
  restless_share: number | null;
  door_share: number | null;
  resting_share: number | null;
  calmest_hour: number | null;
  most_unsettled_hour: number | null;
  by_hour: AloneHour[];
}
export interface ComfortStat { sound: string; plays: number; active_before: number; active_after: number }

/** How the dog seemed during a stretch alone, read from what the camera saw and heard. Not a diagnosis. */
export type Mood = "calm" | "unsettled" | "upset";
export interface AloneEpisode {
  date: string;
  start_minute: number;
  minutes: number;
  /** Minutes until the first rest of 10 minutes or more while alone; null if the dog was not seen to settle. */
  settle_minutes: number | null;
  restless_share: number | null;
  door_share: number | null;
  /** Minutes the camera's microphone was heard, which leaves out time DogMaAI played sound through the camera. */
  heard_minutes: number;
  /** Null when nothing was heard. */
  crying_minutes: number | null;
  /** A comfort sound started during the stretch, or up to five minutes before it. */
  music: boolean;
  /** The dog was in view for half the stretch or more, so its behaviour could be read. */
  seen_enough: boolean;
  /** Null when the dog was not seen enough and was not heard crying for 5 minutes or more. */
  mood: Mood | null;
}
export interface Feelings {
  episodes: AloneEpisode[];
  counts: Record<Mood, number>;
  /** The mood that covered the most time alone. */
  mostly: Mood | null;
  typical_settle_minutes: number | null;
  alone_minutes: number;
}
export interface CryingDay { date: string; label: string; crying_minutes: number | null; heard_minutes: number }
export interface CryingStat {
  /** True once the microphone has been heard this week. */
  listening: boolean;
  heard_minutes: number;
  crying_minutes: number;
  alone_crying_minutes: number;
  barking_minutes: number;
  /** The longest run of minutes with crying in each. */
  longest_minutes: number;
  /** Crying while alone, per day. */
  by_day: CryingDay[];
  by_hour: { hour: number; crying_minutes: number; heard_minutes: number }[];
}
export interface MusicGroup { episodes: number; settle_minutes: number | null; crying_per_hour: number | null; upset: number }
export interface MusicStat { plays: number; with_music: MusicGroup; without_music: MusicGroup; verdict: "helped" | "no_difference" | "worse" | "not_enough" }
export interface Tip { id: string; title: string; why: string; source: Source }
/** `because` is null when an earlier idea already gave the same reason. */
export interface Idea { id: string; title: string; how: string; because: string | null; source: Source }

export interface PetAnalytics {
  dog_name: string;
  /** True while the page shows the labelled sample week instead of the dog's own data. */
  sample: boolean;
  real_watched_hours: number;
  needed_hours: number;
  /** False when Tinybird is not set up or its PetAnalytics tables are missing. */
  logging: boolean;
  logging_problem: string | null;
  /** Set when Tinybird could not be read just now; the page then shows the last data it read. */
  read_problem: string | null;
  time_zone: string;
  days: string[];
  watched_minutes: number;
  activity: {
    shares: Record<ActivityKey, number>;
    active_share: number | null;
    by_hour: HourStat[];
    by_day: DayStat[];
    most_active_hour: number | null;
  };
  naps: { list: Nap[]; per_day: number | null; longest_minutes: number; usual_hours: number[] };
  spots: SpotStat[];
  alone: AloneStat;
  feelings: Feelings;
  crying: CryingStat;
  music: MusicStat;
  comfort: ComfortStat[];
  /** Why crying cannot be shown yet, such as a sound model that is not set up. */
  sound_problem: string | null;
  /** The crying cut-off tuned to the dog in Settings, and when; minutes before then were counted with the default. */
  sound_tuning: { cutoff: number; set_at: string } | null;
  tips: Tip[];
  ideas: Idea[];
}

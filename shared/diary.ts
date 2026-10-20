import type { DogActivity, DogLocation, KnownOrUnknown } from "./domain.js";

// The camera readings add eating, which PetAnalytics counts as activity; the monitoring rules keep their three activities.
export type ViewActivity = DogActivity | "eating";

// What a Liquid AI description says about the dog, so the diary can tell a real change from new wording.
export interface DogView {
  dog_visible: KnownOrUnknown<boolean>;
  dog_activity: KnownOrUnknown<ViewActivity>;
  dog_location: KnownOrUnknown<DogLocation>;
  /** Whether a person, or part of one such as a hand, is in view; PetAnalytics uses it for time alone. */
  person_visible?: KnownOrUnknown<boolean>;
}

export interface DiaryEntry extends DogView {
  entry_id: string;
  /** ISO 8601 time of the camera image. */
  observed_at: string;
  description: string;
  model: string;
  camera: "home" | "phone";
  /** True once Tinybird confirmed the write. */
  saved: boolean;
}

export interface DiaryListing {
  entries: DiaryEntry[];
  storage: "tinybird" | "memory";
  /** Where entries are saved, such as "Tinybird · dog_diary". */
  place: string | null;
  message: string;
}

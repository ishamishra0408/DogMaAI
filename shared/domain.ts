export type KnownOrUnknown<T> = T | "unknown";

export type DogActivity = "resting" | "moving" | "playing";
export type DogLocation = "bed" | "floor" | "furniture" | "door";
export type CameraView = "usable" | "occluded" | "unusable" | "unknown";

export interface CandidateObservation {
  frame_id: string;
  observed_at_seconds: number;
  camera_view: CameraView;
  dog_visible: KnownOrUnknown<boolean>;
  dog_activity: KnownOrUnknown<DogActivity>;
  dog_location: KnownOrUnknown<DogLocation>;
  person_visible: KnownOrUnknown<boolean>;
  chewing_items: KnownOrUnknown<boolean>;
  uncertainties: string[];
  short_description: string;
}

export interface RoomState {
  dog_visible: KnownOrUnknown<boolean>;
  dog_activity: KnownOrUnknown<DogActivity>;
  dog_location: KnownOrUnknown<DogLocation>;
  person_visible: KnownOrUnknown<boolean>;
  chewing_items: KnownOrUnknown<boolean>;
  camera_view: CameraView;
  observed_at_seconds: number | null;
  stale: boolean;
  uncertainties: string[];
}

export type SituationType =
  | "restless_alone"
  | "waiting_at_door"
  | "chewing_items";

export type SituationStatus =
  | "pending"
  | "active"
  | "alerted"
  | "uncertain"
  | "resolved";

export interface Situation {
  id: string;
  type: SituationType;
  status: SituationStatus;
  started_at: number;
  updated_at: number;
  alerted_at: number | null;
  resolved_at: number | null;
  latest_evidence_frame_id: string;
  recurrence_of: string | null;
  person_returned: boolean;
  evidence_frame_ids: string[];
  alert_timer_paused_seconds: number;
  uncertainty_started_at: number | null;
}

export type StateMutation =
  | { type: "ROOM_STATE_CHANGED"; patch: Partial<RoomState>; evidenceFrameIds: string[] }
  | { type: "SITUATION_OPENED"; situation: Situation; evidenceFrameIds: string[] }
  | { type: "SITUATION_UPDATED"; situationId: string; patch: Partial<Situation>; evidenceFrameIds: string[] }
  | { type: "SITUATION_RESOLVED"; situationId: string; reason: string; evidenceFrameIds: string[] }
  | { type: "ALERT_EMITTED"; situationId: string }
  | { type: "MONITORING_UNCERTAIN"; reason: string; evidenceFrameIds: string[] };

export interface ProcessingMetrics {
  frames_sampled: number;
  observations_produced: number;
  mutations_accepted: number;
  repeated_observations_discarded: number;
  invalid_observations_rejected: number;
  working_state_bytes: number;
}

export interface SessionState {
  session_id: string;
  state_version: number;
  room: RoomState;
  situations: Situation[];
  metrics: ProcessingMetrics;
}

export const initialRoomState: RoomState = {
  dog_visible: "unknown",
  dog_activity: "unknown",
  dog_location: "unknown",
  person_visible: "unknown",
  chewing_items: "unknown",
  camera_view: "unknown",
  observed_at_seconds: null,
  stale: true,
  uncertainties: ["Waiting for the first usable observation"]
};

export const situationLabels: Record<SituationType, string> = {
  restless_alone: "Restless while alone",
  waiting_at_door: "Waiting at the door",
  chewing_items: "Chewing household items"
};

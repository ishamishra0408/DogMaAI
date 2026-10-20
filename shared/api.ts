import type { CandidateObservation, SessionState, StateMutation } from "./domain.js";

export type PlaybackStatus = "idle" | "playing" | "paused" | "complete";

export interface TimelineEvent {
  id: string;
  video_timestamp: number;
  frame_id: string | null;
  mutation: StateMutation;
}

export interface ResearchSource {
  title: string;
  url: string;
  snippet: string;
}

export interface OwnerNotification {
  id: string;
  situation_id: string;
  created_at_video_seconds: number;
  status: "researching" | "sent" | "failed";
  channel: "in_app_demo";
  research_provider: "nimble_live" | "demo_fallback";
  subject: string;
  message: string;
  research_summary: string | null;
  sources: ResearchSource[];
}

export interface RuntimeSnapshot {
  state: SessionState & { last_video_timestamp: number | null };
  playback: {
    status: PlaybackStatus;
    current_time: number;
    speed: number;
    duration: number;
    sample_interval: number;
    provider: string;
    manual_occlusion: boolean;
  };
  latest_observation: CandidateObservation | null;
  latest_mutations: StateMutation[];
  owner_notifications: OwnerNotification[];
}

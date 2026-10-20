import {
  initialRoomState,
  type CandidateObservation,
  type ProcessingMetrics,
  type RoomState,
  type SessionState,
  type Situation,
  type SituationStatus,
  type SituationType,
  type StateMutation
} from "../shared/domain.js";
import { validateObservation } from "../shared/observation-schema.js";

export interface EngineConfig {
  confirmationCount: number;
  alertAfterSeconds: number;
}

interface ProvisionalObservation {
  signature: string;
  count: number;
  observations: CandidateObservation[];
}

export interface MonitoringEngineState extends SessionState {
  provisional: ProvisionalObservation | null;
  last_video_timestamp: number | null;
  next_situation_sequence: number;
}

export interface ProcessResult {
  state: MonitoringEngineState;
  mutations: StateMutation[];
  validationErrors: string[];
}

export const defaultEngineConfig: EngineConfig = {
  confirmationCount: 2,
  alertAfterSeconds: 10
};

const emptyMetrics = (): ProcessingMetrics => ({
  frames_sampled: 0,
  observations_produced: 0,
  mutations_accepted: 0,
  repeated_observations_discarded: 0,
  invalid_observations_rejected: 0,
  working_state_bytes: 0
});

export function createMonitoringState(sessionId: string): MonitoringEngineState {
  const state: MonitoringEngineState = {
    session_id: sessionId,
    state_version: 0,
    room: structuredClone(initialRoomState),
    situations: [],
    metrics: emptyMetrics(),
    provisional: null,
    last_video_timestamp: null,
    next_situation_sequence: 1
  };
  return withWorkingStateBytes(state);
}

function observableSignature(observation: CandidateObservation): string {
  return JSON.stringify({
    dog_visible: observation.dog_visible,
    dog_activity: observation.dog_activity,
    dog_location: observation.dog_location,
    person_visible: observation.person_visible,
    chewing_items: observation.chewing_items
  });
}

function roomSignature(room: RoomState): string {
  return JSON.stringify({
    dog_visible: room.dog_visible,
    dog_activity: room.dog_activity,
    dog_location: room.dog_location,
    person_visible: room.person_visible,
    chewing_items: room.chewing_items
  });
}

function publicWorkingState(state: MonitoringEngineState) {
  return {
    session_id: state.session_id,
    state_version: state.state_version,
    room: state.room,
    situations: state.situations.filter((situation) => situation.status !== "resolved")
  };
}

export function withWorkingStateBytes(state: MonitoringEngineState): MonitoringEngineState {
  return {
    ...state,
    metrics: {
      ...state.metrics,
      working_state_bytes: Buffer.byteLength(JSON.stringify(publicWorkingState(state)), "utf8")
    }
  };
}

function appendEvidence(situation: Situation, frameId: string): string[] {
  return situation.evidence_frame_ids.includes(frameId)
    ? situation.evidence_frame_ids
    : [...situation.evidence_frame_ids, frameId];
}

function activeSituation(state: MonitoringEngineState, type: SituationType): Situation | undefined {
  return state.situations.find((situation) => situation.type === type && situation.status !== "resolved");
}

// "Alone" needs a confirmed absence of people; an unknown person count never opens a situation.
function situationCondition(type: SituationType, room: RoomState): boolean {
  if (type === "restless_alone") return room.dog_activity === "moving" && room.person_visible === false;
  if (type === "waiting_at_door") return room.dog_location === "door" && room.person_visible === false;
  return room.chewing_items === true;
}

function situationResolved(type: SituationType, room: RoomState): boolean {
  if (type === "restless_alone") return room.dog_activity === "resting" || room.person_visible === true;
  if (type === "waiting_at_door") return (room.dog_location !== "door" && room.dog_location !== "unknown") || room.person_visible === true;
  return room.chewing_items === false;
}

function createSituation(
  state: MonitoringEngineState,
  type: SituationType,
  observation: CandidateObservation
): Situation {
  const previous = [...state.situations].reverse().find((situation) => situation.type === type && situation.status === "resolved");
  return {
    id: `situation_${state.next_situation_sequence}`,
    type,
    status: "active",
    started_at: observation.observed_at_seconds,
    updated_at: observation.observed_at_seconds,
    alerted_at: null,
    resolved_at: null,
    latest_evidence_frame_id: observation.frame_id,
    recurrence_of: previous?.id ?? null,
    person_returned: observation.person_visible === true,
    evidence_frame_ids: [observation.frame_id],
    alert_timer_paused_seconds: 0,
    uncertainty_started_at: null
  };
}

function reconcileSituations(
  state: MonitoringEngineState,
  observation: CandidateObservation,
  config: EngineConfig,
  mutations: StateMutation[]
): MonitoringEngineState {
  let next = state;
  const situationTypes: SituationType[] = [
    "restless_alone",
    "waiting_at_door",
    "chewing_items"
  ];

  for (const type of situationTypes) {
    const existing = activeSituation(next, type);
    if (!existing && situationCondition(type, next.room)) {
      const situation = createSituation(next, type, observation);
      next = {
        ...next,
        next_situation_sequence: next.next_situation_sequence + 1,
        situations: [...next.situations, situation]
      };
      mutations.push({ type: "SITUATION_OPENED", situation, evidenceFrameIds: [observation.frame_id] });
      continue;
    }

    if (!existing) continue;

    if (situationResolved(type, next.room)) {
      const resolved: Situation = {
        ...existing,
        status: "resolved",
        updated_at: observation.observed_at_seconds,
        resolved_at: observation.observed_at_seconds,
        latest_evidence_frame_id: observation.frame_id,
        evidence_frame_ids: appendEvidence(existing, observation.frame_id),
        uncertainty_started_at: null
      };
      next = { ...next, situations: next.situations.map((item) => item.id === existing.id ? resolved : item) };
      mutations.push({
        type: "SITUATION_RESOLVED",
        situationId: existing.id,
        reason: "Confirmed condition cleared",
        evidenceFrameIds: [observation.frame_id]
      });
      continue;
    }

    if (!situationCondition(type, next.room)) continue;

    const resumedFromUncertainty = existing.status === "uncertain";
    const pauseAdded = resumedFromUncertainty && existing.uncertainty_started_at !== null
      ? observation.observed_at_seconds - existing.uncertainty_started_at
      : 0;
    const pausedSeconds = existing.alert_timer_paused_seconds + Math.max(0, pauseAdded);
    const activeDuration = observation.observed_at_seconds - existing.started_at - pausedSeconds;
    const shouldAlert = existing.alerted_at === null && activeDuration >= config.alertAfterSeconds;
    const personReturned = existing.person_returned || observation.person_visible === true;
    const meaningfulUpdate = resumedFromUncertainty || personReturned !== existing.person_returned;

    let updated = existing;
    if (meaningfulUpdate || shouldAlert) {
      const status: SituationStatus = shouldAlert || existing.alerted_at !== null ? "alerted" : "active";
      updated = {
        ...existing,
        status,
        updated_at: observation.observed_at_seconds,
        alerted_at: shouldAlert ? observation.observed_at_seconds : existing.alerted_at,
        latest_evidence_frame_id: observation.frame_id,
        evidence_frame_ids: appendEvidence(existing, observation.frame_id),
        person_returned: personReturned,
        alert_timer_paused_seconds: pausedSeconds,
        uncertainty_started_at: null
      };
      next = { ...next, situations: next.situations.map((item) => item.id === existing.id ? updated : item) };
      mutations.push({
        type: "SITUATION_UPDATED",
        situationId: existing.id,
        patch: updated,
        evidenceFrameIds: [observation.frame_id]
      });
    }
    if (shouldAlert) mutations.push({ type: "ALERT_EMITTED", situationId: existing.id });
  }

  return next;
}

function enterUncertainty(
  state: MonitoringEngineState,
  observation: CandidateObservation,
  mutations: StateMutation[]
): MonitoringEngineState {
  if (state.room.camera_view === observation.camera_view && state.room.stale) return state;

  const reason = observation.camera_view === "occluded" ? "Camera view is occluded" : "Camera view is unusable";
  const room: RoomState = {
    ...state.room,
    camera_view: observation.camera_view,
    observed_at_seconds: observation.observed_at_seconds,
    stale: true,
    uncertainties: [...new Set([...observation.uncertainties, reason])]
  };
  const situations = state.situations.map((situation) => {
    if (situation.status === "resolved" || situation.status === "uncertain") return situation;
    const updated: Situation = {
      ...situation,
      status: "uncertain",
      updated_at: observation.observed_at_seconds,
      uncertainty_started_at: observation.observed_at_seconds,
      latest_evidence_frame_id: observation.frame_id,
      evidence_frame_ids: appendEvidence(situation, observation.frame_id)
    };
    mutations.push({ type: "SITUATION_UPDATED", situationId: situation.id, patch: updated, evidenceFrameIds: [observation.frame_id] });
    return updated;
  });
  mutations.unshift({ type: "MONITORING_UNCERTAIN", reason, evidenceFrameIds: [observation.frame_id] });
  return { ...state, room, situations, provisional: null };
}

export function processObservation(
  currentState: MonitoringEngineState,
  input: unknown,
  config: EngineConfig = defaultEngineConfig
): ProcessResult {
  const validation = validateObservation(input);
  if (!validation.success) {
    const state = withWorkingStateBytes({
      ...currentState,
      metrics: {
        ...currentState.metrics,
        invalid_observations_rejected: currentState.metrics.invalid_observations_rejected + 1
      }
    });
    return { state, mutations: [], validationErrors: validation.errors };
  }

  const observation = validation.data;
  let state: MonitoringEngineState = {
    ...currentState,
    last_video_timestamp: observation.observed_at_seconds,
    metrics: {
      ...currentState.metrics,
      frames_sampled: currentState.metrics.frames_sampled + 1,
      observations_produced: currentState.metrics.observations_produced + 1
    }
  };
  const mutations: StateMutation[] = [];

  if (observation.camera_view !== "usable") {
    state = enterUncertainty(state, observation, mutations);
  } else {
    const signature = observableSignature(observation);
    if (signature === roomSignature(state.room) && state.room.camera_view === "usable") {
      state = {
        ...state,
        room: { ...state.room, observed_at_seconds: observation.observed_at_seconds, stale: false },
        provisional: null
      };
      state = reconcileSituations(state, observation, config, mutations);
    } else {
      const provisional = state.provisional?.signature === signature
        ? { signature, count: state.provisional.count + 1, observations: [...state.provisional.observations, observation] }
        : { signature, count: 1, observations: [observation] };
      state = { ...state, provisional };

      if (provisional.count >= config.confirmationCount) {
        const patch: Partial<RoomState> = {
          dog_visible: observation.dog_visible,
          dog_activity: observation.dog_activity,
          dog_location: observation.dog_location,
          person_visible: observation.person_visible,
          chewing_items: observation.chewing_items,
          camera_view: "usable",
          observed_at_seconds: observation.observed_at_seconds,
          stale: false,
          uncertainties: observation.uncertainties
        };
        const evidenceFrameIds = provisional.observations.map((item) => item.frame_id);
        state = { ...state, room: { ...state.room, ...patch }, provisional: null };
        mutations.push({ type: "ROOM_STATE_CHANGED", patch, evidenceFrameIds });
        state = reconcileSituations(state, observation, config, mutations);
      }
    }
  }

  if (mutations.length === 0) {
    state = {
      ...state,
      metrics: {
        ...state.metrics,
        repeated_observations_discarded: state.metrics.repeated_observations_discarded + 1
      }
    };
  } else {
    state = {
      ...state,
      state_version: state.state_version + mutations.length,
      metrics: {
        ...state.metrics,
        mutations_accepted: state.metrics.mutations_accepted + mutations.length
      }
    };
  }

  return { state: withWorkingStateBytes(state), mutations, validationErrors: [] };
}

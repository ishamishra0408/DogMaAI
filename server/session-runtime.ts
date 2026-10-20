import { EventEmitter } from "node:events";
import { situationLabels, type CandidateObservation, type Situation, type StateMutation } from "../shared/domain.js";
import type { OwnerNotification, PlaybackStatus, RuntimeSnapshot, TimelineEvent } from "../shared/api.js";
import {
  createMonitoringState,
  processObservation,
  withWorkingStateBytes,
  type MonitoringEngineState
} from "./monitoring-engine.js";
import type { FrameSample, VisualObservationProvider } from "./providers/visual-observation-provider.js";
import type { AlertEnricher } from "./alert-enrichment.js";
import { buildTelemetryEvents, type TelemetrySink } from "./tinybird-telemetry.js";

export interface StoredRuntime {
  state: MonitoringEngineState;
  events: TimelineEvent[];
  currentTime: number;
}

export interface RuntimePersistence {
  createSession(sessionId: string, provider: string): void;
  recordSample(
    sessionId: string,
    provider: string,
    observation: CandidateObservation,
    mutations: StateMutation[],
    state: MonitoringEngineState,
    events: TimelineEvent[]
  ): void;
  recordRestart(
    sessionId: string,
    mutations: StateMutation[],
    state: MonitoringEngineState,
    events: TimelineEvent[]
  ): void;
  loadSession(sessionId: string): StoredRuntime | null;
  clearSessionData(sessionId: string): void;
}

export class SessionRuntime extends EventEmitter {
  private state: MonitoringEngineState;
  private events: TimelineEvent[] = [];
  private latestObservation: CandidateObservation | null = null;
  private latestMutations: StateMutation[] = [];
  private status: PlaybackStatus = "idle";
  private currentTime = 0;
  private speed = 1;
  private timer: NodeJS.Timeout | null = null;
  private playStartedAtMs = 0;
  private playStartedAtVideoTime = 0;
  private processing = false;
  private pendingTimestamp: number | null = null;
  private manualOcclusion = false;
  private ownerNotifications: OwnerNotification[] = [];
  private notificationGeneration = 0;

  constructor(
    readonly id: string,
    private readonly provider: VisualObservationProvider,
    readonly sampleInterval = 2,
    // Length of the bundled cage clip, which the sample observations describe.
    readonly duration = 32,
    private readonly persistence?: RuntimePersistence,
    private readonly alertEnricher?: AlertEnricher,
    private readonly telemetrySink?: TelemetrySink
  ) {
    super();
    this.state = createMonitoringState(id);
    this.persistence?.createSession(id, provider.name);
  }

  snapshot(): RuntimeSnapshot {
    return {
      state: this.state,
      playback: {
        status: this.status,
        current_time: this.currentTime,
        speed: this.speed,
        duration: this.duration,
        sample_interval: this.sampleInterval,
        provider: this.provider.name,
        manual_occlusion: this.manualOcclusion
      },
      latest_observation: this.latestObservation,
      latest_mutations: this.latestMutations,
      owner_notifications: this.ownerNotifications
    };
  }

  getEvents(after = 0): TimelineEvent[] {
    return this.events.filter((event) => event.video_timestamp >= after);
  }

  async processAt(videoTimestamp: number): Promise<void> {
    const timestamp = Math.max(0, Math.min(this.duration, videoTimestamp));
    if (this.processing) {
      this.pendingTimestamp = timestamp;
      return;
    }

    this.processing = true;
    const processingStartedAt = Date.now();
    try {
      const frame = this.frameAt(timestamp);
      const observation = await this.provider.observe(frame);
      const result = processObservation(this.state, observation);
      this.state = result.state;
      this.latestObservation = observation;
      this.latestMutations = result.mutations;
      this.currentTime = timestamp;
      for (const mutation of result.mutations) {
        this.events.push({
          id: `event_${this.events.length + 1}`,
          video_timestamp: timestamp,
          frame_id: mutation.type === "ALERT_EMITTED" ? null : observation.frame_id,
          mutation
        });
      }
      this.persistence?.recordSample(this.id, this.provider.name, observation, result.mutations, this.state, this.events);
      if (this.telemetrySink) {
        const telemetryEvents = buildTelemetryEvents({
          sessionId: this.id,
          provider: this.provider.name,
          observation,
          mutations: result.mutations,
          state: this.state,
          processingLatencyMs: Date.now() - processingStartedAt
        });
        void this.telemetrySink.send(telemetryEvents)
          .then(() => this.emit("update", this.snapshot()))
          .catch((error: unknown) => {
            console.warn("Tinybird telemetry delivery failed:", error instanceof Error ? error.message : "unknown error");
            this.emit("update", this.snapshot());
          });
      }
      for (const mutation of result.mutations) {
        if (mutation.type === "ALERT_EMITTED") this.beginOwnerNotification(mutation.situationId, timestamp);
      }
      this.emit("update", this.snapshot());
    } finally {
      this.processing = false;
      if (this.pendingTimestamp !== null) {
        const pending = this.pendingTimestamp;
        this.pendingTimestamp = null;
        if (pending !== timestamp) await this.processAt(pending);
      }
    }
  }

  async processUntil(videoTimestamp: number): Promise<void> {
    const target = Math.max(0, Math.min(this.duration, videoTimestamp));
    const start = this.state.last_video_timestamp === null
      ? 0
      : Math.floor(this.state.last_video_timestamp / this.sampleInterval) * this.sampleInterval + this.sampleInterval;
    for (let timestamp = start; timestamp <= target; timestamp += this.sampleInterval) {
      await this.processAt(timestamp);
    }
    this.currentTime = target;
  }

  start(speed = this.speed): void {
    if (![1, 2, 4].includes(speed)) throw new Error("Playback speed must be 1, 2, or 4");
    this.stopTimer();
    this.speed = speed;
    this.status = "playing";
    this.playStartedAtMs = Date.now();
    this.playStartedAtVideoTime = this.currentTime;
    this.timer = setInterval(() => void this.tick(), 200);
    void this.tick();
    this.emit("update", this.snapshot());
  }

  pause(): void {
    if (this.status === "playing") this.syncCurrentTime();
    this.stopTimer();
    this.status = "paused";
    this.emit("update", this.snapshot());
  }

  reset(): void {
    this.stopTimer();
    this.resetState();
    this.emit("update", this.snapshot());
  }

  setTemporaryOcclusion(enabled: boolean): void {
    if (!this.provider.setTemporaryOcclusion) throw new Error("The active provider does not support demo occlusion");
    this.provider.setTemporaryOcclusion(enabled);
    this.manualOcclusion = enabled;
    this.emit("update", this.snapshot());
  }

  simulateRestart(): void {
    this.stopTimer();
    this.manualOcclusion = false;
    this.provider.setTemporaryOcclusion?.(false);
    const restored = this.persistence?.loadSession(this.id);
    if (!restored) throw new Error("No durable state is available for this session");

    const timestamp = restored.currentTime;
    const reason = "Process restarted; waiting for fresh confirmed observations";
    const situationMutations: StateMutation[] = [];
    const situations = restored.state.situations.map((situation) => {
      if (situation.status === "resolved" || situation.status === "uncertain") return situation;
      const updated: Situation = {
        ...situation,
        status: "uncertain",
        updated_at: timestamp,
        uncertainty_started_at: timestamp
      };
      situationMutations.push({
        type: "SITUATION_UPDATED",
        situationId: situation.id,
        patch: updated,
        evidenceFrameIds: []
      });
      return updated;
    });
    const mutations: StateMutation[] = [
      { type: "MONITORING_UNCERTAIN", reason, evidenceFrameIds: [] },
      ...situationMutations
    ];
    this.state = withWorkingStateBytes({
      ...restored.state,
      state_version: restored.state.state_version + mutations.length,
      room: {
        ...restored.state.room,
        camera_view: "unknown",
        stale: true,
        uncertainties: [reason]
      },
      situations,
      provisional: null,
      metrics: {
        ...restored.state.metrics,
        mutations_accepted: restored.state.metrics.mutations_accepted + mutations.length
      }
    });
    this.events = [...restored.events];
    this.latestObservation = null;
    this.latestMutations = mutations;
    this.currentTime = timestamp;
    this.status = "paused";
    const restartEvents = mutations.map((mutation, index): TimelineEvent => ({
      id: `event_${this.events.length + index + 1}`,
      video_timestamp: timestamp,
      frame_id: null,
      mutation
    }));
    this.events.push(...restartEvents);
    this.persistence?.recordRestart(this.id, mutations, this.state, restartEvents);
    this.emit("update", this.snapshot());
  }

  dispose(): void {
    this.stopTimer();
    this.removeAllListeners();
  }

  private resetState(): void {
    this.persistence?.clearSessionData(this.id);
    this.state = createMonitoringState(this.id);
    this.events = [];
    this.latestObservation = null;
    this.latestMutations = [];
    this.ownerNotifications = [];
    this.notificationGeneration += 1;
    this.status = "idle";
    this.currentTime = 0;
    this.pendingTimestamp = null;
    this.manualOcclusion = false;
    this.provider.setTemporaryOcclusion?.(false);
  }

  private frameAt(timestamp: number): FrameSample {
    const index = Math.round(timestamp / this.sampleInterval);
    return {
      frameId: `frame_${String(index).padStart(5, "0")}`,
      videoTimestamp: timestamp,
      evidenceThumbnailUrl: `/demo.mp4#t=${timestamp}`
    };
  }

  private beginOwnerNotification(situationId: string, videoTimestamp: number): void {
    if (!this.alertEnricher || this.ownerNotifications.some((item) => item.situation_id === situationId)) return;
    const situation = this.state.situations.find((item) => item.id === situationId);
    if (!situation) return;
    const generation = this.notificationGeneration;
    const pending: OwnerNotification = {
      id: `notification_${this.ownerNotifications.length + 1}`,
      situation_id: situationId,
      created_at_video_seconds: videoTimestamp,
      status: "researching",
      channel: "in_app_demo",
      research_provider: this.alertEnricher.mode,
      subject: "DogMaAI: check on your dog",
      message: "Please check on your dog. Guidance is loading…",
      research_summary: null,
      sources: []
    };
    this.ownerNotifications = [pending, ...this.ownerNotifications];

    let researchTimeout: NodeJS.Timeout | undefined;
    const research = Promise.race([
      this.alertEnricher.enrich({ sessionId: this.id, situation, videoTimestamp }),
      new Promise<never>((_resolve, reject) => {
        researchTimeout = setTimeout(() => reject(new Error("Guidance research timed out")), 10_000);
      })
    ]);

    void research
      .then((enrichment) => {
        if (generation !== this.notificationGeneration) return;
        this.replaceNotification(pending.id, { ...pending, ...enrichment, status: "sent" });
      })
      .catch(() => {
        if (generation !== this.notificationGeneration) return;
        this.replaceNotification(pending.id, {
          ...pending,
          status: "sent",
          message: `DogMaAI confirmed "${situationLabels[situation.type].toLowerCase()}" at ${Math.round(videoTimestamp)}s. Please check on your dog. Guidance was temporarily unavailable.`,
          research_summary: "The alert was delivered, but the live Nimble lookup could not complete.",
          sources: []
        });
      })
      .finally(() => { if (researchTimeout) clearTimeout(researchTimeout); });
  }

  private replaceNotification(id: string, replacement: OwnerNotification): void {
    this.ownerNotifications = this.ownerNotifications.map((item) => item.id === id ? replacement : item);
    this.emit("update", this.snapshot());
  }

  private syncCurrentTime(): void {
    const elapsed = (Date.now() - this.playStartedAtMs) / 1000;
    this.currentTime = Math.min(this.duration, this.playStartedAtVideoTime + elapsed * this.speed);
  }

  private async tick(): Promise<void> {
    if (this.status !== "playing") return;
    this.syncCurrentTime();
    const eligibleTimestamp = Math.floor(this.currentTime / this.sampleInterval) * this.sampleInterval;
    const lastTimestamp = this.state.last_video_timestamp ?? -this.sampleInterval;
    if (eligibleTimestamp > lastTimestamp) await this.processAt(eligibleTimestamp);
    if (this.currentTime >= this.duration) {
      this.stopTimer();
      this.status = "complete";
      this.emit("update", this.snapshot());
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

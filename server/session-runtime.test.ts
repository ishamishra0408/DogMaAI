import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { MockVisionProvider } from "./providers/mock-vision-provider.js";
import { SqliteSessionPersistence } from "./persistence.js";
import { SessionRuntime } from "./session-runtime.js";
import type { AlertEnricher } from "./alert-enrichment.js";

const fakeAlertEnricher: AlertEnricher = {
  mode: "nimble_live",
  async enrich() {
    return {
      message: "Please check on your dog.",
      research_summary: "Vetted guidance found.",
      sources: [{ title: "Guidance source", url: "https://example.com/guidance", snippet: "Guidance" }]
    };
  }
};

describe("mock session runtime", () => {
  it("runs the cage fixture: restlessness alerts once, a person's return resolves it, and a recurrence is linked", async () => {
    const runtime = new SessionRuntime("demo-test", new MockVisionProvider());
    await runtime.processUntil(32);

    const snapshot = runtime.snapshot();
    const restless = snapshot.state.situations.filter((item) => item.type === "restless_alone");
    const alerts = runtime.getEvents().filter((event) => event.mutation.type === "ALERT_EMITTED");
    // Alone at the bars from the start: restlessness opens at 2 s, alerts at 12 s and resolves when a hand appears at 20 s.
    // Alone again at 26 s, it recurs, linked to the first episode, and resolves at 30 s before reaching the alert threshold.
    expect(restless.map((item) => [item.started_at, item.alerted_at, item.resolved_at])).toEqual([[2, 12, 20], [26, null, 30]]);
    expect(restless[1].recurrence_of).toBe(restless[0].id);
    expect(snapshot.state.situations).toHaveLength(2);
    expect(alerts).toHaveLength(1);
    expect(snapshot.state.metrics.frames_sampled).toBe(17);
    expect(snapshot.state.metrics.observations_produced).toBe(17);
    expect(snapshot.state.metrics.repeated_observations_discarded).toBeGreaterThan(10);
    expect(snapshot.state.metrics.working_state_bytes).toBeLessThan(3_000);
  });

  it("replays deterministically after a reset", async () => {
    const runtime = new SessionRuntime("replay-test", new MockVisionProvider());
    await runtime.processUntil(30);
    const firstVersion = runtime.snapshot().state.state_version;
    const firstEvents = runtime.getEvents();

    runtime.reset();
    await runtime.processUntil(30);

    expect(runtime.snapshot().state.state_version).toBe(firstVersion);
    expect(runtime.getEvents()).toEqual(firstEvents);
  });

  it("restores from SQLite as uncertain and waits for fresh confirmation before alerting", async () => {
    const runtime = new SessionRuntime(
      `restart-${randomUUID()}`,
      new MockVisionProvider(),
      2,
      32,
      new SqliteSessionPersistence()
    );
    await runtime.processUntil(6);
    const beforeRestart = runtime.snapshot();
    expect(beforeRestart.state.situations.find((item) => item.type === "restless_alone")?.status).toBe("active");

    runtime.simulateRestart();
    expect(runtime.snapshot().state.room.stale).toBe(true);
    expect(runtime.snapshot().state.situations.find((item) => item.type === "restless_alone")?.status).toBe("uncertain");
    const alerts = () => runtime.getEvents().filter((event) => event.mutation.type === "ALERT_EMITTED");

    await runtime.processAt(8);
    expect(runtime.snapshot().state.room.stale).toBe(true);
    expect(alerts()).toHaveLength(0);

    await runtime.processAt(10);
    expect(runtime.snapshot().state.room.stale).toBe(false);
    expect(alerts()).toHaveLength(0);

    // Without the restart the alert would fire at 12 s; the 4 s spent uncertain pushes it to 16 s.
    await runtime.processAt(12);
    await runtime.processAt(14);
    expect(alerts()).toHaveLength(0);
    await runtime.processAt(16);
    expect(alerts()).toHaveLength(1);
    runtime.reset();
  });

  it("routes the manual occlusion control through the provider and reconciler", async () => {
    const runtime = new SessionRuntime("occlusion-test", new MockVisionProvider());
    await runtime.processUntil(2);
    expect(runtime.snapshot().state.room.camera_view).toBe("usable");

    runtime.setTemporaryOcclusion(true);
    await runtime.processAt(4);
    expect(runtime.snapshot().playback.manual_occlusion).toBe(true);
    expect(runtime.snapshot().state.room.camera_view).toBe("occluded");

    runtime.setTemporaryOcclusion(false);
    // 8 s and 10 s share one fixture segment, so the second of them confirms the restored view.
    await runtime.processAt(8);
    expect(runtime.snapshot().state.room.camera_view).toBe("occluded");
    await runtime.processAt(10);
    expect(runtime.snapshot().state.room.camera_view).toBe("usable");
    expect(runtime.snapshot().state.room.stale).toBe(false);
  });

  it("enriches each deterministic alert once and places an owner message in the outbox", async () => {
    const runtime = new SessionRuntime("notification-test", new MockVisionProvider(), 2, 32, undefined, fakeAlertEnricher);
    await runtime.processUntil(30);
    await Promise.resolve();

    const notifications = runtime.snapshot().owner_notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      status: "sent",
      channel: "in_app_demo",
      research_provider: "nimble_live",
      research_summary: "Vetted guidance found."
    });
    expect(notifications[0].sources).toHaveLength(1);
  });

  it("keeps the in-app alert usable when guidance research stalls", async () => {
    vi.useFakeTimers();
    try {
      const stalledEnricher: AlertEnricher = {
        mode: "nimble_live",
        enrich: () => new Promise(() => {})
      };
      const runtime = new SessionRuntime("stalled-research-test", new MockVisionProvider(), 2, 32, undefined, stalledEnricher);
      await runtime.processUntil(30);
      expect(runtime.snapshot().owner_notifications[0]).toMatchObject({
        status: "researching",
        message: "Please check on your dog. Guidance is loading…"
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(runtime.snapshot().owner_notifications[0]).toMatchObject({
        status: "sent",
        research_summary: "The alert was delivered, but the live Nimble lookup could not complete."
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

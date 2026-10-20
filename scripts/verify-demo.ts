import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MockVisionProvider } from "../server/providers/mock-vision-provider.js";
import { SqliteSessionPersistence } from "../server/persistence.js";
import { SessionRuntime } from "../server/session-runtime.js";

const fullDemo = new SessionRuntime("verification-full-demo", new MockVisionProvider());
await fullDemo.processUntil(32);

const snapshot = fullDemo.snapshot();
const restless = snapshot.state.situations.filter((item) => item.type === "restless_alone");
const alerts = fullDemo.getEvents().filter((event) => event.mutation.type === "ALERT_EMITTED");

assert.equal(snapshot.state.metrics.frames_sampled, 17, "Expected 17 two-second samples of the 32-second clip");
assert.equal(snapshot.state.metrics.observations_produced, 17, "Every sample should produce an observation");
assert.equal(restless.length, 2, "Expected restlessness while alone and one recurrence");
assert.ok(restless.every((item) => item.status === "resolved"), "A person's return should resolve both episodes");
assert.equal(restless[1].recurrence_of, restless[0].id, "The recurrence must link to the first episode");
assert.equal(snapshot.state.situations.length, 2, "The cage clip has no other situations");
assert.equal(alerts.length, 1, "Only the first, longer episode should alert");
assert.equal(alerts[0].video_timestamp, 12, "The alert should fire 10 seconds after restlessness is confirmed");
assert.ok(snapshot.state.metrics.repeated_observations_discarded > 10, "Repeated observations should be discarded");
assert.ok(snapshot.state.metrics.working_state_bytes < 4_000, "Working state should remain bounded");

const occlusionDemo = new SessionRuntime("verification-occlusion", new MockVisionProvider());
await occlusionDemo.processUntil(2);
occlusionDemo.setTemporaryOcclusion(true);
await occlusionDemo.processAt(4);
assert.ok(occlusionDemo.getEvents().some((event) => event.mutation.type === "MONITORING_UNCERTAIN"), "Blocking the view should produce uncertainty");

const restartDemo = new SessionRuntime(
  `verification-restart-${randomUUID()}`,
  new MockVisionProvider(),
  2,
  32,
  new SqliteSessionPersistence()
);
await restartDemo.processUntil(6);
restartDemo.simulateRestart();
assert.equal(restartDemo.snapshot().state.room.stale, true, "Restored state must be stale");
await restartDemo.processAt(8);
assert.equal(restartDemo.snapshot().state.room.stale, true, "One fresh observation must remain provisional");
await restartDemo.processAt(10);
assert.equal(restartDemo.snapshot().state.room.stale, false, "Two fresh observations should restore confidence");
const restartAlerts = () => restartDemo.getEvents().filter((event) => event.mutation.type === "ALERT_EMITTED").length;
await restartDemo.processAt(12);
await restartDemo.processAt(14);
assert.equal(restartAlerts(), 0, "Recovery must not alert before the paused time is made up");
await restartDemo.processAt(16);
assert.equal(restartAlerts(), 1, "Alert should fire after confirmed active video time");
restartDemo.reset();

console.log(JSON.stringify({
  result: "PASS",
  frames_sampled: snapshot.state.metrics.frames_sampled,
  observations_produced: snapshot.state.metrics.observations_produced,
  mutations_accepted: snapshot.state.metrics.mutations_accepted,
  observations_discarded: snapshot.state.metrics.repeated_observations_discarded,
  working_state_bytes: snapshot.state.metrics.working_state_bytes,
  restless_episodes: restless.length,
  alerts: alerts.length,
  recurrence_linked: restless[1].recurrence_of === restless[0].id,
  uncertainty_verified: true,
  restart_recovery_verified: true
}, null, 2));

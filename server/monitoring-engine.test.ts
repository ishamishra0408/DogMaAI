import { describe, expect, it } from "vitest";
import type { CandidateObservation } from "../shared/domain.js";
import { createMonitoringState, processObservation } from "./monitoring-engine.js";

function observation(at: number, overrides: Partial<CandidateObservation> = {}): CandidateObservation {
  return {
    frame_id: `frame_${at}`,
    observed_at_seconds: at,
    camera_view: "usable",
    dog_visible: true,
    dog_activity: "resting",
    dog_location: "bed",
    person_visible: false,
    chewing_items: false,
    uncertainties: [],
    short_description: "The dog is resting on its bed.",
    ...overrides
  };
}
const moving: Partial<CandidateObservation> = { dog_activity: "moving", dog_location: "floor", short_description: "The dog is pacing the room." };

function feed(times: number[], overrides: Partial<CandidateObservation>, state = createMonitoringState("test")) {
  const mutations = [];
  for (const time of times) {
    const result = processObservation(state, observation(time, overrides));
    state = result.state;
    mutations.push(...result.mutations);
  }
  return { state, mutations };
}

describe("monitoring engine", () => {
  it("requires two compatible observations before changing canonical room state", () => {
    const first = processObservation(createMonitoringState("test"), observation(0));
    expect(first.mutations).toEqual([]);
    expect(first.state.room.dog_visible).toBe("unknown");

    const second = processObservation(first.state, observation(2));
    expect(second.mutations.map((mutation) => mutation.type)).toEqual(["ROOM_STATE_CHANGED"]);
    expect(second.state.room.dog_activity).toBe("resting");
  });

  it("opens, alerts exactly once, resolves, and links a recurrence", () => {
    let state = feed([0, 2], {}).state;
    let result = feed([14, 16], moving, state);
    state = result.state;
    const firstSituation = state.situations.find((item) => item.type === "restless_alone")!;
    expect(firstSituation.status).toBe("active");

    result = feed([26, 28, 30], moving, state);
    state = result.state;
    expect(result.mutations.filter((mutation) => mutation.type === "ALERT_EMITTED")).toHaveLength(1);

    result = feed([40, 42], {}, state);
    state = result.state;
    expect(state.situations.find((item) => item.id === firstSituation.id)?.status).toBe("resolved");

    result = feed([56, 58], moving, state);
    const recurrence = result.state.situations.filter((item) => item.type === "restless_alone").at(-1)!;
    expect(recurrence.id).not.toBe(firstSituation.id);
    expect(recurrence.recurrence_of).toBe(firstSituation.id);
  });

  it("treats a dog moving with a person present as not alone, and a returning person as resolution", () => {
    let result = feed([0, 2], { ...moving, person_visible: true });
    expect(result.state.situations).toEqual([]);
    result = feed([4, 6], moving, result.state);
    expect(result.state.situations.find((item) => item.type === "restless_alone")?.status).toBe("active");
    result = feed([8, 10], { ...moving, person_visible: true }, result.state);
    const situation = result.state.situations.find((item) => item.type === "restless_alone")!;
    expect(situation.status).toBe("resolved");
  });

  it("tracks waiting at the door and chewing as their own situations", () => {
    let result = feed([0, 2], { ...moving, dog_location: "door" });
    expect(result.state.situations.map((item) => item.type).sort()).toEqual(["restless_alone", "waiting_at_door"]);
    result = feed([4, 6], { dog_activity: "playing", dog_location: "floor", chewing_items: true }, result.state);
    const types = Object.fromEntries(result.state.situations.map((item) => [item.type, item.status]));
    expect(types.waiting_at_door).toBe("resolved");
    expect(types.chewing_items).toBe("active");
    result = feed([8, 10], { dog_activity: "playing", dog_location: "floor", chewing_items: false }, result.state);
    expect(result.state.situations.find((item) => item.type === "chewing_items")?.status).toBe("resolved");
  });

  it("marks uncertainty immediately and pauses the alert timer", () => {
    let state = feed([0, 2], {}).state;
    state = feed([14, 16], moving, state).state;

    const uncertain = processObservation(state, observation(20, {
      camera_view: "occluded",
      dog_visible: "unknown",
      dog_activity: "unknown",
      dog_location: "unknown",
      person_visible: "unknown",
      chewing_items: "unknown"
    }));
    expect(uncertain.mutations.some((mutation) => mutation.type === "MONITORING_UNCERTAIN")).toBe(true);
    expect(uncertain.state.situations.find((item) => item.type === "restless_alone")?.status).toBe("uncertain");

    let resumed = processObservation(uncertain.state, observation(30, moving));
    resumed = processObservation(resumed.state, observation(32, moving));
    const situation = resumed.state.situations.find((item) => item.type === "restless_alone")!;
    expect(situation.status).toBe("active");
    expect(situation.alerted_at).toBeNull();
    expect(situation.alert_timer_paused_seconds).toBe(12);
  });

  it("reports uncertainty when the first camera observation is unusable", () => {
    const result = processObservation(createMonitoringState("test"), observation(0, {
      camera_view: "unusable",
      dog_visible: "unknown",
      dog_activity: "unknown",
      dog_location: "unknown"
    }));
    expect(result.mutations.map((mutation) => mutation.type)).toEqual(["MONITORING_UNCERTAIN"]);
    expect(result.state.room.camera_view).toBe("unusable");
  });

  it("rejects invalid provider output without mutating canonical state", () => {
    const before = createMonitoringState("test");
    const result = processObservation(before, { frame_id: "bad", camera_view: "clear" });
    expect(result.validationErrors.length).toBeGreaterThan(0);
    expect(result.state.state_version).toBe(0);
    expect(result.state.metrics.invalid_observations_rejected).toBe(1);
    // A dog the camera cannot see cannot be reported as pacing.
    const contradictory = processObservation(before, observation(0, { dog_visible: false, dog_activity: "moving" }));
    expect(contradictory.validationErrors.join(" ")).toContain("dog_activity");
  });

  it("discards repeated observations while keeping working state bounded", () => {
    let state = feed([0, 2], {}).state;
    const initialBytes = state.metrics.working_state_bytes;
    state = feed(Array.from({ length: 100 }, (_, index) => 4 + index * 2), {}, state).state;
    expect(state.metrics.repeated_observations_discarded).toBeGreaterThanOrEqual(100);
    expect(state.metrics.working_state_bytes - initialBytes).toBeLessThan(100);
  });
});

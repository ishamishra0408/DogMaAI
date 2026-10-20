import { readFileSync } from "node:fs";
import type { CandidateObservation } from "../../shared/domain.js";
import { candidateObservationSchema } from "../../shared/observation-schema.js";
import type { FrameSample, VisualObservationProvider } from "./visual-observation-provider.js";

const defaultFixtureUrl = new URL("../../fixtures/mock-observations.json", import.meta.url);

function loadFixture(fixtureUrl: URL): CandidateObservation[] {
  const input: unknown = JSON.parse(readFileSync(fixtureUrl, "utf8"));
  if (!Array.isArray(input) || input.length === 0) throw new Error("Mock fixture must contain observations");
  const observations = input.map((item) => candidateObservationSchema.parse(item));
  return observations.sort((left, right) => left.observed_at_seconds - right.observed_at_seconds);
}

export class MockVisionProvider implements VisualObservationProvider {
  readonly name = "mock";
  private readonly observations: CandidateObservation[];
  private temporaryOcclusion = false;

  constructor(fixtureUrl: URL = defaultFixtureUrl) {
    this.observations = loadFixture(fixtureUrl);
  }

  async observe(frame: FrameSample): Promise<CandidateObservation> {
    const template = [...this.observations]
      .reverse()
      .find((item) => item.observed_at_seconds <= frame.videoTimestamp)
      ?? this.observations[0];

    if (this.temporaryOcclusion) {
      return {
        frame_id: frame.frameId,
        observed_at_seconds: frame.videoTimestamp,
        camera_view: "occluded",
        dog_visible: "unknown",
        dog_activity: "unknown",
        dog_location: "unknown",
        person_visible: "unknown",
        chewing_items: "unknown",
        uncertainties: ["Temporary camera occlusion enabled in demo controls."],
        short_description: "The room cannot be assessed because the camera is temporarily occluded."
      };
    }

    return {
      ...structuredClone(template),
      frame_id: frame.frameId,
      observed_at_seconds: frame.videoTimestamp
    };
  }

  setTemporaryOcclusion(enabled: boolean): void {
    this.temporaryOcclusion = enabled;
  }
}

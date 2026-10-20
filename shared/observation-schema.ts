import { z } from "zod";
import type { CandidateObservation } from "./domain.js";

const unknownableBoolean = z.union([z.boolean(), z.literal("unknown")]);

export const candidateObservationSchema = z.object({
  frame_id: z.string().min(1),
  observed_at_seconds: z.number().finite().nonnegative(),
  camera_view: z.enum(["usable", "occluded", "unusable", "unknown"]),
  dog_visible: unknownableBoolean,
  dog_activity: z.enum(["resting", "moving", "playing", "unknown"]),
  dog_location: z.enum(["bed", "floor", "furniture", "door", "unknown"]),
  person_visible: unknownableBoolean,
  chewing_items: unknownableBoolean,
  uncertainties: z.array(z.string()),
  short_description: z.string().min(1).max(500)
}).superRefine((observation, context) => {
  // A dog the camera cannot see has no observable activity, location or chewing.
  if (observation.dog_visible !== false) return;
  for (const field of ["dog_activity", "dog_location"] as const) {
    if (observation[field] !== "unknown") context.addIssue({ code: "custom", path: [field], message: "must be unknown when the dog is not visible" });
  }
  if (observation.chewing_items === true) context.addIssue({ code: "custom", path: ["chewing_items"], message: "cannot be true when the dog is not visible" });
});

export function validateObservation(input: unknown):
  | { success: true; data: CandidateObservation }
  | { success: false; errors: string[] } {
  const result = candidateObservationSchema.safeParse(input);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".") || "observation"}: ${issue.message}`)
  };
}

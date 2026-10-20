import { z } from "zod";
import type { DogView } from "../shared/diary.js";

export const unknownView: DogView = { dog_visible: "unknown", dog_activity: "unknown", dog_location: "unknown", person_visible: "unknown" };

const fields = z.object({
  dog_visible: z.enum(["yes", "no"]),
  activity: z.enum(["resting", "moving", "playing", "eating", "unknown"]),
  location: z.enum(["bed", "floor", "furniture", "door", "unknown"]),
  person_visible: z.enum(["yes", "no"])
}).strict();
// llama-server turns this schema into a grammar, so the reply is always one of these values.
const replySchema = {
  type: "object",
  properties: {
    dog_visible: { enum: ["yes", "no"] },
    activity: { enum: ["resting", "moving", "playing", "eating", "unknown"] },
    location: { enum: ["bed", "floor", "furniture", "door", "unknown"] },
    person_visible: { enum: ["yes", "no"] }
  },
  required: ["dog_visible", "activity", "location", "person_visible"],
  additionalProperties: false
};

function prompt(description: string) {
  return [
    "Classify this description of a home camera image.",
    `Description: ${JSON.stringify(description)}`,
    "activity: resting (lying, sitting, sleeping), moving (walking, pacing, pawing, standing), playing (chewing, playing with a toy), eating (eating food from a bowl or dish; drinking water counts as moving), or unknown.",
    "location: bed (dog bed, crate, basket), floor, furniture (sofa, chair, table), door (waiting or pawing at a door), or unknown.",
    "dog_visible: no only if the description says no dog is visible or describes no dog.",
    "person_visible: yes if the description mentions a person or part of one, such as a hand; otherwise no."
  ].join("\n");
}

// The description is written from the image first; asking the small model for fields alongside the image made it misread the scene.
// This second, text-only request is short and returns fixed values the diary can compare.
export async function classifyDescription(endpoint: string, model: string, description: string, fetcher: typeof fetch = fetch): Promise<DogView> {
  try {
    const response = await fetcher(`${endpoint}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model, stream: false, max_tokens: 60, temperature: 0,
        response_format: { type: "json_schema", json_schema: { name: "dog_view", schema: replySchema } },
        messages: [{ role: "user", content: prompt(description) }]
      })
    });
    if (!response.ok) return unknownView;
    const output = await response.json() as { choices?: { message?: { content?: string } }[] };
    const parsed = fields.safeParse(JSON.parse(output.choices?.[0]?.message?.content ?? ""));
    if (!parsed.success) return unknownView;
    const person_visible = parsed.data.person_visible === "yes";
    // A dog the camera cannot see has no activity or place, as in the monitoring rules.
    if (parsed.data.dog_visible === "no") return { dog_visible: false, dog_activity: "unknown", dog_location: "unknown", person_visible };
    return { dog_visible: true, dog_activity: parsed.data.activity, dog_location: parsed.data.location, person_visible };
  } catch {
    return unknownView;
  }
}

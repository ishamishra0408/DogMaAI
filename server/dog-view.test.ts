import { expect, it, vi } from "vitest";
import { classifyDescription, unknownView } from "./dog-view.js";

const reply = (content: string, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

it("reads fixed fields from the description text alone", async () => {
  const remote = vi.fn<typeof fetch>().mockResolvedValue(reply('{"dog_visible":"yes","activity":"moving","location":"door","person_visible":"no"}'));
  expect(await classifyDescription("http://localhost:8081/v1", "LFM2.5-VL-3B", "The dog paws at the door.", remote)).toEqual({ dog_visible: true, dog_activity: "moving", dog_location: "door", person_visible: false });
  expect(String(remote.mock.calls[0][0])).toBe("http://localhost:8081/v1/chat/completions");
  const body = JSON.parse(String(remote.mock.calls[0][1]?.body));
  expect(body.response_format.json_schema.schema.required).toEqual(["dog_visible", "activity", "location", "person_visible"]);
  expect(body.messages[0].content).toContain("The dog paws at the door.");
  expect(JSON.stringify(body)).not.toContain("image_url");
});

it("gives a dog that is not visible no activity or place", async () => {
  const remote = vi.fn<typeof fetch>().mockResolvedValue(reply('{"dog_visible":"no","activity":"moving","location":"floor","person_visible":"yes"}'));
  expect(await classifyDescription("http://localhost:8081/v1", "LFM2.5-VL-3B", "No dog is visible.", remote)).toEqual({ dog_visible: false, dog_activity: "unknown", dog_location: "unknown", person_visible: true });
});

it("returns unknown for malformed, unexpected or failed replies", async () => {
  for (const response of [reply("not json"), reply('{"dog_visible":"maybe","activity":"moving","location":"floor"}'), reply("{}", 500)]) {
    expect(await classifyDescription("http://localhost:8081/v1", "LFM2.5-VL-3B", "A dog.", vi.fn<typeof fetch>().mockResolvedValue(response))).toEqual(unknownView);
  }
  expect(await classifyDescription("http://localhost:8081/v1", "LFM2.5-VL-3B", "A dog.", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")))).toEqual(unknownView);
});

it("reads eating at the bowl and a person in view, for activity and time alone", async () => {
  const remote = vi.fn<typeof fetch>().mockResolvedValue(reply('{"dog_visible":"yes","activity":"eating","location":"floor","person_visible":"yes"}'));
  expect(await classifyDescription("http://localhost:8081/v1", "LFM2.5-VL-3B", "The dog eats from its bowl while a person watches.", remote)).toEqual({ dog_visible: true, dog_activity: "eating", dog_location: "floor", person_visible: true });
  expect(JSON.parse(String(remote.mock.calls[0][1]?.body)).messages[0].content).toMatch(/eating \(eating food from a bowl or dish; drinking water counts as moving\)/);
});

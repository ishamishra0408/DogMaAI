import { describe, expect, it } from "vitest";
import type { HeardSecond } from "../shared/hearing.js";
import { createSoundListener, dogSound, type SoundMinute } from "./dog-sounds.js";

const quiet = { whimperDog: 0, humanWhimper: 0, howl: 0, bark: 0, yip: 0, bowWow: 0, dog: 0, music: 0, speech: 0, silence: 0 };

describe("dog sounds", () => {
  it("calls a whimper or a howl crying and a bark barking, only above the cautious cut-offs", () => {
    expect(dogSound({ ...quiet, whimperDog: 0.6 })).toBe("crying");
    expect(dogSound({ ...quiet, howl: 0.3, bark: 0.1 })).toBe("crying");
    expect(dogSound({ ...quiet, bark: 0.7, whimperDog: 0.3 })).toBe("barking");
    expect(dogSound({ ...quiet, whimperDog: 0.1, bark: 0.15 })).toBeNull();
  });

  it("counts what YAMNet calls a person's whimper as crying, and uses the crying cut-off in use", () => {
    // Through the camera's 8 kHz microphone a dog's soft whimper often scores as a whimper rather than a dog's whimper.
    expect(dogSound({ ...quiet, humanWhimper: 0.24 })).toBe("crying");
    expect(dogSound({ ...quiet, whimperDog: 0.09 })).toBeNull();
    const tuned = { crying: 0.08, barking: 0.2 };
    expect(dogSound({ ...quiet, whimperDog: 0.09 }, tuned)).toBe("crying");
    // A clear bark stays a bark even when a lower crying cut-off is also reached.
    expect(dogSound({ ...quiet, whimperDog: 0.1, bark: 0.5 }, tuned)).toBe("barking");
  });

  it("counts heard, crying and barking seconds per minute, leaving muted and silent seconds out", async () => {
    let clock = Date.parse("2026-09-28T10:00:00Z");
    let muted = false;
    const rows: SoundMinute[] = [];
    // A stand-in model: loud positive samples are a whimper, loud negative ones a bark.
    const classify = async (samples: Float32Array) => samples[0] > 0.5 ? { ...quiet, whimperDog: 0.9 } : samples[0] < -0.5 ? { ...quiet, bark: 0.9 } : quiet;
    const listener = createSoundListener({ classify, record: row => rows.push(row), muted: () => muted, sampleRate: 4, windowSize: 4, now: () => clock });
    const second = (value: number) => { listener.push(Int16Array.from({ length: 4 }, () => value)); clock += 1000; };
    second(30_000); second(30_000); second(-30_000); second(100);
    // Digital silence, and a second while DogMaAI plays through the camera, are not heard.
    second(0);
    muted = true; second(30_000); muted = false;
    clock = Date.parse("2026-09-28T10:01:00Z");
    second(-30_000);
    await listener.flush();
    expect(rows).toEqual([
      { observed_at: "2026-09-28T10:00:00.000Z", camera: "home", heard_seconds: 4, crying_seconds: 2, barking_seconds: 1 },
      { observed_at: "2026-09-28T10:01:00.000Z", camera: "home", heard_seconds: 1, crying_seconds: 0, barking_seconds: 1 }
    ]);
  });

  it("tells the live view about every second, reading the cut-offs as each one is judged", async () => {
    let clock = Date.parse("2026-09-28T10:00:00Z");
    let muted = false;
    let cutoff = 0.2;
    const heard: HeardSecond[] = [];
    const classify = async () => ({ ...quiet, whimperDog: 0.1, top: [{ label: "Dog", score: 0.4 }] });
    const listener = createSoundListener({ classify, record: () => {}, muted: () => muted, sampleRate: 4, windowSize: 4, now: () => clock, cutoffs: () => ({ crying: cutoff, barking: 0.2 }), onSecond: second => heard.push(second) });
    const second = (value: number) => { listener.push(Int16Array.from({ length: 4 }, () => value)); clock += 1000; };
    second(30_000);
    await listener.flush();
    cutoff = 0.08;
    second(30_000);
    second(0);
    muted = true; second(30_000);
    // A muted camera sends silence; that is still called muted.
    second(0); muted = false;
    await listener.flush();
    expect(heard.map(item => [item.heard, item.reason, item.sound, item.crying])).toEqual([[true, null, null, 0.1], [true, null, "crying", 0.1], [false, "quiet", null, 0], [false, "muted", null, 0], [false, "muted", null, 0]]);
    expect(heard[0].top).toEqual([{ label: "Dog", score: 0.4 }]);
  });

  it("dates two seconds that end in the same chunk of sound a second apart", async () => {
    const heard: HeardSecond[] = [];
    const end = Date.parse("2026-09-28T10:00:10Z");
    const listener = createSoundListener({ classify: async () => quiet, record: () => {}, sampleRate: 4, windowSize: 4, now: () => end, onSecond: second => heard.push(second) });
    listener.push(Int16Array.from({ length: 8 }, () => 30_000));
    await listener.flush();
    expect(heard.map(item => item.t)).toEqual([end - 1000, end]);
  });

  it("keeps counting minutes even if the live view fails", async () => {
    const rows: SoundMinute[] = [];
    const listener = createSoundListener({ classify: async () => ({ ...quiet, whimperDog: 0.9 }), record: row => rows.push(row), sampleRate: 4, windowSize: 4, now: () => Date.parse("2026-09-28T10:00:00Z"), onSecond: () => { throw new Error("The page went away"); } });
    listener.push(Int16Array.from({ length: 4 }, () => 30_000));
    await listener.flush();
    expect(rows).toEqual([{ observed_at: "2026-09-28T10:00:00.000Z", camera: "home", heard_seconds: 1, crying_seconds: 1, barking_seconds: 0 }]);
  });
});

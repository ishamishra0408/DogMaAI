import { expect, it } from "vitest";
import { applyVolume, cameraSampleRate, createSoundSource, toPcm16, wavHeader } from "./comfort-audio.js";
import { calmBeatSeconds, calmPhraseBeats } from "../shared/comfort.js";

const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
function seeded(seed: number) { return () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296; }
function render(action: "dog-music" | "dog-noise", seconds: number) {
  const source = createSoundSource(action, seeded(3));
  const samples = new Float32Array(seconds * cameraSampleRate);
  for (let second = 0; second < seconds; second++) samples.set(source.read(cameraSampleRate)!, second * cameraSampleRate);
  return samples;
}

it("streams calm music that fades in, stays within range and never ends by itself", () => {
  const music = render("dog-music", 40);
  expect(music.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0)).toBeLessThanOrEqual(1);
  // Every phrase opens with a chord and a melody note, so the first opening is quieter only because of the fade-in.
  const window = cameraSampleRate / 4;
  const secondPhrase = Math.round(calmPhraseBeats * calmBeatSeconds * cameraSampleRate);
  expect(rms(music.slice(0, window))).toBeLessThan(rms(music.slice(secondPhrase, secondPhrase + window)) / 3);
  // Loud enough for a small camera speaker, and levelled with the brown noise.
  const level = rms(music.slice(3 * cameraSampleRate));
  expect(level).toBeGreaterThan(0.05);
  expect(Math.abs(20 * Math.log10(level / rms(render("dog-noise", 40).slice(3 * cameraSampleRate))))).toBeLessThan(3);
});

it("streams brown noise without clicks after a three-second fade-in", () => {
  const noise = render("dog-noise", 8);
  expect(rms(noise.slice(0, cameraSampleRate / 10))).toBeLessThan(rms(noise.slice(6 * cameraSampleRate)) / 5);
  let jump = 0;
  for (let index = 1; index < noise.length; index++) jump = Math.max(jump, Math.abs(noise[index] - noise[index - 1]));
  expect(jump).toBeLessThan(0.05);
});

it("describes an open-ended 16-bit mono stream and clamps samples", () => {
  const header = wavHeader();
  expect(header.toString("ascii", 0, 4)).toBe("RIFF");
  expect(header.toString("ascii", 8, 12)).toBe("WAVE");
  expect(header.readUInt16LE(22)).toBe(1);
  expect(header.readUInt32LE(24)).toBe(cameraSampleRate);
  expect(header.readUInt16LE(34)).toBe(16);
  expect(header.readUInt32LE(40)).toBe(0xffffffff);
  const pcm = toPcm16(Float32Array.from([2, -2, 0]));
  expect([pcm.readInt16LE(0), pcm.readInt16LE(2), pcm.readInt16LE(4)]).toEqual([32767, -32767, 0]);
});

it("makes the camera louder without clipping, or quieter, and leaves Normal as it was", () => {
  const db = (ratio: number) => 20 * Math.log10(ratio);
  for (const action of ["dog-music", "dog-noise"] as const) {
    const normal = render(action, 10);
    const loud = applyVolume(normal, "loud");
    const soft = applyVolume(normal, "soft");
    expect(applyVolume(normal, "normal")).toBe(normal);
    // Loud is several decibels louder, with every sample still inside full scale.
    expect(db(rms(loud) / rms(normal))).toBeGreaterThan(4);
    expect(loud.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0)).toBeLessThanOrEqual(1);
    expect(db(rms(soft) / rms(normal))).toBeCloseTo(db(0.6), 1);
  }
});

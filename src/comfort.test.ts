import { expect, it } from "vitest";
import { calmBeatSeconds, calmPhrase, calmPhraseBeats, calmScale } from "../shared/comfort";

// A small seeded generator keeps the check repeatable.
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

it("keeps dog music slow, low, long-noted and mostly falling", () => {
  expect(60 / calmBeatSeconds).toBeLessThanOrEqual(60);
  const random = seeded(7);
  let previous = 4;
  let falling = 0;
  let rising = 0;
  for (let count = 0; count < 500; count++) {
    const phrase = calmPhrase(random, previous);
    previous = phrase.last;
    const melody = phrase.notes.filter(note => note.beats < calmPhraseBeats);
    for (const note of phrase.notes) {
      expect(note.frequency).toBeGreaterThanOrEqual(87);
      expect(note.frequency).toBeLessThanOrEqual(440);
      expect(note.beat + note.beats).toBeLessThanOrEqual(calmPhraseBeats);
    }
    for (const note of melody) {
      expect(calmScale).toContain(note.frequency);
      expect([2, 3]).toContain(note.beats);
    }
    // Every phrase ends with a rest before the next one starts.
    expect(Math.max(...melody.map(note => note.beat + note.beats))).toBeLessThan(calmPhraseBeats);
    for (let index = 1; index < melody.length; index++) {
      if (melody[index].frequency < melody[index - 1].frequency) falling++;
      if (melody[index].frequency > melody[index - 1].frequency) rising++;
    }
  }
  expect(falling).toBeGreaterThan(rising * 1.5);
});

it("varies from phrase to phrase so the music does not simply repeat", () => {
  const random = seeded(11);
  const phrases = new Set<string>();
  let previous = 4;
  for (let count = 0; count < 40; count++) {
    const phrase = calmPhrase(random, previous);
    previous = phrase.last;
    phrases.add(phrase.notes.map(note => `${note.frequency}:${note.beat}:${note.beats}`).join(","));
  }
  expect(phrases.size).toBeGreaterThan(20);
});

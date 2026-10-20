import { calmBeatSeconds, calmPhrase, calmPhraseBeats, type ComfortAction, type SpeakerVolume } from "../shared/comfort.js";

// Comfort sounds rendered on the server so a camera speaker can play them without a browser tab open.
// The composition matches src/comfort.ts; levels are higher because camera speakers are small and use 8 kHz telephone audio.
export const cameraSampleRate = 16_000;
export interface SoundSource { read(frames: number): Float32Array | null; close?(): void }

type Wave = "sine" | "triangle";
function addTone(target: Float32Array, offset: number, wave: Wave, frequency: number, seconds: number, level: number, attack = 0.15) {
  const length = Math.floor(seconds * cameraSampleRate);
  const attackFrames = Math.max(1, Math.floor(Math.min(attack, seconds / 4) * cameraSampleRate));
  const decayFrames = Math.max(1, length - attackFrames);
  for (let index = 0; index < length && offset + index < target.length; index++) {
    const phase = (frequency * index / cameraSampleRate) % 1;
    const sample = wave === "sine" ? Math.sin(2 * Math.PI * phase) : 4 * Math.abs(phase - 0.5) - 1;
    // A linear rise, then an exponential fall to 0.001, as in the browser engine.
    const envelope = index < attackFrames ? level * index / attackFrames : level * Math.pow(0.001 / level, (index - attackFrames) / decayFrames);
    target[offset + index] += sample * envelope;
  }
}

function calmMusic(random: () => number): SoundSource {
  const gain = 0.7;
  const phraseFrames = Math.round(calmPhraseBeats * calmBeatSeconds * cameraSampleRate);
  let previous = 4;
  let phrase = new Float32Array(0);
  let position = 0;
  let produced = 0;
  const fadeFrames = 2 * cameraSampleRate;
  return {
    read(frames) {
      const out = new Float32Array(frames);
      for (let index = 0; index < frames; index++) {
        if (position >= phrase.length) {
          const next = calmPhrase(random, previous);
          previous = next.last;
          phrase = new Float32Array(phraseFrames);
          for (const note of next.notes) addTone(phrase, Math.round(note.beat * calmBeatSeconds * cameraSampleRate), note.beats === calmPhraseBeats ? "sine" : "triangle", note.frequency, note.beats * calmBeatSeconds, note.level);
          position = 0;
        }
        const fade = Math.min(1, produced / fadeFrames);
        out[index] = Math.max(-1, Math.min(1, phrase[position++] * gain * fade));
        produced++;
      }
      return out;
    }
  };
}

// Brown noise, generated continuously so there is no loop point, then softened by a one-pole low-pass at 900 Hz.
function brownNoise(random: () => number): SoundSource {
  const gain = 0.5;
  const smoothing = 1 - Math.exp(-2 * Math.PI * 900 / cameraSampleRate);
  const fadeFrames = 3 * cameraSampleRate;
  let last = 0;
  let filtered = 0;
  let produced = 0;
  return {
    read(frames) {
      const out = new Float32Array(frames);
      for (let index = 0; index < frames; index++) {
        last = (last + 0.02 * (random() * 2 - 1)) / 1.02;
        filtered += smoothing * (last * 3.5 - filtered);
        out[index] = Math.max(-1, Math.min(1, filtered * gain * Math.min(1, produced++ / fadeFrames)));
      }
      return out;
    }
  };
}

export function createSoundSource(action: Exclude<ComfortAction, "stop">, random = Math.random): SoundSource {
  return action === "dog-music" ? calmMusic(random) : brownNoise(random);
}

// A WAV header with the largest possible sizes marks an open-ended live stream.
export function wavHeader(sampleRate = cameraSampleRate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(0xffffffff, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(0xffffffff, 40);
  return header;
}

// The camera speaker's volume. Normal is the level DogMaAI started with. Loud lifts quieter passages by about 6 dB and
// rounds the peaks off smoothly, so the small speaker gets louder without clipping; Soft is quieter than Normal.
const loudDrive = 2;
export function applyVolume(samples: Float32Array, volume: SpeakerVolume) {
  if (volume === "normal") return samples;
  const out = new Float32Array(samples.length);
  const peak = Math.tanh(loudDrive);
  for (let index = 0; index < samples.length; index++) out[index] = volume === "soft" ? samples[index] * 0.6 : Math.tanh(loudDrive * samples[index]) / peak;
  return out;
}

export function toPcm16(samples: Float32Array) {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), index * 2));
  return bytes;
}

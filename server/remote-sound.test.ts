import { expect, it } from "vitest";
import { cameraSampleRate, type SoundSource } from "./comfort-audio.js";
import { createRemoteSource, isCommonsUpload } from "./remote-sound.js";

const address = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Calm_piano.wav";
const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
// A quiet 440 Hz tone as a 22.05 kHz WAV file, standing in for a downloaded recording.
function wav(seconds: number, level = 0.05, rate = 22_050) {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  for (let index = 0; index < data.length / 2; index++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / rate) * level * 32767), index * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8); header.write("fmt ", 12); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const settle = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
// Reads a source until it ends, passing on each chunk with sound in it. Until ffmpeg has decoded something, read() returns
// silence rather than null, to keep the camera's live stream open, so a loop that stops only on null would spin forever
// and freeze the test process whenever ffmpeg is slow. This one waits between silent reads, and gives up at a deadline.
async function readToEnd(source: SoundSource, onSound: (chunk: Float32Array) => void = () => {}, frames = cameraSampleRate, seconds = 15) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const chunk = source.read(frames);
    if (chunk === null) return true;
    if (chunk.some(value => value !== 0)) onSound(chunk); else await settle(50);
  }
  return false;
}

it("plays only Wikimedia Commons uploads", () => {
  expect(isCommonsUpload(address)).toBe(true);
  for (const other of [
    "http://upload.wikimedia.org/wikipedia/commons/a/ab/A.ogg", "https://upload.wikimedia.org.evil.example/wikipedia/commons/A.ogg",
    "https://example.com/wikipedia/commons/A.ogg", "https://upload.wikimedia.org/wikipedia/en/a/ab/A.ogg",
    "https://user:pass@upload.wikimedia.org/wikipedia/commons/A.ogg", "https://upload.wikimedia.org:8443/wikipedia/commons/A.ogg", "file:///etc/hosts", "not a url"
  ]) expect(isCommonsUpload(other)).toBe(false);
  expect(() => createRemoteSource("https://example.com/a.ogg")).toThrow(/Wikimedia Commons/);
});

it("decodes a recording to camera audio at the built-in sounds' level, with a fade-in", async () => {
  let requested = "";
  const source = createRemoteSource(address, async input => { requested = String(input); return new Response(wav(8)); });
  const chunks: Float32Array[] = [];
  try { expect(await readToEnd(source, chunk => chunks.push(chunk))).toBe(true); } finally { source.close?.(); }
  const audio = Float32Array.from(chunks.flatMap(chunk => [...chunk]));
  expect(requested).toBe(address);
  expect(audio.length / cameraSampleRate).toBeGreaterThan(7.5);
  expect(audio.length / cameraSampleRate).toBeLessThan(8.5);
  // The quiet tone is raised towards -20 dBFS and the first quarter second is faded in.
  const level = 20 * Math.log10(rms(audio.slice(4 * cameraSampleRate, 7 * cameraSampleRate)));
  expect(level).toBeGreaterThan(-25);
  expect(level).toBeLessThan(-15);
  expect(rms(audio.slice(0, cameraSampleRate / 4))).toBeLessThan(rms(audio.slice(4 * cameraSampleRate, 5 * cameraSampleRate)) / 3);
}, 20_000);

it("ends quietly when the recording cannot be downloaded or playback is closed", async () => {
  // Until either ends, it plays only silence.
  const missing = createRemoteSource(address, async () => new Response("gone", { status: 404 }));
  let sound = false;
  try { expect(await readToEnd(missing, () => { sound = true; }, 1600)).toBe(true); } finally { missing.close?.(); }
  const endless = createRemoteSource(address, async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })));
  endless.close?.();
  expect(await readToEnd(endless, () => { sound = true; }, 1600)).toBe(true);
  expect(sound).toBe(false);
}, 20_000);

it("gives up on a download that stops sending, and ends with the audio it received", async () => {
  const start = wav(1);
  const source = createRemoteSource(address, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(start.subarray(0, start.length / 2)); },
    pull: () => new Promise(() => {})
  })), undefined, 300);
  let heard = false;
  try { expect(await readToEnd(source, () => { heard = true; }, 1600)).toBe(true); } finally { source.close?.(); }
  expect(heard).toBe(true);
}, 20_000);


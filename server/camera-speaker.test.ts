import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createCameraSpeaker } from "./camera-speaker.js";

// Synthetic values: a hash of no real password, and an address reserved for documentation (TEST-NET-1).
const hash = "A".repeat(64);
let server: Server;
let base: string;
let speaker: ReturnType<typeof createCameraSpeaker>;
let go2rtc: ReturnType<typeof vi.fn<typeof fetch>>;
let streamReplies: number;
let recordingReplies: number;
const recording = "https://upload.wikimedia.org/wikipedia/commons/a/ab/Calm_piano.wav";
// Two seconds of a quiet tone as a WAV file, standing in for a Commons recording.
function wav() {
  const rate = 16_000;
  const data = Buffer.alloc(rate * 4);
  for (let index = 0; index < rate * 2; index++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * index / rate) * 3000), index * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8); header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function start(stream = "camera_sha256") {
  go2rtc = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url === recording) return init?.method === "HEAD" ? new Response(null, { status: recordingReplies }) : new Response(wav());
    if (url.endsWith("/api")) return new Response("{}", { status: 200 });
    // go2rtc echoes the camera address with its password hash.
    return new Response(JSON.stringify({ producers: [{ url: `tapo://admin:${hash}@192.0.2.10` }] }), { status: streamReplies });
  });
  const app = express();
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  speaker = createCameraSpeaker({ stream, apiPassword: "test-api-password", soundBase: `${base}/sound` }, go2rtc, id => id === "found-1" ? { url: recording, title: "Calm piano" } : null);
  app.use(express.json());
  app.use("/admin", speaker.admin);
  app.use("/sound", speaker.sound);
}
beforeEach(async () => { streamReplies = 200; recordingReplies = 200; await start(); });
afterEach(async () => { speaker.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

function admin(method: "GET" | "POST", body?: unknown, headers: Record<string, string> = { Host: "localhost:3001", "X-Nightwatch-Local": "1" }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/admin`, { method, headers: { ...headers, "Content-Type": "application/json" } }, response => {
      let text = ""; response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, text }));
    });
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const lastSource = () => new URL(String(go2rtc.mock.calls.at(-1)![0])).searchParams;

it("accepts sound commands only from the local manager", async () => {
  expect((await admin("POST", { action: "dog-music" }, {})).status).toBe(403);
  expect(JSON.parse((await admin("GET")).text)).toEqual({ configured: true, playing: null, volume: "loud" });
});

it("changes the volume without starting or stopping a sound", async () => {
  const calls = go2rtc.mock.calls.length;
  const quieter = await admin("POST", { volume: "normal" });
  expect(quieter.status).toBe(200);
  expect(JSON.parse(quieter.text)).toMatchObject({ playing: null, volume: "normal" });
  expect((await admin("POST", { volume: "deafening" })).status).toBe(400);
  expect(JSON.parse((await admin("GET")).text)).toMatchObject({ volume: "normal" });
  expect(go2rtc.mock.calls.length).toBe(calls);
});

it("sends the camera a one-time live sound link and never passes on go2rtc's reply", async () => {
  const played = await admin("POST", { action: "dog-music" });
  expect(played.status).toBe(200);
  expect(played.text).not.toContain(hash);
  // Every go2rtc call carries its API login, which keeps web pages from driving go2rtc.
  for (const [, init] of go2rtc.mock.calls) expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${Buffer.from("nurserai:test-api-password").toString("base64")}`);
  const params = lastSource();
  expect(params.get("dst")).toBe("camera_sha256");
  const link = params.get("src")!.match(/^ffmpeg:(.+\.wav)#audio=pcma$/)![1];
  expect(link.startsWith(`${base}/sound/`)).toBe(true);
  const audio = await fetch(link);
  expect(audio.headers.get("content-type")).toBe("audio/wav");
  const reader = audio.body!.getReader();
  const { value } = await reader.read();
  expect(Buffer.from(value!).toString("ascii", 0, 4)).toBe("RIFF");
  expect(JSON.parse((await admin("GET")).text).playing).toBe("dog-music");
  expect((await admin("POST", { action: "stop" })).status).toBe(200);
  // Stopping ends the live stream the camera was reading.
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read());
  expect(lastSource().get("src")).toBe("");
  expect((await fetch(link)).status).toBe(404);
  expect(JSON.parse((await admin("GET")).text).playing).toBeNull();
});

it("counts the camera's microphone as muted only while the camera is reading a sound", async () => {
  expect((await admin("POST", { action: "dog-music" })).status).toBe(200);
  // Asked to play, but the camera has not started reading yet.
  expect(speaker.isPlaying()).toBe(false);
  const link = lastSource().get("src")!.match(/^ffmpeg:(.+\.wav)#audio=pcma$/)![1];
  const reader = (await fetch(link)).body!.getReader();
  await reader.read();
  expect(speaker.isPlaying()).toBe(true);
  // The camera's reader drops off without coming back: the sound is still chosen, but the microphone is live again.
  await reader.cancel();
  await vi.waitFor(() => expect(speaker.isPlaying()).toBe(false));
  expect(JSON.parse((await admin("GET")).text).playing).toBe("dog-music");
});

it("reports a camera that refuses playback without leaking details", async () => {
  streamReplies = 500;
  const failed = await admin("POST", { action: "dog-noise" });
  expect(failed.status).toBe(503);
  expect(failed.text).toContain("Third-Party Compatibility");
  expect(failed.text).not.toContain(hash);
  expect(JSON.parse((await admin("GET")).text).playing).toBeNull();
});

it("rejects unknown sounds and cameras without a speaker stream", async () => {
  expect((await admin("POST", { action: "bark" })).status).toBe(400);
  speaker.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await start("");
  expect((await admin("POST", { action: "dog-music" })).status).toBe(409);
});

it("plays a recording from a recent sound search, looked up by its ID", async () => {
  expect((await admin("POST", { sound: "https://example.com/other.mp3" })).status).toBe(404);
  const played = await admin("POST", { sound: "found-1" });
  expect(played.status).toBe(200);
  expect(JSON.parse(played.text)).toEqual({ playing: "found", volume: "loud", title: "Calm piano" });
  expect(JSON.parse((await admin("GET")).text)).toEqual({ configured: true, playing: "found", volume: "loud", title: "Calm piano" });
  // The camera is sent a local one-time link, never the recording's address.
  const source = lastSource().get("src")!;
  expect(source).not.toContain("wikimedia");
  const audio = await fetch(source.match(/^ffmpeg:(.+\.wav)#audio=pcma$/)![1]);
  const reader = audio.body!.getReader();
  let bytes = 0;
  let heard = false;
  for (let chunk = await reader.read(); !chunk.done && bytes < 80_000; chunk = await reader.read()) {
    const pcm = Buffer.from(chunk.value!);
    if (bytes >= 44) for (let index = 0; index + 1 < pcm.length; index += 2) heard ||= pcm.readInt16LE(index) !== 0;
    bytes += pcm.length;
  }
  expect(heard).toBe(true);
  expect((await admin("POST", { action: "stop" })).status).toBe(200);
  await reader.cancel();
}, 20_000);

it("reports a recording that cannot be reached before involving the camera", async () => {
  recordingReplies = 404;
  const failed = await admin("POST", { sound: "found-1" });
  expect(failed.status).toBe(503);
  expect(failed.text).toContain("could not be reached");
  expect(go2rtc.mock.calls.some(([input]) => String(input).includes("src=ffmpeg"))).toBe(false);
});

import express, { Router } from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isComfortAction, type ComfortAction } from "../shared/comfort.js";
import { applyVolume, cameraSampleRate, createSoundSource, toPcm16, wavHeader } from "./comfort-audio.js";
import { speakerVolumes, type SpeakerVolume } from "../shared/comfort.js";
import { requireLocalManager } from "./manager-api.js";
import { createRemoteSource, remoteSoundReachable } from "./remote-sound.js";
import type { PlayableSound } from "./sound-finder.js";

export interface CameraSpeakerOptions {
  /** The starting volume; the manager can change it while a sound plays. Defaults to loud. */
  volume?: SpeakerVolume;
  /** go2rtc stream name for the camera, such as camera_sha256. */
  stream?: string;
  api?: string;
  /** go2rtc API password. Without one, any web page could drive go2rtc through the browser. */
  apiPassword?: string;
  bin?: string;
  config?: string;
  /** Where go2rtc's ffmpeg fetches the live sound, e.g. http://127.0.0.1:3001/api/camera-sound. */
  soundBase: string;
}

type Playback = { kind: "comfort"; action: Exclude<ComfortAction, "stop"> } | { kind: "found"; sound: PlayableSound };

// Plays comfort sounds through a camera's own speaker. go2rtc speaks the camera's two-way audio protocol,
// fetches a live sound stream from this server and converts it to the camera's format.
// Found sounds are looked up by the ID of a recent Nimble search, never by an address from the page.
export function createCameraSpeaker(options: CameraSpeakerOptions, fetcher: typeof fetch = fetch, findSound: (id: string) => PlayableSound | null = () => null, onPlay: (sound: string) => void = () => {}) {
  const stream = options.stream?.trim() ?? "";
  const api = (options.api || "http://127.0.0.1:1984").replace(/\/$/, "");
  const headers: Record<string, string> = options.apiPassword ? { Authorization: `Basic ${Buffer.from(`nurserai:${options.apiPassword}`).toString("base64")}` } : {};
  const admin = Router();
  const sound = Router();
  const links = new Map<string, Playback>();
  const streams = new Set<() => void>();
  let playing: { playback: Playback; token: string } | null = null;
  let volume: SpeakerVolume = options.volume ?? "loud";
  let go2rtc: ChildProcess | null = null;
  // Commands run one at a time, so two quick clicks never leave two sources on the camera.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>) => { const run = queue.then(task, task); queue = run.catch(() => undefined); return run; };

  const reachable = () => fetcher(`${api}/api`, { headers, signal: AbortSignal.timeout(1000) }).then(response => response.ok, () => false);
  async function ensureGo2rtc() {
    if (await reachable()) return;
    if (!options.bin || !options.config) throw new Error("Start go2rtc, or set GO2RTC_BIN and GO2RTC_CONFIG in .env.");
    if (!go2rtc) {
      // go2rtc logs the camera address with its password hash, so its output is discarded, and it gets no .env secrets.
      const child = spawn(options.bin, ["-config", options.config], { stdio: "ignore", env: { PATH: process.env.PATH ?? "" } });
      child.once("error", () => { if (go2rtc === child) go2rtc = null; });
      child.once("exit", () => { if (go2rtc === child) go2rtc = null; });
      go2rtc = child;
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (await reachable()) return;
    }
    throw new Error("go2rtc did not start. Check GO2RTC_BIN, GO2RTC_CONFIG and GO2RTC_API_PASSWORD in .env.");
  }
  // go2rtc's replies repeat the camera address with its password hash, so they are never passed on.
  async function send(src: string) {
    const response = await fetcher(`${api}/api/streams?dst=${encodeURIComponent(stream)}&src=${encodeURIComponent(src)}`, { method: "POST", headers, signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel();
    return response.ok;
  }
  async function stop() {
    playing = null;
    links.clear();
    for (const finish of [...streams]) finish();
    // An empty source ends playback on the camera. It is always sent, because go2rtc can keep playing after this server lost track.
    if (stream) await send("").catch(() => false);
  }
  async function play(playback: Playback | "stop") {
    await stop();
    if (playback === "stop") return;
    await ensureGo2rtc();
    if (playback.kind === "found" && !await remoteSoundReachable(playback.sound.url, fetcher)) throw new Error("That recording could not be reached. Try another one.");
    const token = randomBytes(24).toString("base64url");
    links.set(token, playback);
    playing = { playback, token };
    if (!await send(`ffmpeg:${options.soundBase}/${token}.wav#audio=pcma`).catch(() => false)) {
      await stop();
      throw new Error("The camera speaker did not start. Check that the camera is online and Third-Party Compatibility is on in the Tapo app.");
    }
    // PetAnalytics compares the dog's activity before and after each sound.
    onPlay(playback.kind === "comfort" ? playback.action : `found:${playback.sound.title.replace(/[^\p{L}\p{N} ,.'&()-]/gu, "").slice(0, 80)}`);
  }

  admin.use(requireLocalManager);
  const status = () => {
    const current = playing?.playback;
    return { playing: current ? current.kind === "comfort" ? current.action : "found" : null, volume, ...(current?.kind === "found" ? { title: current.sound.title } : {}) };
  };
  admin.get("/", (_request, response) => response.json({ configured: Boolean(stream), ...status() }));
  admin.post("/", express.json({ limit: "1kb" }), async (request, response) => {
    if (!stream) return response.status(409).json({ error: "Set CAMERA_SPEAKER_STREAM in .env to play sound through the camera." });
    const { action, sound, volume: level } = request.body ?? {};
    // A volume change applies to the sound playing now, and never starts or stops one.
    if (level !== undefined) {
      if (!speakerVolumes.includes(level)) return response.status(400).json({ error: "Choose soft, normal or loud." });
      volume = level;
      return response.json({ configured: true, ...status() });
    }
    let playback: Playback | "stop";
    if (typeof sound === "string") {
      const found = findSound(sound);
      if (!found) return response.status(404).json({ error: "That sound is no longer listed. Search again." });
      playback = { kind: "found", sound: found };
    } else if (isComfortAction(action)) playback = action === "stop" ? "stop" : { kind: "comfort", action };
    else return response.status(400).json({ error: "Choose a sound action." });
    try {
      await serialize(() => play(playback));
      return response.json(status());
    } catch (reason) {
      return response.status(503).json({ error: reason instanceof Error ? reason.message : "The camera speaker did not start." });
    }
  });

  // go2rtc's ffmpeg reads this live, so audio is written at real-time pace, half a second ahead.
  sound.get("/:file", (request, response) => {
    const token = String(request.params.file).replace(/\.wav$/, "");
    const link = links.get(token);
    if (!link) return response.status(404).end();
    const source = link.kind === "comfort" ? createSoundSource(link.action) : createRemoteSource(link.sound.url, fetcher);
    const started = Date.now();
    let sent = 0;
    let waiting = false;
    let done = false;
    const finish = (ended = false) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      source.close?.();
      streams.delete(finish);
      if (!response.writableEnded && !response.destroyed) response.end();
      // Only a sound that played to its end frees the speaker; a reader that drops off may be one of several.
      if (ended && playing?.token === token) { playing = null; links.delete(token); }
    };
    const pump = () => {
      if (response.writableEnded || response.destroyed) return finish();
      if (waiting) return;
      const due = Math.floor(((Date.now() - started) / 1000 + 0.5) * cameraSampleRate);
      // After the computer sleeps, resume near real time rather than synthesising the missed minutes at once.
      if (due - sent > cameraSampleRate) sent = due - cameraSampleRate / 2;
      if (due <= sent) return;
      const chunk = source.read(due - sent);
      if (!chunk) return finish(true);
      sent += chunk.length;
      // A stalled reader pauses the stream instead of buffering audio without limit.
      if (!response.write(toPcm16(applyVolume(chunk, volume)))) { waiting = true; response.once("drain", () => { waiting = false; }); }
    };
    response.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store" });
    response.write(wavHeader());
    const timer = setInterval(pump, 100);
    streams.add(finish);
    response.on("error", () => finish());
    request.on("close", () => finish());
    pump();
  });

  return {
    admin,
    sound,
    configured: Boolean(stream),
    /** True while the camera is reading a sound from DogMaAI, which mutes the camera's microphone. A sound whose reader
     *  dropped off without coming back is not playing, so it does not keep the microphone counted as muted. */
    isPlaying: () => playing !== null && streams.size > 0,
    dispose() {
      void stop();
      go2rtc?.kill();
      go2rtc = null;
    }
  };
}

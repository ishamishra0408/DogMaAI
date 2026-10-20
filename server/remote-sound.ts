import { spawn } from "node:child_process";
import { cameraSampleRate, type SoundSource } from "./comfort-audio.js";

export const wikimediaUserAgent = "DogMaAI/0.1 (local dog comfort app)";
export const remoteSoundLimitSeconds = 30 * 60;
const bytesPerSecond = cameraSampleRate * 2;

// Recordings are fetched only from Wikimedia Commons' file host.
export function isCommonsUpload(address: string) {
  try {
    const url = new URL(address);
    return url.protocol === "https:" && url.hostname === "upload.wikimedia.org" && url.pathname.startsWith("/wikipedia/commons/") && !url.username && !url.password && !url.port;
  } catch {
    return false;
  }
}

// Checks a recording can be downloaded before the camera is told to play it.
export async function remoteSoundReachable(address: string, fetcher: typeof fetch = fetch) {
  if (!isCommonsUpload(address)) return false;
  try {
    const response = await fetcher(address, { method: "HEAD", headers: { "User-Agent": wikimediaUserAgent }, redirect: "error", signal: AbortSignal.timeout(10_000) });
    return response.ok;
  } catch {
    return false;
  }
}

// Node downloads the recording and ffmpeg only decodes what it is given, so ffmpeg never opens an address itself.
// The level matches the built-in sounds, the start fades in over 3 seconds, and playback stops after 30 minutes.
export function createRemoteSource(address: string, fetcher: typeof fetch = fetch, ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg", stallMs = 20_000): SoundSource {
  if (!isCommonsUpload(address)) throw new Error("Only Wikimedia Commons recordings can be played.");
  const download = new AbortController();
  const decoder = spawn(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vn", "-ac", "1",
    "-af", "loudnorm=I=-20:TP=-2:LRA=11,afade=t=in:d=3", "-ar", String(cameraSampleRate),
    "-t", String(remoteSoundLimitSeconds), "-f", "s16le", "pipe:1"
  ], { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH ?? "" } });
  const chunks: Buffer[] = [];
  let buffered = 0;
  let ended = false;
  // Decoding pauses once 20 seconds are waiting, so a long recording is never held in memory whole.
  decoder.stdout.on("data", (chunk: Buffer) => { chunks.push(chunk); buffered += chunk.length; if (buffered > 20 * bytesPerSecond) decoder.stdout.pause(); });
  decoder.stdout.on("end", () => { ended = true; });
  decoder.on("error", () => { ended = true; });
  decoder.on("close", () => { ended = true; download.abort(); });
  // ffmpeg stops reading at the time limit; the write error that follows is expected.
  decoder.stdin.on("error", () => {});
  const drained = () => new Promise<void>(resolve => {
    if (decoder.stdin.destroyed) return resolve();
    const done = () => { decoder.stdin.off("drain", done); decoder.stdin.off("close", done); resolve(); };
    decoder.stdin.on("drain", done);
    decoder.stdin.on("close", done);
  });
  // A download that sends nothing for 20 seconds is given up, so the camera never plays silence while the page says Playing.
  // The timer runs only while waiting on the network, not while playback holds the download back.
  let stalled: ReturnType<typeof setTimeout> | undefined;
  const waitForNetwork = () => { clearTimeout(stalled); stalled = setTimeout(() => { download.abort(); decoder.stdin.destroy(); }, stallMs); };
  void (async () => {
    waitForNetwork();
    try {
      const response = await fetcher(address, { headers: { "User-Agent": wikimediaUserAgent }, redirect: "error", signal: download.signal });
      if (!response.ok || !response.body) throw new Error("The recording could not be downloaded.");
      for await (const piece of response.body) {
        clearTimeout(stalled);
        if (decoder.stdin.destroyed) break;
        if (!decoder.stdin.write(piece)) await drained();
        waitForNetwork();
      }
      decoder.stdin.end();
    } catch {
      decoder.stdin.destroy();
    } finally {
      clearTimeout(stalled);
    }
  })();
  return {
    read(frames) {
      const available = buffered - (buffered % 2);
      // Silence while the first seconds download keeps the camera's stream open.
      if (!available) return ended ? null : new Float32Array(frames);
      const take = Math.min(frames * 2, available);
      const bytes = Buffer.allocUnsafe(take);
      for (let filled = 0; filled < take;) {
        const head = chunks[0];
        const count = Math.min(head.length, take - filled);
        head.copy(bytes, filled, 0, count);
        filled += count;
        if (count === head.length) chunks.shift(); else chunks[0] = head.subarray(count);
      }
      buffered -= take;
      if (buffered < 10 * bytesPerSecond && decoder.stdout.isPaused()) decoder.stdout.resume();
      const samples = new Float32Array(take / 2);
      for (let index = 0; index < samples.length; index++) samples[index] = bytes.readInt16LE(index * 2) / 32768;
      return samples;
    },
    close() {
      clearTimeout(stalled);
      download.abort();
      decoder.kill();
    }
  };
}

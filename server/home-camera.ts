import { spawn, type ChildProcess } from "node:child_process";

export interface HomeCameraSource {
  readonly configured: boolean;
  /** Starts reading the camera and returns a function that stops it. With onAudio, the microphone arrives as 16 kHz samples. */
  start(onFrame: (jpeg: Buffer) => void, onProblem: (message: string | null) => void, onAudio?: (samples: Int16Array) => void): () => void;
}
export const audioRate = 16_000;

const maxPendingBytes = 4 * 1024 * 1024;
const stallMs = 15_000;

// ffmpeg writes whole JPEGs back to back. Header segments are skipped by length, so only the
// entropy-coded image data is searched for the end marker, where 0xFF 0xD9 cannot occur.
export function createJpegSplitter(onFrame: (jpeg: Buffer) => void) {
  let pending: Buffer = Buffer.alloc(0);
  function frameEnd(start: number): number | null {
    let index = start + 2;
    while (index + 4 <= pending.length) {
      if (pending[index] !== 0xff) return -1;
      const marker = pending[index + 1];
      if (marker === 0xd9) return index + 2;
      if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { index += marker === 0xff ? 1 : 2; continue; }
      const segmentEnd = index + 2 + pending.readUInt16BE(index + 2);
      if (marker !== 0xda) { index = segmentEnd; continue; }
      const end = pending.indexOf(Buffer.from([0xff, 0xd9]), segmentEnd);
      return end < 0 ? null : end + 2;
    }
    return null;
  }
  return (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { pending = pending.at(-1) === 0xff ? pending.subarray(-1) : Buffer.alloc(0); return; }
      const end = frameEnd(start);
      if (end === null) {
        pending = pending.subarray(start);
        if (pending.length > maxPendingBytes) pending = Buffer.alloc(0);
        return;
      }
      if (end < 0) { pending = pending.subarray(start + 2); continue; }
      onFrame(Buffer.from(pending.subarray(start, end)));
      pending = pending.subarray(end);
    }
  };
}

// ffmpeg writes the microphone as 16-bit samples; a chunk can end halfway through one.
export function createPcmReader(onSamples: (samples: Int16Array) => void) {
  let carry: Buffer | null = null;
  return (chunk: Buffer) => {
    const data = carry ? Buffer.concat([carry, chunk]) : chunk;
    const usable = data.length - (data.length % 2);
    carry = usable < data.length ? Buffer.from(data.subarray(usable)) : null;
    if (!usable) return;
    const samples = new Int16Array(usable / 2);
    for (let index = 0; index < samples.length; index++) samples[index] = data.readInt16LE(index * 2);
    onSamples(samples);
  };
}

// With audio, a second output carries the camera's microphone to file descriptor 3, from the same camera connection.
export function ffmpegArgs(source: string, audio = false): string[] {
  const input = /^rtsps?:\/\//i.test(source) ? ["-rtsp_transport", "tcp", "-i", source]
    : /^https?:\/\//i.test(source) ? ["-i", source]
    // A local video file loops in real time as a stand-in camera for testing.
    : ["-re", "-stream_loop", "-1", "-i", source];
  return ["-hide_banner", "-loglevel", "error", "-nostdin", ...input, "-an", "-vf", "fps=4,scale='min(640,iw)':-2", "-q:v", "7", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1",
    ...(audio ? ["-map", "0:a:0?", "-ac", "1", "-ar", String(audioRate), "-f", "s16le", "pipe:3"] : [])];
}

export interface StreamProblem { message: string; retry: boolean }
const notAnswering: StreamProblem = { message: "The camera did not answer. Check that it is on and on the same Wi-Fi as this computer.", retry: true };
const reconnecting: StreamProblem = { message: "The camera stream stopped. Reconnecting...", retry: true };

// ffmpeg errors can echo the camera address with its password, so only fixed messages leave this module.
// Only the final line is read, without its "[rtsp @ 0x…]" prefix or address, so look-alike digits cannot mislead.
export function describeStreamProblem(log: string): StreamProblem {
  const line = (log.trim().split("\n").at(-1) ?? "").replace(/^\[[^\]]*\]\s*/, "").replace(/^[a-z][a-z0-9+.-]*:\/\/\S*:\s*/i, "");
  if (/\b401\b|unauthorized|authorization failed/i.test(line)) return { message: "The camera rejected the login. Check the Camera Account username and password in CAMERA_RTSP_URL, then restart DogMaAI.", retry: false };
  if (/no such file|invalid data|protocol not found|invalid argument|could not find codec/i.test(line)) return { message: "CAMERA_RTSP_URL is not a readable video stream. Check the address in .env, then restart DogMaAI.", retry: false };
  if (/\b404\b|not found/i.test(line)) return { message: "The camera has no stream at that address. Tapo cameras use /stream1 or /stream2.", retry: false };
  if (/connection refused/i.test(line)) return { message: "The camera refused the connection. Check the IP address and that the camera offers RTSP on port 554.", retry: true };
  // macOS reports blocked Local Network access as an unreachable host.
  if (/no route to host/i.test(line)) return { message: "This computer cannot reach the camera. Check the IP address. On macOS, allow Local Network access for the app running DogMaAI in System Settings > Privacy & Security > Local Network.", retry: true };
  if (/timed out|host is down|network is unreachable|connection reset/i.test(line)) return notAnswering;
  return reconnecting;
}

const decoded = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
// Removes the address's exact username and password, in raw and decoded form, whatever characters they contain.
export function redactStreamCredentials(text: string, address = ""): string {
  const start = address.indexOf("://") + 3;
  const end = address.lastIndexOf("@");
  const userinfo = start > 2 && end > start ? address.slice(start, end) : "";
  const colon = userinfo.indexOf(":");
  const secrets = [userinfo, colon < 0 ? userinfo : userinfo.slice(0, colon), colon < 0 ? "" : userinfo.slice(colon + 1)].flatMap(value => [value, decoded(value)]);
  let result = text;
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join("***");
  return result.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]*@/gi, "$1***@");
}

export function createHomeCamera(source = "", ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg"): HomeCameraSource {
  const address = source.trim();
  return {
    configured: Boolean(address),
    start(onFrame, onProblem, onAudio) {
      let stopped = false;
      // A source without sound, such as a test video, makes ffmpeg refuse the audio output, so it is dropped.
      let audio = Boolean(onAudio);
      let child: ChildProcess | null = null;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let attempt = 0;
      let lastActivity = Date.now();
      let stalled = false;
      const run = () => {
        if (stopped) return;
        let log = "";
        let finished = false;
        let received = false;
        stalled = false;
        lastActivity = Date.now();
        // ffmpeg needs only PATH; keys and other settings from .env stay out of its environment.
        const process = spawn(ffmpegPath, ffmpegArgs(address, audio), { stdio: ["ignore", "pipe", "pipe", audio ? "pipe" : "ignore"], env: { PATH: globalThis.process.env.PATH ?? "" } });
        child = process;
        if (audio && onAudio) (process.stdio[3] as NodeJS.ReadableStream | null)?.on("data", createPcmReader(onAudio));
        const finish = (problem: StreamProblem) => {
          if (finished) return;
          finished = true;
          if (child === process) child = null;
          if (stopped) return;
          onProblem(problem.message);
          const detail = redactStreamCredentials(log.trim().split("\n").at(-1) ?? "", address);
          console.warn(`[home camera] ${problem.message}${detail ? ` ffmpeg: ${detail}` : ""}`);
          // Login and address errors repeat until the settings change, so they are not retried.
          if (problem.retry) retry = setTimeout(run, Math.min(30_000, 2_000 * 2 ** attempt++));
        };
        process.stdout?.on("data", createJpegSplitter(jpeg => {
          lastActivity = Date.now();
          attempt = 0;
          received = true;
          onProblem(null);
          onFrame(jpeg);
        }));
        process.stderr?.on("data", (chunk: Buffer) => { log = (log + chunk.toString()).slice(-4000); });
        process.on("error", error => finish((error as NodeJS.ErrnoException).code === "ENOENT" ? { message: "ffmpeg is not installed. Install it with: brew install ffmpeg", retry: false } : { message: "The camera reader could not start.", retry: true }));
        // A stream that already delivered frames had working settings, so its errors are treated as dropouts.
        process.on("close", () => {
          if (audio && !received && !stalled && /does not contain any stream/i.test(log)) {
            audio = false; finished = true;
            if (child === process) child = null;
            console.info("[home camera] This camera sends no sound, so crying cannot be heard. Video continues.");
            if (!stopped) run();
            return;
          }
          finish(stalled ? notAnswering : received ? reconnecting : describeStreamProblem(redactStreamCredentials(log, address)));
        });
      };
      // A dropped Wi-Fi link can leave ffmpeg waiting forever without an error.
      const watchdog = setInterval(() => {
        if (child && Date.now() - lastActivity > stallMs) { stalled = true; child.kill("SIGKILL"); }
      }, 5_000);
      watchdog.unref();
      run();
      return () => {
        stopped = true;
        clearTimeout(retry);
        clearInterval(watchdog);
        child?.kill("SIGKILL");
        child = null;
      };
    }
  };
}

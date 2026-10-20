import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHomeCamera, createJpegSplitter, createPcmReader, describeStreamProblem, ffmpegArgs, redactStreamCredentials } from "./home-camera.js";

// A header segment that contains the end-of-image bytes, followed by scan data with byte stuffing.
const frame = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x06, 0xaa, 0xff, 0xd9, 0xbb, 0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd9]);
const secret = "rtsp://dogcam:p@ss@192.168.1.20:554/stream2";

describe("JPEG stream splitting", () => {
  it("returns whole frames across any chunk boundary and skips noise", () => {
    const stream = Buffer.concat([Buffer.from([0x00, 0x11, 0xff]), frame, Buffer.from([0x42]), frame]);
    for (const size of [1, 2, 3, 7, stream.length]) {
      const frames: Buffer[] = [];
      const split = createJpegSplitter(jpeg => frames.push(jpeg));
      for (let index = 0; index < stream.length; index += size) split(stream.subarray(index, index + size));
      expect(frames).toEqual([frame, frame]);
    }
  });
});

describe("camera stream safety", () => {
  it("passes the address as one argument and reads RTSP over TCP", () => {
    const rtsp = ffmpegArgs(secret);
    expect(rtsp.slice(rtsp.indexOf("-rtsp_transport"), rtsp.indexOf("-i") + 2)).toEqual(["-rtsp_transport", "tcp", "-i", secret]);
    expect(ffmpegArgs("/tmp/kennel.mp4")).toEqual(expect.arrayContaining(["-stream_loop", "-1", "-i", "/tmp/kennel.mp4"]));
  });
  it("maps ffmpeg errors to fixed messages and retries only dropouts", () => {
    const cases: [string, RegExp, boolean][] = [
      [`[rtsp @ 0x7fe20a008e00] method DESCRIBE failed: 401 Unauthorized\n${secret}: Server returned 401 Unauthorized (authorization failed)`, /rejected the login/, false],
      [`${secret}: Server returned 404 Not Found`, /stream1 or \/stream2/, false],
      [`${secret}: Protocol not found`, /not a readable video stream/, false],
      ["Connection to tcp://192.168.1.20:554?timeout=0 failed: Connection refused", /refused/, true],
      ["Connection to tcp://192.168.1.20:554?timeout=0 failed: Operation timed out", /did not answer/, true],
      [`${secret}: No route to host`, /Local Network/, true],
      ["", /Reconnecting/, true]
    ];
    for (const [log, expected, retry] of cases) {
      const problem = describeStreamProblem(redactStreamCredentials(log, secret));
      expect(problem.message).toMatch(expected);
      expect(problem.retry).toBe(retry);
      expect(problem.message).not.toContain("p@ss");
    }
  });
  it("ignores look-alike digits in passwords, pointers and stream paths", () => {
    const address = "rtsp://dogcam:abc404xy@192.168.1.20:554/Streaming/Channels/401";
    expect(describeStreamProblem(redactStreamCredentials(`${address}: Connection refused`, address)).message).toMatch(/refused/);
    expect(describeStreamProblem("[rtsp @ 0x14010c0a0] Server returned 404 Not Found").message).toMatch(/stream1 or \/stream2/);
    expect(describeStreamProblem(`${address}: Server returned 404 Not Found`).message).toMatch(/stream1 or \/stream2/);
  });
  it("removes the exact username and password whatever characters they contain", () => {
    const cases: [string, string][] = [[secret, "p@ss"], ["rtsp://dogcam:pa/ss word@192.168.1.20:554/stream2", "pa/ss word"], ["rtsp://dogcam:p%40ss%2Fw@192.168.1.20:554/stream2", "p@ss/w"]];
    for (const [address, password] of cases) {
      const redacted = redactStreamCredentials(`${address}: Server returned 401 (sent ${password})`, address);
      expect(redacted).not.toContain(password);
      expect(redacted).not.toContain("dogcam");
      expect(redacted).toContain("192.168.1.20:554/stream2: Server returned 401");
    }
  });
});

describe("camera reader lifecycle", () => {
  let directory = "";
  afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = ""; });
  it("reports a missing ffmpeg instead of failing silently", async () => {
    const problems: (string | null)[] = [];
    const stop = createHomeCamera(secret, "/nonexistent/ffmpeg").start(() => {}, problem => problems.push(problem));
    await vi.waitFor(() => expect(problems).toContain("ffmpeg is not installed. Install it with: brew install ffmpeg"));
    stop();
  });
  it("delivers frames from the reader and stops it on request", async () => {
    directory = mkdtempSync(join(tmpdir(), "dogmaai-camera-"));
    const fake = join(directory, "ffmpeg");
    const octal = [...frame].map(byte => `\\${byte.toString(8).padStart(3, "0")}`).join("");
    writeFileSync(fake, `#!/bin/sh\nprintf '${octal}'\nexec sleep 30\n`);
    chmodSync(fake, 0o755);
    const frames: Buffer[] = [];
    const problems: (string | null)[] = [];
    const stop = createHomeCamera("/tmp/kennel.mp4", fake).start(jpeg => frames.push(jpeg), problem => problems.push(problem));
    await vi.waitFor(() => expect(frames).toEqual([frame]));
    stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(problems.filter(Boolean)).toEqual([]);
  });

  const fakeCamera = (script: string) => {
    directory = mkdtempSync(join(tmpdir(), "dogmaai-camera-"));
    const fake = join(directory, "ffmpeg");
    writeFileSync(fake, `#!/bin/sh\n${script}\n`);
    chmodSync(fake, 0o755);
    return fake;
  };
  const octal = (bytes: Iterable<number>) => [...bytes].map(byte => `\\${byte.toString(8).padStart(3, "0")}`).join("");

  it("passes the microphone's samples on from the second output", async () => {
    // Two samples, 1 and -2, on file descriptor 3, then a frame.
    const fake = fakeCamera(`printf '\\001\\000\\376\\377' >&3\nprintf '${octal(frame)}'\nexec sleep 30`);
    const heard: number[] = [];
    const frames: Buffer[] = [];
    const stop = createHomeCamera("/tmp/kennel.mp4", fake).start(jpeg => frames.push(jpeg), () => {}, samples => heard.push(...samples));
    await vi.waitFor(() => { expect(heard).toEqual([1, -2]); expect(frames).toEqual([frame]); });
    stop();
  });

  it("keeps the video going when the source has no sound", async () => {
    // Asked for sound, this camera has none, as ffmpeg reports; asked again without it, the frame arrives.
    const fake = fakeCamera(`case "$*" in *s16le*) echo 'Output file #1 does not contain any stream' >&2; exit 1;; esac\nprintf '${octal(frame)}'\nexec sleep 30`);
    const frames: Buffer[] = [];
    const problems: (string | null)[] = [];
    const stop = createHomeCamera("/tmp/kennel.mp4", fake).start(jpeg => frames.push(jpeg), problem => problems.push(problem), () => {});
    await vi.waitFor(() => expect(frames).toEqual([frame]));
    stop();
    expect(problems.filter(Boolean)).toEqual([]);
  });
});

describe("camera microphone", () => {
  it("adds the microphone as a second output only when asked", () => {
    expect(ffmpegArgs(secret, true).slice(-10)).toEqual(["pipe:1", "-map", "0:a:0?", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:3"]);
    expect(ffmpegArgs(secret)).not.toContain("pipe:3");
  });

  it("reads 16-bit samples that are split across chunks", () => {
    const heard: number[] = [];
    const read = createPcmReader(samples => heard.push(...samples));
    read(Buffer.from([1, 0, 0xfe]));
    read(Buffer.from([0xff, 3]));
    read(Buffer.from([0]));
    expect(heard).toEqual([1, -2, 3]);
  });
});

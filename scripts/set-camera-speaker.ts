import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ask, askHidden } from "./prompt.js";

// Lets DogMaAI play sound through a Tapo camera's own speaker using go2rtc, which speaks Tapo's two-way audio protocol.
// That protocol signs in with the TP-Link account password rather than the RTSP Camera Account, so only hashes of it are saved.
// Usage: npm run camera:speaker:setup -- [camera IP]
const hash = (algorithm: "md5" | "sha256", value: string) => createHash(algorithm).update(value).digest("hex").toUpperCase();
const cameraHost = () => { try { return new URL(process.env.CAMERA_RTSP_URL ?? "").hostname; } catch { return ""; } };
// go2rtc refuses ffmpeg 4.x, which some Python distributions put first on PATH, so a Homebrew build is preferred.
const ffmpeg = process.env.GO2RTC_FFMPEG || ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"].find(path => existsSync(path)) || "ffmpeg";

function setEnv(values: Record<string, string>) {
  let text = existsSync(".env") ? readFileSync(".env", "utf8") : "";
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    text = pattern.test(text) ? text.replace(pattern, () => line) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  writeFileSync(".env", text, { mode: 0o600 });
}

try {
  const ip = process.argv[2] || cameraHost() || await ask("Camera IP address (Tapo app → camera settings → Device Info): ");
  if (!/^[a-z0-9.-]+$/i.test(ip)) throw new Error("Enter the camera's IP address, such as 192.168.1.20.");
  console.log(`Camera ${ip}: enter the password you use to sign in to the Tapo app, not the Camera Account.`);
  const password = await askHidden("TP-Link account password (typing is hidden): ");
  if (!password) throw new Error("Enter the TP-Link account password. Nothing was saved.");
  const config = process.env.GO2RTC_CONFIG || join(homedir(), "go2rtc", "go2rtc.yaml");
  // go2rtc's API has no login by default, so any web page could make the browser drive it; a random password closes that.
  const apiPassword = randomBytes(24).toString("base64url");
  mkdirSync(dirname(config), { recursive: true });
  // Newer Tapo firmware signs in with the SHA-256 form and older firmware with MD5; CAMERA_SPEAKER_STREAM selects the one that works.
  // go2rtc serves on every network interface by default, so its API is bound to this computer and its other servers are off.
  writeFileSync(config, [
    "# Written by npm run camera:speaker:setup. These hashes unlock the camera like a password: keep this file private.",
    "api:",
    '  listen: "127.0.0.1:1984"',
    '  username: "nurserai"',
    `  password: ${JSON.stringify(apiPassword)}`,
    "  local_auth: true",
    "rtsp:",
    '  listen: ""',
    "webrtc:",
    '  listen: ""',
    "streams:",
    `  camera_sha256: "tapo://admin:${hash("sha256", password)}@${ip}"`,
    `  camera_md5: "tapo://admin:${hash("md5", password)}@${ip}"`,
    "ffmpeg:",
    `  bin: ${JSON.stringify(ffmpeg)}`,
    ""
  ].join("\n"), { mode: 0o600 });
  chmodSync(config, 0o600);
  const bin = join(homedir(), "go2rtc", "go2rtc");
  setEnv({
    GO2RTC_CONFIG: config,
    GO2RTC_API_PASSWORD: apiPassword,
    ...(process.env.CAMERA_SPEAKER_STREAM ? {} : { CAMERA_SPEAKER_STREAM: "camera_sha256" }),
    ...(process.env.GO2RTC_BIN || !existsSync(bin) ? {} : { GO2RTC_BIN: bin })
  });
  console.log(`Saved go2rtc settings for ${ip} to ${config} and updated .env. Only hashes of the password were written. Restart DogMaAI.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

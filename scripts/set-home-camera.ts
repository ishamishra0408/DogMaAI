import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ask, askHidden } from "./prompt.js";

// Saves CAMERA_RTSP_URL to .env from a prompt, so the password is never typed into an editor or shown.
// Usage: npm run camera:setup -- [camera IP] [stream1|stream2]
try {
  const ip = process.argv[2] || await ask("Camera IP address (Tapo app → camera settings → Device Info): ");
  if (!/^[a-z0-9.-]+$/i.test(ip)) throw new Error("Enter the camera's IP address, such as 192.168.1.20.");
  const stream = process.argv[3] || "stream2";
  if (!/^stream\d+$/.test(stream)) throw new Error("Choose stream1 (full resolution) or stream2 (lower resolution).");
  const username = await ask("Camera Account username: ");
  const password = await askHidden("Camera Account password (typing is hidden): ");
  if (!username || !password) throw new Error("Enter both the Camera Account username and password. Nothing was saved.");
  const line = `CAMERA_RTSP_URL=rtsp://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${ip}:554/${stream}`;
  const existing = existsSync(".env") ? readFileSync(".env", "utf8") : "";
  const updated = /^CAMERA_RTSP_URL=.*$/m.test(existing) ? existing.replace(/^CAMERA_RTSP_URL=.*$/m, () => line) : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(".env", updated, { mode: 0o600 });
  console.log(`Saved the camera at ${ip} (/${stream}) to .env. Restart DogMaAI, then choose Camera → Use home camera.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

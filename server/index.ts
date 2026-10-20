import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { RuntimeSnapshot } from "../shared/api.js";
import { databaseHealth } from "./db.js";
import { MockVisionProvider } from "./providers/mock-vision-provider.js";
import { SessionRuntime } from "./session-runtime.js";
import { allowTailnetOwner, requireOwner, requireThisMac, createManagerRouter, findLiquidVisionModel, localModelEndpoint, type ServiceStates } from "./manager-api.js";
import { watchTailnetOwner } from "./tailnet.js";
import { SqliteSessionPersistence } from "./persistence.js";
import { createAlertEnricher } from "./alert-enrichment.js";
import { createCameraService } from "./camera-api.js";
import { createCameraTunnel } from "./camera-tunnel.js";
import { createHomeCamera } from "./home-camera.js";
import { createCameraSpeaker } from "./camera-speaker.js";
import { createDogDiary, tinybirdStore, type TinybirdTarget } from "./dog-diary.js";
import { createSoundFinder } from "./sound-finder.js";
import { createDogLog } from "./dog-log.js";
import { createAnalyticsRouter } from "./analytics-api.js";
import { createSoundListener } from "./dog-sounds.js";
import { createHearingCheck } from "./hearing.js";
import { loadSoundModel, sampleRate as soundRate, soundModelReady, windowSamples, type SoundModel } from "./yamnet.js";
import { resolve } from "node:path";
import { createTelemetrySink } from "./tinybird-telemetry.js";

// The Tinybird admin token in .env is for npm run tinybird:setup only; the API uses the add-and-read token.
delete process.env.TINYBIRD_ADMIN_TOKEN;

const app = express();
const port = Number(process.env.PORT ?? 3001);
const cameraPort = Number(process.env.CAMERA_PORT ?? 3002);
// The owner's own devices can use DogMaAI through Tailscale's private serve proxy (see MANAGER_SETUP.md).
const tailnet = watchTailnetOwner();
allowTailnetOwner(tailnet.owner);
const cameraTunnel = createCameraTunnel(cameraPort);
// Every service is set up in .env; the manager only shows its state.
function envTinybird(): TinybirdTarget | null {
  const token = (process.env.TINYBIRD_TOKEN ?? process.env.TINY_BIRD_API)?.trim();
  return token ? { token, host: process.env.TINYBIRD_API_URL?.trim() || "https://api.tinybird.co" } : null;
}
// The diary is kept in Tinybird; without it, entries last for this session only.
const tinybird = envTinybird();
const diary = createDogDiary(() => tinybird ? tinybirdStore(tinybird) : null);
// Every camera reading and the owner's events go to Tinybird for PetAnalytics.
const dogLog = createDogLog(() => tinybird);
const nimbleKey = (process.env.NIMBLE_API_KEY ?? process.env.NIMBLE_API)?.trim() || null;
const soundFinder = createSoundFinder(() => nimbleKey);
const alertEnricher = createAlertEnricher();

// Liquid is found on its own: checked at start and every 15 seconds, so starting npm run vision before or after DogMaAI both work.
const liquidBase = localModelEndpoint(`http://localhost:${/^\d+$/.test(process.env.LIQUID_PORT ?? "") ? process.env.LIQUID_PORT : "8080"}/v1`);
let liquidEndpoint: string | null = null;
let liquid: { model: string; verifiedAt: string } | null = null;
let liquidProblem = "Looking for the Liquid vision model…";
async function checkLiquid() {
  try {
    const model = await findLiquidVisionModel(liquidBase);
    if (liquid?.model !== model) liquid = { model, verifiedAt: new Date().toISOString() };
    liquidEndpoint = liquidBase;
  } catch (reason) {
    liquid = null;
    liquidEndpoint = null;
    liquidProblem = reason instanceof Error ? reason.message : "The Liquid vision model is unavailable.";
  }
}
void checkLiquid();
setInterval(() => void checkLiquid(), 15_000).unref();
const serviceStates = (): ServiceStates => ({
  liquid: liquid ? { configured: true, verifiedAt: liquid.verifiedAt, message: `${liquid.model} is running at ${liquidBase}.` } : { configured: false, verifiedAt: null, message: liquidProblem },
  nimble: nimbleKey ? { configured: true, source: "env", message: "Find new sounds and alert guidance use the key in .env." } : { configured: false, message: "Add NIMBLE_API_KEY to .env, then restart DogMaAI." },
  tinybird: tinybird ? { configured: true, source: "env", message: `The dog diary, PetAnalytics and telemetry are saved at ${new URL(tinybird.host.includes("://") ? tinybird.host : `https://${tinybird.host}`).hostname}.` } : { configured: false, message: "Run npm run tinybird:setup, then restart DogMaAI." },
  sound: soundModelReady() ? { configured: !heardProblem(), message: heardProblem() ?? `YAMNet listens for crying and barking in the home camera's microphone, on this computer. Only minutes are saved. ${hearing.describe()}` } : { configured: false, message: "Run npm run sound-model:setup to download the sound model (16 MB), then restart DogMaAI." }
});
// Crying is heard by the YAMNet sound model on this computer, from the home camera's microphone. Only counts per minute
// are kept. Without the model, the camera is read without sound.
let soundModel: Promise<SoundModel> | null = null;
let soundProblem: string | null = soundModelReady() ? null : "Crying is not heard yet: the sound model is not set up. Run npm run sound-model:setup, then restart DogMaAI.";
// Why crying is not being heard or saved: the sound model first, then Tinybird's sound table.
const heardProblem = () => soundProblem ?? dogLog.soundProblem();
const dogName = process.env.DOG_NAME?.trim() || "your dog";
// The live "what it hears" check in Settings, and the crying cut-off tuned to the dog's own marked moments (scores only).
const hearing = createHearingCheck({ file: resolve(process.cwd(), "data", "sound-calibration.json"), dogName, problem: heardProblem });
const soundListener = createSoundListener({
  classify: async samples => {
    soundModel ??= loadSoundModel().catch(error => { soundProblem = "The sound model could not load. Run npm run sound-model:setup again, then restart DogMaAI."; throw error; });
    return (await soundModel).classify(samples);
  },
  record: minute => dogLog.recordSound(minute),
  sampleRate: soundRate,
  windowSize: windowSamples,
  cutoffs: hearing.cutoffs,
  onSecond: hearing.observe,
  // The camera mutes its microphone while it plays DogMaAI's sound, so those seconds are not counted as quiet.
  muted: () => cameraSpeaker.isPlaying()
});
const camera = createCameraService(() => cameraTunnel.origin(), Date.now, () => liquidEndpoint, createHomeCamera(process.env.CAMERA_RTSP_URL), diary.observe, observation => dogLog.recordReading(observation.view, observation.observedAt, observation.camera), soundModelReady() ? samples => { if (!dogLog.soundProblem() || hearing.watching()) soundListener.push(samples); } : undefined);

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
const cameraSpeaker = createCameraSpeaker({ stream: process.env.CAMERA_SPEAKER_STREAM, api: process.env.GO2RTC_API, apiPassword: process.env.GO2RTC_API_PASSWORD, bin: process.env.GO2RTC_BIN, config: process.env.GO2RTC_CONFIG, soundBase: `http://127.0.0.1:${port}/api/camera-sound` }, fetch, id => soundFinder.find(id), sound => void dogLog.recordEvent("comfort", sound, "camera").catch(() => {}));
app.use("/api/manager/camera/speaker", cameraSpeaker.admin);
// Only go2rtc on this computer fetches these one-time sound links: never through Tailscale or the phone gateway.
app.use("/api/camera-sound", requireThisMac, cameraSpeaker.sound);
app.use("/api/manager/camera", camera.admin);
app.use("/api/camera", camera.transport);
app.use("/api/manager/diary", diary.router);
app.use("/api/manager/sounds", soundFinder.router);
app.use("/api/manager/hearing", hearing.router);
app.use("/api/manager", createAnalyticsRouter({ log: dogLog, dogName, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, soundProblem: heardProblem, soundTuning: hearing.tuning }));
app.use("/api/manager", createManagerRouter(serviceStates));

// The phone gateway has no manager, session, credential, or database endpoints.
const phoneGateway = express();
phoneGateway.disable("x-powered-by");
phoneGateway.use((_request, response, next) => {
  response.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Permissions-Policy": "camera=(self), microphone=()", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
  next();
});
phoneGateway.use("/api/camera", camera.transport);
phoneGateway.get("/phone", (_request, response) => response.sendFile(resolve("dist/phone.html")));
phoneGateway.use("/assets", express.static(resolve("dist/assets"), { index: false, dotfiles: "deny" }));
phoneGateway.use((_request, response) => response.status(404).json({ error: "Not found" }));
const phoneServer = phoneGateway.listen(cameraPort, "127.0.0.1");
function closeCamera() { cameraTunnel.stop(); camera.dispose(); cameraSpeaker.dispose(); phoneServer.close(); tailnet.stop(); }
process.once("exit", closeCamera);
// Readings still waiting for their batch get up to two seconds to reach Tinybird before exit.
const shutDown = () => { closeCamera(); void Promise.race([soundListener.flush().then(() => Promise.all([dogLog.flush(), hearing.flush()])), new Promise(resolve => setTimeout(resolve, 2_000))]).finally(() => process.exit(0)); };
process.once("SIGTERM", shutDown);
process.once("SIGINT", shutDown);

const sessions = new Map<string, SessionRuntime>();
const persistence = new SqliteSessionPersistence();
const telemetrySink = createTelemetrySink();

function runtimeFor(id: string): SessionRuntime | undefined {
  return sessions.get(id);
}

function writeSse(response: Response, event: string, data: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.get("/api/health", requireOwner, (_request, response) => {
  response.json({
    status: "ok",
    service: "nightwatch-api",
    database: databaseHealth(),
    timestamp: new Date().toISOString()
  });
});

// The demo clip's monitoring sessions: the owner only, now that the owner's own devices can reach DogMaAI through Tailscale.
app.use("/api/sessions", requireOwner);
app.post("/api/sessions", (_request, response) => {
  const id = randomUUID();
  const runtime = new SessionRuntime(id, new MockVisionProvider(), 2, 32, persistence, alertEnricher, telemetrySink);
  sessions.set(id, runtime);
  response.status(201).json(runtime.snapshot());
});

app.get("/api/sessions/:id/events", (request, response) => {
  const runtime = runtimeFor(request.params.id);
  if (!runtime) return response.status(404).json({ error: "Session not found" });
  const after = Number(request.query.after ?? 0);
  return response.json({ events: runtime.getEvents(Number.isFinite(after) ? after : 0) });
});

app.post("/api/sessions/:id/start", (request, response) => {
  const runtime = runtimeFor(request.params.id);
  if (!runtime) return response.status(404).json({ error: "Session not found" });
  try {
    runtime.start(Number(request.body?.speed ?? 1));
    return response.json(runtime.snapshot());
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : "Unable to start" });
  }
});

app.post("/api/sessions/:id/pause", (request, response) => {
  const runtime = runtimeFor(request.params.id);
  if (!runtime) return response.status(404).json({ error: "Session not found" });
  runtime.pause();
  return response.json(runtime.snapshot());
});

app.post("/api/sessions/:id/reset", (request, response) => {
  const runtime = runtimeFor(request.params.id);
  if (!runtime) return response.status(404).json({ error: "Session not found" });
  runtime.reset();
  return response.json(runtime.snapshot());
});

app.post("/api/sessions/:id/restart", (request, response) => {
  const runtime = runtimeFor(request.params.id);
  if (!runtime) return response.status(404).json({ error: "Session not found" });
  try {
    runtime.simulateRestart();
    return response.json(runtime.snapshot());
  } catch (error) {
    return response.status(409).json({ error: error instanceof Error ? error.message : "Unable to restore session" });
  }
});

app.post("/api/sessions/:id/occlusion", (request, response) => {
  const runtime = runtimeFor(request.params.id);
  if (!runtime) return response.status(404).json({ error: "Session not found" });
  if (typeof request.body?.enabled !== "boolean") {
    return response.status(400).json({ error: "enabled must be a boolean" });
  }
  try {
    runtime.setTemporaryOcclusion(request.body.enabled);
    return response.json(runtime.snapshot());
  } catch (error) {
    return response.status(400).json({ error: error instanceof Error ? error.message : "Unable to change occlusion" });
  }
});

app.get("/api/sessions/:id/stream", (request, response) => {
  const runtime = runtimeFor(request.params.id);
  if (!runtime) return response.status(404).json({ error: "Session not found" });

  response.status(200);
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();

  const onUpdate = (snapshot: RuntimeSnapshot) => writeSse(response, "state", snapshot);
  // Pages treat 15 seconds without any event as a dead stream; a proxy can hold one open after the API restarts.
  const heartbeat = setInterval(() => writeSse(response, "heartbeat", { at: Date.now() }), 5_000);
  runtime.on("update", onUpdate);
  writeSse(response, "state", runtime.snapshot());

  request.on("close", () => {
    clearInterval(heartbeat);
    runtime.off("update", onUpdate);
  });
});

app.use("/api", (_request, response) => {
  response.status(404).json({ error: "API route not found" });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`DogMaAI API listening on http://localhost:${port}`);
});

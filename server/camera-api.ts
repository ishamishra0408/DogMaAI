import express, { Router, type Request } from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isLiquidVisionModel, requireLocalManager } from "./manager-api.js";
import type { HomeCameraSource } from "./home-camera.js";
import { isComfortAction, type ComfortAction } from "../shared/comfort.js";
import type { DiaryEntry } from "../shared/diary.js";
import type { DiaryObservation } from "./dog-diary.js";
import { classifyDescription } from "./dog-view.js";

const token = () => randomBytes(32).toString("base64url");
const matches = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
interface CameraSession {
  id: string; owner: string; pairing: string; sender: string | null;
  pairUntil: number; expires: number; frame: Buffer | null; frameAt: number; sequence: number;
  speakerReady: boolean; action: { sequence: number; type: ComfortAction; at: number } | null;
  // Set on manager pages watching the home camera; they read the shared feed instead of their own frames.
  home?: { viewedAt: number };
}
// Background tabs poll about once a minute, so the camera is released only after a longer silence.
const homeIdleMs = 90_000;
// A home view nobody has polled for this long belongs to a closed tab.
const homeForgetMs = 10 * 60_000;
export function createCameraService(publicOrigin: () => Promise<string>, now = Date.now, visionEndpoint: () => string | null = () => null, homeCamera: HomeCameraSource | null = null, diary: (observation: DiaryObservation) => DiaryEntry | null = () => null, onReading: (observation: DiaryObservation) => void = () => {}, onAudio?: (samples: Int16Array) => void) {
  const sessions = new Map<string, CameraSession>();
  const admin = Router();
  const transport = Router();
  // One reader serves every page watching the home camera, so a second window never takes over the first.
  const feed = { frame: null as Buffer | null, frameAt: 0, sequence: 0, problem: null as string | null, stop: null as (() => void) | null };
  const view = (session: CameraSession) => session.home ? feed : session;
  const homeViews = () => [...sessions.values()].filter(session => session.home);
  const releaseCamera = () => { feed.stop?.(); feed.stop = null; };
  const remove = (session: CameraSession) => { sessions.delete(session.id); if (session.home && !homeViews().length) releaseCamera(); };
  // The camera is read only while a manager page asks for frames, so closed tabs do not hold the stream.
  const watchHome = (session: CameraSession) => {
    session.home!.viewedAt = now();
    if (feed.stop || !homeCamera) return;
    feed.problem = null;
    feed.stop = homeCamera.start(jpeg => {
      feed.frame = jpeg;
      feed.frameAt = now();
      feed.sequence += 1;
    }, problem => { feed.problem = problem; }, onAudio);
  };
  const prune = () => {
    for (const session of sessions.values()) {
      if (session.expires <= now() || (!session.sender && session.pairUntil <= now()) || (session.home && now() - session.home.viewedAt > homeForgetMs)) { remove(session); continue; }
      if (now() - session.frameAt > 10_000) session.frame = null;
    }
    if (now() - feed.frameAt > 10_000) feed.frame = null;
    if (feed.stop && !homeViews().some(session => now() - session.home!.viewedAt <= homeIdleMs)) releaseCamera();
  };
  const timer = setInterval(prune, 10_000);
  timer.unref();
  function authorize(request: Request, role: "owner" | "sender" | "either") {
    prune();
    const session = sessions.get(String(request.params.id));
    const bearer = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!session || !bearer) return null;
    if (role !== "sender" && matches(bearer, session.owner)) return session;
    if (role !== "owner" && session.sender && matches(bearer, session.sender)) return session;
    return null;
  }
  admin.use(requireLocalManager);
  admin.post("/pair", async (_request, response) => {
    prune();
    if (sessions.size >= 8) return response.status(429).json({ error: "Too many camera sessions. Disconnect an unused camera first." });
    try {
      const origin = new URL(await publicOrigin());
      if (origin.protocol !== "https:") throw new Error("The phone camera needs an HTTPS address.");
      const id = randomBytes(16).toString("hex");
      const session: CameraSession = { id, owner: token(), pairing: token(), sender: null, pairUntil: now() + 10 * 60_000, expires: now() + 8 * 60 * 60_000, frame: null, frameAt: 0, sequence: 0, speakerReady: false, action: null };
      sessions.set(id, session);
      // The single-use secret stays in the fragment, away from server access logs.
      const url = new URL("/phone", origin);
      url.hash = new URLSearchParams({ id, key: session.pairing }).toString();
      return response.json({ id, ownerToken: session.owner, url: url.href, expiresAt: session.pairUntil });
    } catch (error) {
      return response.status(503).json({ error: error instanceof Error ? error.message : "The phone link could not start. Try again." });
    }
  });
  // The camera address stays in the server environment; the browser only learns whether one is set.
  admin.get("/home", (_request, response) => response.json({ configured: Boolean(homeCamera?.configured) }));
  admin.post("/home", (_request, response) => {
    prune();
    if (!homeCamera?.configured) return response.status(409).json({ error: "Add your camera's RTSP address as CAMERA_RTSP_URL in .env, then restart DogMaAI." });
    // Pages closed without disconnecting make room for a new one.
    if (sessions.size >= 8) { const stalest = homeViews().sort((a, b) => a.home!.viewedAt - b.home!.viewedAt)[0]; if (stalest) remove(stalest); }
    if (sessions.size >= 8) return response.status(429).json({ error: "Too many camera sessions. Disconnect an unused camera first." });
    // Frames arrive inside this process, so the sender credential is never issued and the view never leaves this computer.
    const session: CameraSession = { id: randomBytes(16).toString("hex"), owner: token(), pairing: "", sender: token(), pairUntil: 0, expires: now() + 24 * 60 * 60_000, frame: null, frameAt: 0, sequence: 0, speakerReady: false, action: null, home: { viewedAt: now() } };
    sessions.set(session.id, session);
    watchHome(session);
    return response.json({ id: session.id, ownerToken: session.owner, url: "", expiresAt: session.expires });
  });
  transport.use((_request, response, next) => {
    response.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    next();
  });
  transport.post("/:id/claim", express.json({ limit: "1kb" }), (request, response) => {
    prune();
    const session = sessions.get(String(request.params.id));
    const key = typeof request.body?.key === "string" ? request.body.key : "";
    if (!session || session.sender || session.pairUntil <= now() || !matches(key, session.pairing)) return response.status(403).json({ error: "This camera link has expired or was already used. Create a new link in the manager." });
    session.sender = token();
    session.pairing = "";
    return response.json({ senderToken: session.sender, expiresAt: session.expires });
  });
  transport.post("/:id/frame", (request, response, next) => {
    if (!authorize(request, "sender")) return response.status(403).json({ error: "Camera pairing ended. Scan a new link." });
    next();
  }, express.raw({ type: "image/jpeg", limit: "256kb" }), (request, response) => {
    const session = authorize(request, "sender");
    if (!session) return response.status(403).json({ error: "Camera pairing ended." });
    const bytes = request.body;
    if (!Buffer.isBuffer(bytes) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return response.status(400).json({ error: "Send a JPEG camera frame." });
    if (session.sequence > 0 && now() - session.frameAt < 100) return response.status(429).json({ error: "Slow down the camera frames." });
    session.frame = Buffer.from(bytes);
    session.frameAt = now();
    session.sequence += 1;
    return response.status(204).end();
  });
  transport.get("/:id/frame", (request, response) => {
    const session = authorize(request, "owner");
    if (!session) return response.status(403).json({ error: "Camera pairing ended. Connect your phone again." });
    if (session.home) watchHome(session);
    const source = view(session);
    response.set({ "X-Camera-State": session.sender ? "paired" : "waiting", "X-Frame-Sequence": String(source.sequence), "X-Frame-Time": String(source.frameAt), "X-Speaker-Ready": session.speakerReady ? "1" : "0" });
    if (session.home && feed.problem) response.set("X-Camera-Problem", feed.problem);
    if (!source.frame || now() - source.frameAt > 5000 || String(source.sequence) === request.query.after) return response.status(204).end();
    return response.type("image/jpeg").send(source.frame);
  });
  transport.post("/:id/speaker", express.json({ limit: "1kb" }), (request, response) => {
    const session = authorize(request, "sender");
    if (!session) return response.status(403).json({ error: "Camera pairing ended." });
    session.speakerReady = request.body?.enabled === true;
    return response.json({ speakerReady: session.speakerReady });
  });
  transport.post("/:id/action", express.json({ limit: "1kb" }), (request, response) => {
    const session = authorize(request, "owner");
    if (!session) return response.status(403).json({ error: "Camera pairing ended." });
    if (!session.sender || !session.speakerReady) return response.status(409).json({ error: "Enable sound on the phone first." });
    const type = request.body?.type;
    if (!isComfortAction(type)) return response.status(400).json({ error: "Choose a sound action." });
    session.action = { sequence: (session.action?.sequence ?? 0) + 1, type, at: now() };
    return response.json({ queued: true, sequence: session.action.sequence });
  });
  transport.get("/:id/action", (request, response) => {
    const session = authorize(request, "sender");
    if (!session) return response.status(403).json({ error: "Camera pairing ended." });
    const action = session.action;
    if (!action || action.sequence <= Number(request.query.after ?? 0) || now() - action.at > 10_000) return response.status(204).end();
    return response.json(action);
  });
  let analyzing = false;
  // Home views share one camera, so a page open at the same time as another (this Mac and a phone, say) is given the
  // other's reading from the last 10 seconds rather than adding its own, which would count the same moments twice in
  // PetAnalytics. The page that took a reading never gets it back, so one page alone keeps its pace.
  let lastHome: { at: number; by: string; result: Record<string, unknown> } | null = null;
  transport.post("/:id/analyze", async (request, response) => {
    const session = authorize(request, "owner");
    if (!session) return response.status(403).json({ error: "Camera pairing ended." });
    const endpoint = visionEndpoint();
    if (!endpoint) return response.status(409).json({ error: "Connect and test Liquid AI in Settings first." });
    const { frame, frameAt } = view(session);
    if (!frame || now() - frameAt > 5000) return response.status(409).json({ error: "Waiting for a fresh camera image." });
    const age = lastHome ? now() - lastHome.at : Infinity;
    if (session.home && lastHome && ((lastHome.by !== session.id && age < 10_000) || (analyzing && age < 30_000))) return response.json({ ...lastHome.result, diaryEntry: false, shared: true });
    if (analyzing) return response.status(429).json({ error: "Vision is still processing the previous image." });
    analyzing = true;
    const started = now();
    try {
      const models = await fetch(`${endpoint}/models`, { signal: AbortSignal.timeout(5000) });
      if (!models.ok) throw new Error("The local vision model is unavailable.");
      const listing = await models.json() as { data?: { id: string }[] };
      const model = listing.data?.find(item => isLiquidVisionModel(item.id))?.id;
      if (!model) throw new Error("The local Liquid vision model is unavailable.");
      const result = await fetch(`${endpoint}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(90_000),
        body: JSON.stringify({ model, stream: false, max_tokens: 100, temperature: 0.1,
          messages: [{ role: "user", content: [
            { type: "text", text: "Describe what the dog is visibly doing in this home camera image, and where it is, in one short sentence. Mention any person who is visible. If no dog is visible, say so. Do not infer barking, sounds, health, or emotions from a still image." },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${frame.toString("base64")}` } }
          ] }] })
      });
      if (!result.ok) throw new Error(`The local vision model returned ${result.status}.`);
      const output = await result.json() as { choices?: { message?: { content?: string } }[] };
      const description = output.choices?.[0]?.message?.content?.trim().slice(0, 300);
      if (!description) throw new Error("The local vision model returned no description.");
      // The diary compares what the description says about the dog, not its wording.
      const view = await classifyDescription(endpoint, model, description);
      const observation: DiaryObservation = { description, view, observedAt: frameAt, model, camera: session.home ? "home" : "phone" };
      // Every reading the model could make sense of feeds PetAnalytics; the diary keeps only the changes.
      if (view.dog_visible !== "unknown") onReading(observation);
      const entry = diary(observation);
      if (session.home) lastHome = { at: started, by: session.id, result: { description, observedAt: frameAt, provider: "Liquid AI", view } };
      return response.json({ description, observedAt: frameAt, provider: "Liquid AI", view, diaryEntry: Boolean(entry) });
    } catch (reason) {
      return response.status(503).json({ error: reason instanceof Error ? reason.message : "Vision analysis failed." });
    } finally { analyzing = false; }
  });
  transport.delete("/:id", (request, response) => {
    const session = authorize(request, "either");
    if (!session) return response.status(403).json({ error: "Camera pairing already ended." });
    remove(session);
    return response.status(204).end();
  });
  return { admin, transport, dispose: () => { clearInterval(timer); for (const session of sessions.values()) remove(session); } };
}

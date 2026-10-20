import { Router, type RequestHandler } from "express";
import { z } from "zod";

export const requireLocalManager: RequestHandler = (request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  const host = request.headers.host ?? "";
  const origin = request.headers.origin;
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\]):(3001|5173)$/.test(host);
  const localOrigin = !origin || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(3001|5173)$/.test(origin);
  if (!localHost || !localOrigin || request.headers["x-nightwatch-local"] !== "1") {
    response.status(403).json({ error: "Open Settings from the local DogMaAI app." });
    return;
  }
  next();
};
// Text-only LFM models can share an endpoint with the vision model but cannot read camera images.
export const isLiquidVisionModel = (id: string) => /lfm|liquid/i.test(id) && /vl/i.test(id);
export function localModelEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1") throw new Error("Use a local model endpoint such as http://localhost:8080/v1.");
  return url.href.replace(/\/$/, "");
}

// Returns the Liquid vision model a local llama-server advertises, or says what is missing.
export async function findLiquidVisionModel(base: string, fetcher: typeof fetch = fetch): Promise<string> {
  let models: { id: string }[];
  try {
    const response = await fetcher(`${base}/models`, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error("Model listing failed"), { status: response.status }); }
    models = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await response.json()).data;
  } catch (reason) {
    // A wrong port often reaches another local web server, so the message names the endpoint.
    const status = (reason as { status?: number }).status;
    throw new Error(`No Liquid model server answered at ${base}${status ? ` (HTTP ${status})` : ""}. Start it with npm run vision.`);
  }
  const model = models.find(item => isLiquidVisionModel(item.id));
  if (!model) throw new Error(`The model server at ${base} has no Liquid vision model. Start an LFM2.5-VL model; text-only LFM models cannot read camera images.`);
  return model.id;
}

export type ServiceId = "liquid" | "nimble" | "tinybird" | "sound";
export interface ServiceState { configured: boolean; verifiedAt?: string | null; message: string; source?: "env" }
export type ServiceStates = Partial<Record<ServiceId, ServiceState>>;

// Services are set up in .env on this computer. The manager only reports their state; no key ever reaches the browser.
export function createManagerRouter(states: () => ServiceStates) {
  const router = Router();
  router.use(requireLocalManager);
  router.get("/connections", (_request, response) => response.json(states()));
  return router;
}

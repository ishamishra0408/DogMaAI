import { Router, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { whoIsAsking, type TailnetOwner } from "./tailnet.js";

let tailnetOwner: () => TailnetOwner | null = () => null;
/** Lets the owner of this Mac's Tailscale login use DogMaAI from their own devices, through Tailscale's private serve
 *  proxy on this Mac (see tailnet.ts for why that identity can be trusted). */
export function allowTailnetOwner(owner: () => TailnetOwner | null) { tailnetOwner = owner; }

const refuse = (response: Response) => response.status(403).json({ error: "Open DogMaAI on this Mac, or on your own devices through Tailscale." });
/** The owner: someone on this Mac, or the Mac's Tailscale login on their own devices. For routes a plain page request or
 *  event stream uses, which cannot add a header. */
export const requireOwner: RequestHandler = (request, response, next) => {
  if (whoIsAsking(request, tailnetOwner())) return next();
  refuse(response);
};
/** This Mac only, never through Tailscale: for the one-time sound links go2rtc fetches here. */
export const requireThisMac: RequestHandler = (request, response, next) => {
  if (whoIsAsking(request, tailnetOwner()) === "this-mac") return next();
  refuse(response);
};
/** The owner, from the DogMaAI page itself: the header it adds keeps other websites from using these routes. */
export const requireLocalManager: RequestHandler = (request, response, next) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.headers["x-nightwatch-local"] !== "1" || !whoIsAsking(request, tailnetOwner())) return void refuse(response);
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

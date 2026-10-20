import { afterEach, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createCameraService } from "./camera-api.js";
let service: ReturnType<typeof createCameraService>;
let server: Server;
let base: string;
let clock = 1_000_000;
let visionEndpoint: string | null = null;
let observations: unknown[] = [];
const local = { Host: "localhost:3001", "X-Nightwatch-Local": "1" };
let home: { configured: boolean; starts: number; stops: number; frame?: (jpeg: Buffer) => void; problem?: (message: string | null) => void };
beforeEach(async () => {
  clock = 1_000_000;
  visionEndpoint = null;
  observations = [];
  home = { configured: true, starts: 0, stops: 0 };
  const homeCamera = { get configured() { return home.configured; }, start(onFrame: (jpeg: Buffer) => void, onProblem: (message: string | null) => void) { home.starts += 1; home.frame = onFrame; home.problem = onProblem; return () => { home.stops += 1; }; } };
  service = createCameraService(async () => "https://phone.example", () => clock, () => visionEndpoint, homeCamera, observation => { observations.push(observation); return null; });
  const app = express(); app.use("/admin", service.admin); app.use("/camera", service.transport);
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { service.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
async function pair(): Promise<{ id: string; ownerToken: string; url: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/admin/pair`, { method: "POST", headers: local }, response => {
      let body = ""; response.on("data", chunk => { body += chunk; });
      response.on("end", () => { try { expect(response.statusCode).toBe(200); resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    request.on("error", reject); request.end();
  });
}
async function claim(pairing: { id: string; url: string }) {
  const key = new URLSearchParams(new URL(pairing.url).hash.slice(1)).get("key");
  return fetch(`${base}/camera/${pairing.id}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
}
it("requires local manager authorization to issue a pairing", async () => {
  expect((await fetch(`${base}/admin/pair`, { method: "POST" })).status).toBe(403);
  expect((await fetch(`${base}/admin/pair`, { method: "POST", headers: { ...local, Origin: "https://evil.example" } })).status).toBe(403);
});
it("allows one claim and separates upload and viewing credentials", async () => {
  const p = await pair(); const { senderToken } = await (await claim(p)).json();
  expect((await claim(p)).status).toBe(403);
  const path = `${base}/camera/${p.id}/frame`;
  const bytes = new Uint8Array([255,216,255,217]);
  expect((await fetch(path, { method: "POST", headers: { Authorization: `Bearer ${p.ownerToken}`, "Content-Type": "image/jpeg" }, body: bytes })).status).toBe(403);
  expect((await fetch(path, { headers: { Authorization: `Bearer ${senderToken}` } })).status).toBe(403);
  expect((await fetch(path, { method: "POST", headers: { Authorization: `Bearer ${senderToken}`, "Content-Type": "image/jpeg" }, body: bytes })).status).toBe(204);
  const frame = await fetch(path, { headers: { Authorization: `Bearer ${p.ownerToken}` } });
  expect(frame.status).toBe(200); expect(frame.headers.get("cache-control")).toBe("no-store"); expect(frame.headers.get("x-frame-sequence")).toBe("1");
  clock += 6000;
  expect((await fetch(path, { headers: { Authorization: `Bearer ${p.ownerToken}` } })).status).toBe(204);
});
it("expires unused links and revokes both capabilities on disconnect", async () => {
  const expired = await pair(); clock += 600_001; expect((await claim(expired)).status).toBe(403);
  const p = await pair(); const { senderToken } = await (await claim(p)).json();
  expect((await fetch(`${base}/camera/${p.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${p.ownerToken}` } })).status).toBe(204);
  expect((await fetch(`${base}/camera/${p.id}/frame`, { headers: { Authorization: `Bearer ${p.ownerToken}` } })).status).toBe(403);
  expect((await fetch(`${base}/camera/${p.id}/frame`, { method: "POST", headers: { Authorization: `Bearer ${senderToken}`, "Content-Type": "image/jpeg" }, body: new Uint8Array([255,216,255,217]) })).status).toBe(403);
});
it("rejects non-image input without retaining it", async () => {
  const p = await pair(); const { senderToken } = await (await claim(p)).json();
  expect((await fetch(`${base}/camera/${p.id}/frame`, { method: "POST", headers: { Authorization: `Bearer ${senderToken}`, "Content-Type": "image/jpeg" }, body: "not an image" })).status).toBe(400);
  expect((await fetch(`${base}/camera/${p.id}/frame`, { headers: { Authorization: `Bearer ${p.ownerToken}` } })).status).toBe(204);
});
it("requires the phone to enable sound before the manager can queue a comfort action", async () => {
  const p = await pair(); const { senderToken } = await (await claim(p)).json();
  const url = `${base}/camera/${p.id}`;
  const owner = { Authorization: `Bearer ${p.ownerToken}`, "Content-Type": "application/json" };
  const phone = { Authorization: `Bearer ${senderToken}`, "Content-Type": "application/json" };
  expect((await fetch(`${url}/action`, { method: "POST", headers: owner, body: JSON.stringify({ type: "dog-music" }) })).status).toBe(409);
  expect((await fetch(`${url}/speaker`, { method: "POST", headers: owner, body: JSON.stringify({ enabled: true }) })).status).toBe(403);
  expect((await fetch(`${url}/speaker`, { method: "POST", headers: phone, body: JSON.stringify({ enabled: true }) })).status).toBe(200);
  expect((await fetch(`${url}/action`, { method: "POST", headers: owner, body: JSON.stringify({ type: "bark" }) })).status).toBe(400);
  expect((await fetch(`${url}/action`, { method: "POST", headers: owner, body: JSON.stringify({ type: "dog-music" }) })).status).toBe(200);
  expect((await fetch(`${url}/action`, { method: "POST", headers: owner, body: JSON.stringify({ type: "dog-music" }) })).status).toBe(200);
  const action = await (await fetch(`${url}/action`, { headers: phone })).json();
  expect(action.type).toBe("dog-music");
  expect((await fetch(`${url}/action?after=${action.sequence}`, { headers: phone })).status).toBe(204);
  expect((await fetch(`${url}/action`, { headers: owner })).status).toBe(403);
});
async function admin(method: "GET" | "POST", path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/admin${path}`, { method, headers: local }, response => {
      let body = ""; response.on("data", chunk => { body += chunk; });
      response.on("end", () => { try { resolve({ status: response.statusCode!, body: JSON.parse(body) }); } catch (error) { reject(error); } });
    });
    request.on("error", reject); request.end();
  });
}
const startHome = () => admin("POST", "/home");
it("reports only whether a home camera is configured and requires the local manager", async () => {
  expect((await fetch(`${base}/admin/home`, { method: "POST" })).status).toBe(403);
  expect((await admin("GET", "/home")).body).toEqual({ configured: true });
  home.configured = false;
  expect((await startHome()).status).toBe(409);
});
it("serves home camera frames to the owner without issuing an upload credential", async () => {
  const { status, body } = await startHome();
  expect(status).toBe(200); expect(body.url).toBe("");
  const path = `${base}/camera/${body.id}/frame`;
  const owner = { Authorization: `Bearer ${body.ownerToken}` };
  expect((await fetch(path, { headers: owner })).status).toBe(204);
  home.frame!(Buffer.from([255, 216, 255, 217]));
  const frame = await fetch(path, { headers: owner });
  expect(frame.status).toBe(200); expect(frame.headers.get("x-camera-state")).toBe("paired"); expect(frame.headers.get("x-frame-sequence")).toBe("1");
  expect((await fetch(`${base}/camera/${body.id}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "" }) })).status).toBe(403);
  expect((await fetch(path, { method: "POST", headers: { ...owner, "Content-Type": "image/jpeg" }, body: new Uint8Array([255, 216, 255, 217]) })).status).toBe(403);
  home.problem!("The camera did not answer."); clock += 6000;
  const stale = await fetch(path, { headers: owner });
  expect(stale.status).toBe(204); expect(stale.headers.get("x-camera-problem")).toBe("The camera did not answer.");
  expect((await fetch(`${base}/camera/${body.id}`, { method: "DELETE", headers: owner })).status).toBe(204);
  expect(home.stops).toBe(1);
  expect((await fetch(path, { headers: owner })).status).toBe(403);
});
it("shares one camera reader between manager pages and releases it after the last one leaves", async () => {
  const first = await startHome(); const second = await startHome();
  expect(home.starts).toBe(1);
  home.frame!(Buffer.from([255, 216, 255, 217]));
  for (const page of [first, second]) expect((await fetch(`${base}/camera/${page.body.id}/frame`, { headers: { Authorization: `Bearer ${page.body.ownerToken}` } })).status).toBe(200);
  expect((await fetch(`${base}/camera/${first.body.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${first.body.ownerToken}` } })).status).toBe(204);
  expect(home.stops).toBe(0);
  expect((await fetch(`${base}/camera/${second.body.id}/frame`, { headers: { Authorization: `Bearer ${second.body.ownerToken}` } })).status).toBe(200);
  service.dispose();
  expect(home.stops).toBe(1);
});
it("forgets pages that stopped polling and makes room for new ones", async () => {
  const pages = [];
  for (let count = 0; count < 8; count++) { pages.push(await startHome()); clock += 1000; }
  const ninth = await startHome();
  expect(ninth.status).toBe(200);
  expect((await fetch(`${base}/camera/${pages[0].body.id}/frame`, { headers: { Authorization: `Bearer ${pages[0].body.ownerToken}` } })).status).toBe(403);
  clock += 601_000;
  expect((await fetch(`${base}/camera/${ninth.body.id}/frame`, { headers: { Authorization: `Bearer ${ninth.body.ownerToken}` } })).status).toBe(403);
  expect(home.stops).toBe(1);
});
it("releases the camera while no manager asks for frames and reconnects on the next request", async () => {
  const { body } = await startHome();
  const owner = { Authorization: `Bearer ${body.ownerToken}` };
  expect(home.starts).toBe(1);
  clock += 89_000;
  expect((await fetch(`${base}/camera/${body.id}/frame`, { headers: owner })).status).toBe(204);
  clock += 91_000;
  // Any request runs the idle check; this one cannot resume the reader.
  expect((await fetch(`${base}/camera/${body.id}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status).toBe(403);
  expect(home.stops).toBe(1);
  expect((await fetch(`${base}/camera/${body.id}/frame`, { headers: owner })).status).toBe(204);
  expect(home.starts).toBe(2);
});

it("describes the camera image, then hands what it says about the dog to the diary", async () => {
  const realFetch = globalThis.fetch;
  const requests: { response_format?: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("http://localhost:8081/v1")) return realFetch(input, init);
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "LFM2.5-VL-3B" }] });
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return Response.json({ choices: [{ message: { content: body.response_format ? '{"dog_visible":"yes","activity":"resting","location":"bed","person_visible":"no"}' : "The dog is lying on its bed." } }] });
  });
  try {
    visionEndpoint = "http://localhost:8081/v1";
    const p = await pair(); const { senderToken } = await (await claim(p)).json();
    await fetch(`${base}/camera/${p.id}/frame`, { method: "POST", headers: { Authorization: `Bearer ${senderToken}`, "Content-Type": "image/jpeg" }, body: new Uint8Array([255,216,255,217]) });
    const result = await fetch(`${base}/camera/${p.id}/analyze`, { method: "POST", headers: { Authorization: `Bearer ${p.ownerToken}` } });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ description: "The dog is lying on its bed.", view: { dog_visible: true, dog_activity: "resting", dog_location: "bed", person_visible: false }, diaryEntry: false });
    expect(observations).toEqual([{ description: "The dog is lying on its bed.", view: { dog_visible: true, dog_activity: "resting", dog_location: "bed", person_visible: false }, observedAt: clock, model: "LFM2.5-VL-3B", camera: "phone" }]);
    // Only the describing request carries the image; the classification reads the text alone.
    expect(JSON.stringify(requests[0])).toContain("image_url");
    expect(JSON.stringify(requests[1])).not.toContain("image_url");
  } finally { vi.unstubAllGlobals(); }
});

it("shares one reading between pages watching the home camera, so the same moment is not counted twice", async () => {
  const realFetch = globalThis.fetch;
  let liquidCalls = 0;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("http://localhost:8081/v1")) return realFetch(input, init);
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "LFM2.5-VL-3B" }] });
    liquidCalls += 1;
    // Liquid is slow: each of its two calls takes 1.5 seconds.
    clock += 1_500;
    const body = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ message: { content: body.response_format ? '{"dog_visible":"yes","activity":"resting","location":"bed","person_visible":"no"}' : "The dog is lying on its bed." } }] });
  });
  try {
    visionEndpoint = "http://localhost:8081/v1";
    const mac = (await startHome()).body; const phone = (await startHome()).body;
    const analyze = async (page: { id: string; ownerToken: string }) => {
      home.frame!(Buffer.from([255, 216, 255, 217]));
      return (await fetch(`${base}/camera/${page.id}/analyze`, { method: "POST", headers: { Authorization: `Bearer ${page.ownerToken}` } })).json();
    };
    expect(await analyze(mac)).toMatchObject({ description: "The dog is lying on its bed." });
    expect(liquidCalls).toBe(2);
    // The phone asks 4 seconds after the Mac's reading began, and gets the same reading without a second one.
    clock += 1_000;
    expect(await analyze(phone)).toMatchObject({ description: "The dog is lying on its bed.", shared: true, diaryEntry: false });
    expect(liquidCalls).toBe(2);
    expect(observations).toHaveLength(1);
    // The Mac's own next request, 12 seconds after its last began, takes a fresh reading even though Liquid is slow.
    clock += 8_000;
    expect((await analyze(mac)).shared).toBeUndefined();
    expect(liquidCalls).toBe(4);
    expect(observations).toHaveLength(2);
  } finally { vi.unstubAllGlobals(); }
});

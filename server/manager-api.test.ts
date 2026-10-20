import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createManagerRouter, findLiquidVisionModel, localModelEndpoint, type ServiceStates } from "./manager-api.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("local manager service status", () => {
  let server: Server;
  let base: string;
  const states: ServiceStates = {
    liquid: { configured: true, verifiedAt: "2026-09-28T12:00:00.000Z", message: "LFM2.5-VL-3B is running at http://localhost:8081/v1." },
    nimble: { configured: true, source: "env", message: "Find new sounds and alert guidance use the key in .env." },
    tinybird: { configured: false, message: "Run npm run tinybird:setup, then restart DogMaAI." }
  };
  beforeEach(async () => {
    const app = express();
    app.use(createManagerRouter(() => states));
    server = await new Promise<Server>(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  function call(path: string, method = "GET", extra: Record<string, string> = {}) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const request = httpRequest(`${base}${path}`, { method, headers: { Host: "localhost:3001", "X-Nightwatch-Local": "1", "Content-Type": "application/json", ...extra } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode!, body: text.startsWith("{") ? JSON.parse(text) : text }); });
      });
      request.on("error", reject);
      request.end(method === "GET" ? undefined : JSON.stringify({ provider: "nimble", apiKey: "synthetic-key-do-not-expose" }));
    });
  }

  it("answers only the local manager page", async () => {
    expect((await call("/connections", "GET", { Origin: "https://untrusted.example" })).status).toBe(403);
    expect((await call("/connections", "GET", { "X-Nightwatch-Local": "" })).status).toBe(403);
    expect((await call("/connections", "GET", { Host: "dogmaai.example:3001" })).status).toBe(403);
  });

  it("reports what .env set up and offers no way to send keys from the browser", async () => {
    const result = await call("/connections");
    expect(result.status).toBe(200);
    expect(result.body).toEqual(states);
    expect((await call("/connect", "POST")).status).toBe(404);
    expect((await call("/disconnect", "POST")).status).toBe(404);
  });
});

describe("finding the Liquid vision model", () => {
  it("names the endpoint that did not answer instead of blaming an account", async () => {
    const remote = vi.fn<typeof fetch>().mockResolvedValue(json({ error: "File not found" }, 404));
    await expect(findLiquidVisionModel("http://localhost:8080/v1", remote)).rejects.toThrow("No Liquid model server answered at http://localhost:8080/v1 (HTTP 404). Start it with npm run vision.");
    expect(String(remote.mock.calls[0][0])).toBe("http://localhost:8080/v1/models");
    await expect(findLiquidVisionModel("http://localhost:8081/v1", vi.fn<typeof fetch>().mockRejectedValue(new Error("connect ECONNREFUSED")))).rejects.toThrow("No Liquid model server answered at http://localhost:8081/v1. Start it with npm run vision.");
  });

  it("requires a Liquid vision model rather than any reachable model server", async () => {
    await expect(findLiquidVisionModel("http://localhost:8081/v1", vi.fn<typeof fetch>().mockResolvedValue(json({ data: [{ id: "some-other-model" }] })))).rejects.toThrow(/no Liquid vision model/);
  });

  it("rejects text-only Liquid models and accepts the vision model beside them", async () => {
    const textOnly = [{ id: "hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF:Q4_K_M" }, { id: "hf.co/LiquidAI/LFM2-1.2B-Extract-GGUF:Q4_K_M" }];
    await expect(findLiquidVisionModel("http://localhost:11434/v1", vi.fn<typeof fetch>().mockResolvedValue(json({ data: textOnly })))).rejects.toThrow(/text-only LFM models cannot read camera images/);
    await expect(findLiquidVisionModel("http://localhost:8081/v1", vi.fn<typeof fetch>().mockResolvedValue(json({ data: [...textOnly, { id: "LFM2.5-VL-3B" }] })))).resolves.toBe("LFM2.5-VL-3B");
  });
});

describe("local model destination validation", () => {
  it("accepts loopback and rejects remote hosts, credentials and unexpected paths", () => {
    expect(localModelEndpoint("http://localhost:8080/v1/")).toBe("http://localhost:8080/v1");
    for (const url of ["https://example.com/v1", "http://127.0.0.1.evil.test/v1", "http://user:secret@localhost:8080/v1", "http://localhost:8080/admin"]) expect(() => localModelEndpoint(url)).toThrow();
  });
});

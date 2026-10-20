import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { allowTailnetOwner, requireLocalManager, requireOwner, requireThisMac } from "./manager-api.js";
import { createOwnerGate, gateUpgrades, parseTailnetStatus, watchTailnetOwner, whoIsAsking } from "./tailnet.js";

// Synthetic values: an example tailnet name and login, not real ones.
const owner = { host: "dogcam.tail0000.ts.net", login: "owner@github", port: 5443 };
const status = (state = "Running") => JSON.stringify({ BackendState: state, Self: { DNSName: "DogCam.tail0000.ts.net.", UserID: 7 }, User: { "7": { LoginName: "Owner@github" } } });

describe("Tailscale owner", () => {
  it("reads this Mac's private name and login from Tailscale, and nothing when it is not running", async () => {
    expect(parseTailnetStatus(status())).toEqual({ host: owner.host, login: owner.login });
    expect(parseTailnetStatus(status("NeedsLogin"))).toBeNull();
    expect(parseTailnetStatus("not json")).toBeNull();
    expect(parseTailnetStatus(JSON.stringify({ BackendState: "Running", Self: { DNSName: "dogcam.tail0000.ts.net." } }))).toBeNull();
    const watcher = watchTailnetOwner(async () => status(), 5443);
    await watcher.refresh();
    expect(watcher.owner()).toEqual(owner);
    watcher.stop();
    const missing = watchTailnetOwner(async () => { throw new Error("tailscale: command not found"); }, 5443);
    await missing.refresh();
    expect(missing.owner()).toBeNull();
    missing.stop();
  });
});

describe("who is asking", () => {
  const ask = (headers: Record<string, string>, remoteAddress = "127.0.0.1") => whoIsAsking({ headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])), socket: { remoteAddress } }, owner);
  const phone = { Host: `${owner.host}:5443`, Origin: `https://${owner.host}:5443`, "Tailscale-User-Login": owner.login, "X-Forwarded-For": "100.64.0.2", "X-Forwarded-Host": `${owner.host}:5443` };
  it("tells this Mac, the owner's devices and everyone else apart", () => {
    expect(ask({ Host: "localhost:5443" })).toBe("this-mac");
    expect(ask({ Host: "[::1]:5443", Origin: "http://localhost:5443" })).toBe("this-mac");
    expect(ask(phone)).toBe("owner");
    // Only DogMaAI's own port: the same name also has other projects on other ports, one of them public through Funnel.
    expect(ask({ ...phone, Host: owner.host, Origin: `https://${owner.host}` })).toBeNull();
    expect(ask({ ...phone, Host: `${owner.host}:443`, Origin: `https://${owner.host}:443` })).toBeNull();
    // Through Tailscale, an address that reads as this Mac proves nothing.
    expect(ask({ ...phone, Host: "localhost:5443", Origin: "" })).toBeNull();
    // Not from this Mac's own loopback at all.
    expect(ask({ Host: "localhost:5443" }, "192.168.1.20")).toBeNull();
  });

  it("follows the API to another port set by PORT, so go2rtc's sound links keep working there", () => {
    const before = process.env.PORT;
    try {
      expect(ask({ Host: "127.0.0.1:4001" })).toBeNull();
      process.env.PORT = "4001";
      expect(ask({ Host: "127.0.0.1:4001" })).toBe("this-mac");
      // Other local ports, such as another project's server, are still not DogMaAI's page: a page of another project's dev
      // server on the usual Vite port cannot use DogMaAI.
      expect(ask({ Host: "localhost:5443", Origin: "http://localhost:8787" })).toBeNull();
      expect(ask({ Host: "localhost:5443", Origin: "http://localhost:5173" })).toBeNull();
      expect(ask({ Host: "localhost:5173" })).toBeNull();
    } finally {
      if (before === undefined) delete process.env.PORT; else process.env.PORT = before;
    }
  });

  it("guards the whole web server, files and app alike", () => {
    const gate = createOwnerGate(() => owner);
    const run = (headers: Record<string, string>) => {
      let passed = false;
      const response = { statusCode: 200, setHeader() {}, end() {} };
      gate({ headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])), socket: { remoteAddress: "127.0.0.1" } } as never, response as never, () => { passed = true; });
      return passed ? 200 : response.statusCode;
    };
    expect(run({ Host: "localhost:5443" })).toBe(200);
    expect(run(phone)).toBe(200);
    // A tagged machine, which Tailscale gives no login, asking for a data file.
    expect(run({ Host: `${owner.host}:5443`, "X-Forwarded-For": "100.64.0.9", "X-Forwarded-Host": `${owner.host}:5443` })).toBe(403);
  });

  it("guards live-reload connections too, which Vite lets through without its token when there is no Origin header", () => {
    const server = createServer();
    const reached: string[] = [];
    server.on("upgrade", request => reached.push(String(request.headers.host)));
    gateUpgrades(server, () => owner);
    const upgrade = (headers: Record<string, string>) => {
      let refused = "";
      const socket = { end: (text: string) => { refused = text; }, destroy() {} };
      server.emit("upgrade", { headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])), socket: { remoteAddress: "127.0.0.1" } }, socket, Buffer.alloc(0));
      return refused;
    };
    // A script on a tagged machine, with no Origin header and no login: refused before Vite sees it.
    expect(upgrade({ Host: `${owner.host}:5443`, "X-Forwarded-For": "100.64.0.9", Upgrade: "websocket" })).toContain("403");
    expect(reached).toEqual([]);
    // This Mac and the owner's phone reach Vite's live reload as before.
    expect(upgrade({ Host: "localhost:5443", Upgrade: "websocket" })).toBe("");
    expect(upgrade({ ...phone, Upgrade: "websocket" })).toBe("");
    expect(reached).toEqual(["localhost:5443", `${owner.host}:5443`]);
  });
});

describe("who may manage DogMaAI", () => {
  let server: Server | undefined;
  afterEach(async () => {
    allowTailnetOwner(() => null);
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  });
  async function call(headers: Record<string, string>, method = "POST", path = "/manage") {
    const app = express();
    app.use("/manage", requireLocalManager, (_request, response) => { response.json({ ok: true }); });
    app.use("/sessions", requireOwner, (_request, response) => { response.json({ ok: true }); });
    app.use("/camera-sound", requireThisMac, (_request, response) => { response.json({ ok: true }); });
    server ??= await new Promise<Server>(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    const port = (server.address() as AddressInfo).port;
    return new Promise<number>((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${port}${path}`, { method, headers }, response => { response.resume(); response.on("end", () => resolve(response.statusCode!)); });
      request.on("error", reject);
      request.end();
    });
  }
  // What Tailscale's serve proxy brings in from the owner's phone, through the web page.
  const fromPhone = { Host: `${owner.host}:5443`, Origin: `https://${owner.host}:5443`, "Tailscale-User-Login": owner.login, "X-Nightwatch-Local": "1" };

  it("lets this Mac in, as before", async () => {
    expect(await call({ Host: "localhost:5443", "X-Nightwatch-Local": "1" })).toBe(200);
    expect(await call({ Host: "localhost:5443" })).toBe(403);
  });

  it("lets the owner in from their own devices through Tailscale, including sound controls", async () => {
    allowTailnetOwner(() => owner);
    expect(await call(fromPhone)).toBe(200);
    expect(await call({ ...fromPhone, Origin: "" }, "GET")).toBe(200);
  });

  it("keeps everyone else out", async () => {
    allowTailnetOwner(() => owner);
    // Another person's login, a tagged machine with no login, another address, another site, or no page header.
    expect(await call({ ...fromPhone, "Tailscale-User-Login": "sitter@github" })).toBe(403);
    const { "Tailscale-User-Login": _login, ...tagged } = fromPhone;
    expect(await call(tagged)).toBe(403);
    expect(await call({ ...fromPhone, Host: "other.tail0000.ts.net:5443", Origin: "https://other.tail0000.ts.net:5443" })).toBe(403);
    expect(await call({ ...fromPhone, Origin: "https://evil.example" })).toBe(403);
    const { "X-Nightwatch-Local": _header, ...noHeader } = fromPhone;
    expect(await call(noHeader)).toBe(403);
    // With Tailscale off or signed out, only this Mac can manage DogMaAI.
    allowTailnetOwner(() => null);
    expect(await call(fromPhone)).toBe(403);
  });

  it("never takes a request that came through Tailscale for this Mac, even if its address was rewritten on the way", async () => {
    allowTailnetOwner(() => owner);
    // A script on a tagged machine: no login, no origin, and an address that reads as this Mac.
    expect(await call({ Host: "localhost:5443", "X-Forwarded-For": "100.64.0.9", "X-Nightwatch-Local": "1" })).toBe(403);
    expect(await call({ Host: "localhost:5443", "X-Forwarded-Host": `${owner.host}:5443`, "X-Nightwatch-Local": "1" })).toBe(403);
    // Even the owner's login does not help when the address is not this Mac's private name.
    expect(await call({ Host: "localhost:5443", "Tailscale-User-Login": owner.login, "X-Nightwatch-Local": "1" })).toBe(403);
  });

  it("serves the one-time camera sound links to this Mac only, never through Tailscale", async () => {
    allowTailnetOwner(() => owner);
    expect(await call({ Host: "127.0.0.1:3001" }, "GET", "/camera-sound")).toBe(200);
    expect(await call({ Host: `${owner.host}:5443`, "Tailscale-User-Login": owner.login, "X-Forwarded-For": "100.64.0.2" }, "GET", "/camera-sound")).toBe(403);
  });

  it("lets only the owner use the demo sessions, which a plain page request or event stream reaches without the page header", async () => {
    allowTailnetOwner(() => owner);
    expect(await call({ Host: "localhost:5443" }, "GET", "/sessions")).toBe(200);
    expect(await call({ Host: `${owner.host}:5443`, "Tailscale-User-Login": owner.login }, "GET", "/sessions")).toBe(200);
    expect(await call({ Host: `${owner.host}:5443`, "X-Forwarded-For": "100.64.0.9" }, "GET", "/sessions")).toBe(403);
    expect(await call({ Host: "localhost:5443", Origin: "https://evil.example" }, "POST", "/sessions")).toBe(403);
  });
});

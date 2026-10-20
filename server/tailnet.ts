import { execFile } from "node:child_process";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

// Who may use DogMaAI: someone on this Mac, or the owner of this Mac's Tailscale login on their own devices, through
// Tailscale's private "serve" proxy. Tailscale's own source deletes any incoming identity headers before adding its own,
// adds none for tagged machines, and always sets X-Forwarded-For and X-Forwarded-Host. DogMaAI's servers listen on
// this Mac only, so nothing reaches them from outside it any other way. The web server and the API both check.
export interface TailnetOwner {
  /** This Mac's private Tailscale name, such as macbook-air.tail1234.ts.net. */
  host: string;
  /** The Tailscale login this Mac is signed in with. */
  login: string;
  /** The HTTPS port `tailscale serve` gives DogMaAI on that name. */
  port: number;
}
export const defaultTailnetPort = 5443;

export function parseTailnetStatus(json: string): Pick<TailnetOwner, "host" | "login"> | null {
  try {
    const status = JSON.parse(json) as { BackendState?: string; Self?: { DNSName?: string; UserID?: number }; User?: Record<string, { LoginName?: string }> };
    if (status.BackendState !== "Running") return null;
    const host = (status.Self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
    const login = (status.User?.[String(status.Self?.UserID)]?.LoginName ?? "").toLowerCase();
    return host && login ? { host, login } : null;
  } catch {
    return null;
  }
}

const readStatus = () => new Promise<string>((resolve, reject) => {
  execFile(process.env.TAILSCALE_CLI || "tailscale", ["status", "--json"], { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
});

/** Reads Tailscale's state now and every 5 minutes. Without Tailscale, only this Mac can use DogMaAI. */
export function watchTailnetOwner(read: () => Promise<string> = readStatus, port = Number(process.env.DOGMAAI_TAILNET_PORT) || defaultTailnetPort) {
  let owner: TailnetOwner | null = null;
  const refresh = () => read().then(parseTailnetStatus, () => null).then(next => { owner = next ? { ...next, port } : null; });
  void refresh();
  const timer = setInterval(() => void refresh(), 5 * 60_000);
  timer.unref();
  return { owner: () => owner, refresh, stop: () => clearInterval(timer) };
}

// DogMaAI's own ports on this Mac: the web page's, the API's default, and the API's port if PORT moves it, so go2rtc's
// sound links keep working there. Read when asked, after .env is loaded.
const localPorts = () => new Set(["5173", "3001", process.env.PORT ?? ""].filter(Boolean));
const onThisMac = (value: string, pattern: RegExp) => { const match = value.match(pattern); return Boolean(match) && localPorts().has(match![2]); };
const localHost = (host: string) => onThisMac(host, /^(localhost|127\.0\.0\.1|\[::1\]):(\d+)$/);
const localOrigin = (origin: string) => onThisMac(origin, /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):(\d+)$/);
const loopback = (address = "") => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);
// Tailscale's serve proxy always sets these, so a request that came in through it is never taken for this Mac.
const proxied = (headers: IncomingHttpHeaders) => Boolean(headers["x-forwarded-for"] || headers["x-forwarded-host"] || headers["tailscale-user-login"]);

/** "this-mac", "owner" (the Mac's Tailscale login, at DogMaAI's own private address and port), or null for anyone else. */
export function whoIsAsking(request: { headers: IncomingHttpHeaders; socket: { remoteAddress?: string } }, owner: TailnetOwner | null): "this-mac" | "owner" | null {
  if (!loopback(request.socket.remoteAddress)) return null;
  const host = String(request.headers.host ?? "").toLowerCase();
  const origin = typeof request.headers.origin === "string" ? request.headers.origin.toLowerCase() : undefined;
  if (!proxied(request.headers)) return localHost(host) && (!origin || localOrigin(origin)) ? "this-mac" : null;
  if (!owner) return null;
  const address = `${owner.host}:${owner.port}`;
  const login = String(request.headers["tailscale-user-login"] ?? "").toLowerCase();
  return login === owner.login && host === address && (!origin || origin === `https://${address}`) ? "owner" : null;
}

/** For the web server's connection upgrades (live reload): Vite asks a WebSocket for its token only when the request has
 *  an Origin header, which a script can leave out, so upgrades get the same check as every other request. The upgrade
 *  handlers already on the server run only for this Mac or the owner. */
export function gateUpgrades(server: Server, owner: () => TailnetOwner | null) {
  const handlers = server.listeners("upgrade") as ((request: IncomingMessage, socket: Duplex, head: Buffer) => void)[];
  server.removeAllListeners("upgrade");
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!whoIsAsking(request, owner())) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    for (const handler of handlers) handler.call(server, request, socket, head);
  });
}

/** For the web server: every request, the app and its files alike, from this Mac or the owner only. */
export function createOwnerGate(owner: () => TailnetOwner | null) {
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    if (whoIsAsking(request, owner())) return next();
    response.statusCode = 403;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("DogMaAI opens on this Mac, or on your own devices through Tailscale.");
  };
}

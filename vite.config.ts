import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createOwnerGate, gateUpgrades, watchTailnetOwner } from "./server/tailnet.js";

// Every request to the web server (the app, its source and data files, and the live-reload connection) must come from
// this Mac or from the owner's own devices through Tailscale. The API checks again.
function ownerOnly(): Plugin {
  return {
    name: "dogmaai-owner-only",
    configureServer(server) {
      if (process.env.VITEST) return;
      const tailnet = watchTailnetOwner();
      server.httpServer?.once("close", tailnet.stop);
      server.middlewares.use(createOwnerGate(tailnet.owner));
      // Runs once Vite has added all its own upgrade handlers (live reload, then the /api proxy), so every one is covered.
      return () => { if (server.httpServer) gateUpgrades(server.httpServer as import("node:http").Server, tailnet.owner); };
    }
  };
}

export default defineConfig({
  plugins: [react(), ownerOnly()],
  build: {
    rollupOptions: { input: { main: "index.html", manager: "manager.html", phone: "phone.html", testScreen: "test-screen.html" } }
  },
  server: {
    // DogMaAI's own port, matching its Tailscale address. Other projects' dev servers start at 5173, and Tailscale forwards
    // to whatever answers on this port, so DogMaAI never moves off it: if it is taken, DogMaAI stops with an error.
    port: 5443,
    strictPort: true,
    // Tailscale's private serve proxy brings the owner's phone in under this Mac's *.ts.net name; ownerOnly() checks who.
    allowedHosts: [".ts.net"],
    // The real address is passed on (changeOrigin: false), so the API can tell this Mac from a device that came in
    // through Tailscale; the shorthand form rewrites it to the API's own.
    proxy: {
      "/api": { target: "http://127.0.0.1:3001", changeOrigin: false }
    }
  }
});

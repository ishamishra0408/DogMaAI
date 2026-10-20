import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: { input: { main: "index.html", manager: "manager.html", phone: "phone.html", testScreen: "test-screen.html" } }
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3001"
    }
  }
});

import "dotenv/config";
import { spawn } from "node:child_process";

// Serves Liquid's vision model for live camera descriptions (Settings → Connections → Liquid AI).
// LIQUID_MODEL and LIQUID_MMPROJ select local GGUF files; without them llama.cpp downloads the documented model.
const port = process.env.LIQUID_PORT || "8080";
const { LIQUID_MODEL: model, LIQUID_MMPROJ: projector } = process.env;
if (model && !projector) {
  console.error("Set LIQUID_MMPROJ to the model's vision projector (mmproj) file as well as LIQUID_MODEL.");
  process.exit(1);
}
const weights = model ? ["-m", model, "--mmproj", projector!] : ["-hf", "LiquidAI/LFM2.5-VL-3B-GGUF:Q4_K_M"];
// The model server has no use for the camera address loaded from .env.
delete process.env.CAMERA_RTSP_URL;
// The alias keeps "LFM" and "VL" in the advertised model name, which the manager requires.
const server = spawn(process.env.LLAMA_SERVER || "llama-server", [...weights, "--alias", "LFM2.5-VL-3B", "--host", "127.0.0.1", "--port", port, "-c", "4096"], { stdio: "inherit" });
console.log(`Liquid vision endpoint: http://localhost:${port}/v1`);
server.on("error", () => {
  console.error("llama-server was not found. Install llama.cpp or set LLAMA_SERVER in .env to its path.");
  process.exit(1);
});
server.on("exit", code => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.kill(signal));

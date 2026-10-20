import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Downloads Google's YAMNet sound model (TensorFlow.js version 1, Apache-2.0, 16 MB) and its class names into
// models/yamnet, checking each file against the checksum recorded when DogMaAI first used it. Files already in place
// with the right checksum are kept. DogMaAI runs the model on this computer to hear crying in the home camera's microphone.
// Usage: npm run sound-model:setup
const directory = join(process.cwd(), "models", "yamnet");
const model = "https://www.kaggle.com/models/google/yamnet/TfJs/tfjs/1";
const files: { name: string; url: string; sha256: string }[] = [
  { name: "model.json", url: `${model}/model.json?tfjs-format=file`, sha256: "552a4e59884a7fad25dbdbc1bbe75af2a416bca44de12523081d4b55606d59d3" },
  { name: "group1-shard1of4.bin", url: `${model}/group1-shard1of4.bin?tfjs-format=file`, sha256: "2ba509dbfc875e0483e5e3f6935cd9be9f986dd1219796c649422fd337dde4ca" },
  { name: "group1-shard2of4.bin", url: `${model}/group1-shard2of4.bin?tfjs-format=file`, sha256: "b789c08119ef33a534475b964c25447586e18328039c06322d4b5337887d1fca" },
  { name: "group1-shard3of4.bin", url: `${model}/group1-shard3of4.bin?tfjs-format=file`, sha256: "464a4a19cfb207c81bbd6ba079d2f36402902c07faa8b6d305f438dc0ab74212" },
  { name: "group1-shard4of4.bin", url: `${model}/group1-shard4of4.bin?tfjs-format=file`, sha256: "311fcb65f9985e825a9f162b7ef82bdc81a745bff11f90bd7b1eaabbd1f55e6b" },
  { name: "yamnet_class_map.csv", url: "https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv", sha256: "cdf24d193e196d9e95912a2667051ae203e92a2ba09449218ccb40ef787c6df2" }
];
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

try {
  mkdirSync(directory, { recursive: true });
  for (const file of files) {
    const path = join(directory, file.name);
    if (existsSync(path) && sha256(readFileSync(path)) === file.sha256) { console.log(`${file.name}: already in place`); continue; }
    const response = await fetch(file.url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`${file.name} could not be downloaded (HTTP ${response.status}). Nothing else was changed.`);
    const data = Buffer.from(await response.arrayBuffer());
    if (sha256(data) !== file.sha256) throw new Error(`${file.name} did not match its expected checksum, so it was not saved.`);
    writeFileSync(path, data);
    console.log(`${file.name}: saved (${(data.length / 1_000_000).toFixed(1)} MB)`);
  }
  console.log("The sound model is ready. Restart DogMaAI to start hearing crying from the home camera.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

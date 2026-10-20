import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as tf from "@tensorflow/tfjs-core";
import { loadGraphModel, type GraphModel } from "@tensorflow/tfjs-converter";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import type { TopLabel } from "../shared/hearing.js";

// YAMNet (Google, Apache-2.0) recognises 521 kinds of sound. DogMaAI runs its TensorFlow.js version on this computer to
// hear a dog crying (a whimper or a howl) or barking in the camera's microphone. Audio never leaves this computer.
export const modelDirectory = join(process.cwd(), "models", "yamnet");
export const sampleRate = 16_000;
/** 0.975 seconds of 16 kHz audio: exactly one of YAMNet's 0.96-second windows once its spectrogram frames are counted.
 *  A full second would give a second window that is mostly padding, which would water the scores down. */
export const windowSamples = 15_600;

const files = ["model.json", "group1-shard1of4.bin", "group1-shard2of4.bin", "group1-shard3of4.bin", "group1-shard4of4.bin", "yamnet_class_map.csv"];
export const soundModelReady = (directory = modelDirectory) => files.every(file => existsSync(join(directory, file)));

// The classes DogMaAI reads, by their names in yamnet_class_map.csv. "Whimper" is a person's whimper, but a dog's soft
// whimper often scores there instead through the camera's 8 kHz microphone.
const wanted = { whimperDog: "Whimper (dog)", humanWhimper: "Whimper", howl: "Howl", bark: "Bark", yip: "Yip", bowWow: "Bow-wow", dog: "Dog", music: "Music", speech: "Speech", silence: "Silence" } as const;
export type SoundScores = Record<keyof typeof wanted, number>;
/** The scores DogMaAI reads, and the three sounds YAMNet thought most likely, for the live view in Settings. */
export type HeardScores = SoundScores & { top: TopLabel[] };

export const classNames = (csv: string) => csv.trim().split("\n").slice(1).map(line => {
  const name = line.split(",").slice(2).join(",").trim();
  return name.replace(/^"|"$/g, "");
});
export function classIndexes(csv: string): Record<keyof typeof wanted, number> {
  const names = classNames(csv);
  return Object.fromEntries(Object.entries(wanted).map(([key, name]) => {
    const index = names.indexOf(name);
    if (index < 0) throw new Error(`The sound model's class list has no "${name}".`);
    return [key, index];
  })) as Record<keyof typeof wanted, number>;
}

let backendReady: Promise<void> | null = null;
function wasmBackend() {
  backendReady ??= (async () => {
    const require = createRequire(import.meta.url);
    setWasmPaths(`${dirname(require.resolve("@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm"))}/`);
    await tf.setBackend("wasm");
    await tf.ready();
  })();
  return backendReady;
}

export interface SoundModel { classify(samples: Float32Array): Promise<HeardScores>; dispose(): void }
export async function loadSoundModel(directory = modelDirectory): Promise<SoundModel> {
  await wasmBackend();
  const manifest = JSON.parse(await readFile(join(directory, "model.json"), "utf8"));
  const shards = await Promise.all((manifest.weightsManifest as { paths: string[] }[]).flatMap(group => group.paths).map(path => readFile(join(directory, path))));
  const weights = Buffer.concat(shards);
  const model: GraphModel = await loadGraphModel(tf.io.fromMemory({
    modelTopology: manifest.modelTopology, format: manifest.format, generatedBy: manifest.generatedBy, convertedBy: manifest.convertedBy,
    userDefinedMetadata: manifest.userDefinedMetadata,
    weightSpecs: (manifest.weightsManifest as { weights: tf.io.WeightsManifestEntry[] }[]).flatMap(group => group.weights),
    weightData: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength)
  }));
  const csv = await readFile(join(directory, "yamnet_class_map.csv"), "utf8");
  const indexes = classIndexes(csv);
  const names = classNames(csv);
  return {
    async classify(samples) {
      // Scores come per window, from the output named Identity:0 ([windows, 521]); longer input is averaged.
      const mean = tf.tidy(() => tf.mean(model.execute(tf.tensor1d(samples), "Identity:0") as tf.Tensor2D, 0));
      const scores = await mean.data();
      mean.dispose();
      const top: TopLabel[] = [];
      scores.forEach((score, index) => {
        if (top.length < 3 || score > top[2].score) { top.push({ label: names[index], score }); top.sort((left, right) => right.score - left.score); top.length = Math.min(top.length, 3); }
      });
      return { ...Object.fromEntries(Object.entries(indexes).map(([key, index]) => [key, scores[index]])) as SoundScores, top };
    },
    dispose: () => model.dispose()
  };
}

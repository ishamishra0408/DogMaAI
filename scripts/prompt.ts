import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

export async function ask(question: string) {
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return (await prompt.question(question)).trim(); } finally { prompt.close(); }
}

// Reads a secret without echoing it, so passwords never appear on screen or in terminal history.
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    stdout.write(question);
    let value = "";
    const finish = (error?: Error) => {
      stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("Cancelled. Nothing was saved."));
        if (character === "\r" || character === "\n" || character === "\u0004") return finish();
        value = character === "\u007f" ? value.slice(0, -1) : value + character;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HeardSecond } from "../shared/hearing.js";
import { createHearingCheck, suggestCutoff } from "./hearing.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "dogmaai-hearing-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const heard = (t: number, crying: number, barking = 0): HeardSecond => ({ t, heard: true, reason: null, sound: null, crying, barking, top: [{ label: "Dog", score: 0.4 }] });
const mark = (kind: "crying" | "quiet", values: number[]) => ({ kind, at: "", seconds: values.map((crying, t) => ({ t, crying, barking: 0 })) });
// Three quiet marks of ten seconds, three of them loud enough to reach 0.1.
const quietMarks = Array.from({ length: 3 }, () => mark("quiet", [0.01, 0.02, 0.01, 0.1, 0.01, 0.02, 0.01, 0.01, 0.03, 0.01]));

describe("hearing check", () => {
  it("keeps the last seconds for the live view and says whether the camera is being heard", async () => {
    let clock = 100_000;
    const check = createHearingCheck({ file: join(dir, "calibration.json"), dogName: "Simba", now: () => clock, problem: () => "Crying is not saved yet." });
    await check.loaded;
    expect(check.view().listening).toBe(false);
    for (let back = 40; back >= 1; back--) check.observe(heard(clock - back * 1000, 0.01));
    expect(check.view()).toMatchObject({ dog_name: "Simba", listening: true, cutoffs: { crying: 0.2, barking: 0.2 }, tuned: null, marks: { crying_moments: 0, quiet_seconds: 0 } });
    expect(check.view().seconds).toHaveLength(30);
    expect(check.view().seconds.at(-1)!.t).toBe(clock - 1000);
    expect(check.view().problem).toBe("Crying is not saved yet.");
    // Old seconds are not shown as recent: ten seconds on, only the last 20 of them are still within 30 seconds.
    clock += 10_000;
    expect(check.view().listening).toBe(false);
    expect(check.view().seconds).toHaveLength(20);
  });

  it("marks crying and quiet moments from the seconds just heard, keeps only their scores, and remembers them", async () => {
    const clock = 1_000_000;
    const file = join(dir, "data", "calibration.json");
    const check = createHearingCheck({ file, dogName: "Simba", now: () => clock, markDelay: 0 });
    // Twelve seconds, the last five crying, then one the camera did not hear while it played a sound.
    for (let back = 12; back >= 1; back--) check.observe(heard(clock - back * 1000, back <= 5 ? 0.09 : 0.01));
    check.observe({ ...heard(clock - 500, 0), heard: false, reason: "muted" });
    expect((await check.act("mark-crying")).marks).toEqual({ crying_moments: 1, quiet_seconds: 0 });
    // Quiet takes the 10 seconds before the press, less the 5 already marked as crying.
    expect((await check.act("mark-quiet")).marks).toEqual({ crying_moments: 1, quiet_seconds: 5 });
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved.marks[0]).toEqual({ kind: "crying", at: new Date(clock).toISOString(), seconds: [5, 4, 3, 2, 1].map(back => ({ t: clock - back * 1000, crying: 0.09, barking: 0 })) });
    // Only numbers are kept: no labels, and never sound.
    expect(JSON.stringify(saved)).not.toMatch(/Dog|label|top/);
    const again = createHearingCheck({ file, dogName: "Simba", now: () => clock, markDelay: 0 });
    await again.loaded;
    expect(again.view().marks).toEqual({ crying_moments: 1, quiet_seconds: 5 });
    expect((await again.act("undo")).marks).toEqual({ crying_moments: 1, quiet_seconds: 0 });
    expect((await again.act("clear")).marks).toEqual({ crying_moments: 0, quiet_seconds: 0 });
  });

  it("never marks a second twice: crying outranks quiet, and quick presses make one crying moment", async () => {
    let clock = 2_000_000;
    const file = join(dir, "calibration.json");
    const check = createHearingCheck({ file, dogName: "Simba", now: () => clock, markDelay: 0 });
    for (let back = 10; back >= 1; back--) check.observe(heard(clock - back * 1000, 0.01));
    expect((await check.act("mark-quiet")).marks).toEqual({ crying_moments: 0, quiet_seconds: 10 });
    await expect(check.act("mark-quiet")).rejects.toMatchObject({ status: 409 });
    // It was crying after all: the last 5 seconds move from quiet to crying, with the whimper that arrives at the press.
    check.observe(heard(clock, 0.3));
    expect((await check.act("mark-crying")).marks).toEqual({ crying_moments: 1, quiet_seconds: 5 });
    // A second press 2 seconds later adds to the same moment rather than making a weak new one.
    clock += 2000;
    check.observe(heard(clock, 0.4));
    expect((await check.act("mark-crying")).marks).toEqual({ crying_moments: 1, quiet_seconds: 5 });
    const saved = JSON.parse(await readFile(file, "utf8"));
    const moment = saved.marks.find((item: { kind: string }) => item.kind === "crying");
    expect(moment.seconds.map((second: { crying: number }) => second.crying)).toEqual([0.01, 0.01, 0.01, 0.01, 0.01, 0.3, 0.4]);
  });

  it("waits for the camera's late sound before taking a crying mark", async () => {
    const clock = 3_000_000;
    const check = createHearingCheck({ file: join(dir, "calibration.json"), dogName: "Simba", now: () => clock, markDelay: 30 });
    const marking = check.act("mark-crying");
    // The whimper that prompted the press reaches DogMaAI after it.
    setTimeout(() => check.observe(heard(clock + 2000, 0.25)), 5);
    expect((await marking).marks.crying_moments).toBe(1);
  });

  it("says when a mark could not be saved, and keeps it until DogMaAI restarts", async () => {
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a folder");
    const clock = 4_000_000;
    const check = createHearingCheck({ file: join(blocker, "calibration.json"), dogName: "Simba", now: () => clock, markDelay: 0 });
    check.observe(heard(clock - 1000, 0.2));
    await expect(check.act("mark-crying")).rejects.toMatchObject({ status: 500 });
    expect(check.view().marks.crying_moments).toBe(1);
  });

  it("works out the cut-off as the highest that catches 4 in 5 crying moments, within a safe range", () => {
    // The loudest second of each crying moment: 0.3, 0.12, 0.09, 0.085 and 0.01.
    const crying = [[0.3, 0.1], [0.12], [0.02, 0.09], [0.085], [0.01]].map(values => mark("crying", values));
    expect(suggestCutoff([...crying, ...quietMarks])).toEqual({ ready: true, needs: { crying_moments: 0, quiet_seconds: 0 }, cutoff: 0.08, moments: 5, caught: 4, quiet_seconds: 30, false_alarms: 3 });
    expect(suggestCutoff([...crying.slice(0, 2), quietMarks[0]])).toMatchObject({ ready: false, needs: { crying_moments: 1, quiet_seconds: 20 }, cutoff: null });
    // Loud, clear crying never makes it less sensitive than the default, and faint crying never takes it below 0.03.
    expect(suggestCutoff([...[[0.9], [0.8], [0.7]].map(values => mark("crying", values)), ...quietMarks]).cutoff).toBe(0.2);
    expect(suggestCutoff([...[[0.01], [0.012], [0.02]].map(values => mark("crying", values)), ...quietMarks]).cutoff).toBe(0.03);
  });

  it("uses the dog's cut-off at once, keeps it after a restart, and goes back to the default", async () => {
    let clock = 5_000_000;
    const file = join(dir, "calibration.json");
    const check = createHearingCheck({ file, dogName: "Simba", now: () => clock, markDelay: 0 });
    await expect(check.act("use-suggested")).rejects.toMatchObject({ status: 409 });
    for (const value of [0.12, 0.09, 0.1]) { check.observe(heard(clock, value)); await check.act("mark-crying"); clock += 20_000; }
    for (let times = 0; times < 3; times++) {
      for (let back = 10; back >= 1; back--) check.observe(heard(clock - back * 1000, 0.01));
      await check.act("mark-quiet");
      clock += 20_000;
    }
    const view = await check.act("use-suggested");
    expect(view.tuned).toEqual({ cutoff: 0.09, set_at: new Date(clock).toISOString() });
    expect(check.cutoffs()).toEqual({ crying: 0.09, barking: 0.2 });
    expect(check.describe()).toContain("0.09, tuned to Simba's own crying");
    const again = createHearingCheck({ file, dogName: "Simba", now: () => clock });
    await again.loaded;
    expect(again.cutoffs().crying).toBe(0.09);
    expect((await again.act("use-default")).tuned).toBeNull();
    expect(again.cutoffs().crying).toBe(0.2);
  });

  it("starts afresh from a damaged file, setting it aside, and ignores a cut-off outside the safe range", async () => {
    const file = join(dir, "calibration.json");
    await writeFile(file, JSON.stringify({ crying_cutoff: 0.9, set_at: "x", marks: [{ kind: "crying", at: "y", seconds: [{ t: 1, crying: "loud" }, { t: 2, crying: 0.1 }] }, { kind: "bogus", seconds: [] }] }));
    const check = createHearingCheck({ file, dogName: "Simba" });
    await check.loaded;
    expect(check.cutoffs().crying).toBe(0.2);
    expect(check.view().marks).toEqual({ crying_moments: 1, quiet_seconds: 0 });
    await writeFile(file, "{ not json");
    const broken = createHearingCheck({ file, dogName: "Simba" });
    await broken.loaded;
    expect(broken.view()).toMatchObject({ tuned: null, marks: { crying_moments: 0, quiet_seconds: 0 } });
    // The damaged file is kept aside rather than overwritten by the next save.
    expect(await readFile(`${file}.damaged`, "utf8")).toBe("{ not json");
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("answers only the local manager, takes known actions only, and marks nothing when nothing was heard", async () => {
    const check = createHearingCheck({ file: join(dir, "calibration.json"), dogName: "Simba", markDelay: 0 });
    const app = express();
    app.use(express.json());
    app.use("/hearing", check.router);
    const server = await new Promise<Server>(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
    const call = (method: "GET" | "POST", body?: unknown, headers: Record<string, string> = { Host: "localhost:3001", "X-Nightwatch-Local": "1" }) => new Promise<{ status: number; data: { error?: string; dog_name?: string } }>((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${(server.address() as AddressInfo).port}/hearing`, { method, headers: { ...headers, "Content-Type": "application/json" } }, response => {
        let text = ""; response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode!, data: JSON.parse(text) }));
      });
      request.on("error", reject);
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    try {
      expect((await call("GET", undefined, {})).status).toBe(403);
      expect(check.watching()).toBe(false);
      expect(await call("GET")).toMatchObject({ status: 200, data: { dog_name: "Simba" } });
      // Someone has the live view open, so the camera's sound is worth reading.
      expect(check.watching()).toBe(true);
      expect((await call("POST", { action: "shout" })).status).toBe(400);
      const nothing = await call("POST", { action: "mark-crying" });
      expect(nothing.status).toBe(409);
      expect(nothing.data.error).toContain("home camera");
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

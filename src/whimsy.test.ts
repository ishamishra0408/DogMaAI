import { afterEach, describe, expect, it, vi } from "vitest";
import type { PetAnalytics } from "../shared/analytics";
import { numberParts } from "./numbers";
import { flipStats, minutesText } from "./pet-stats";
import { onSoundsChange, playSound, setSoundsEnabled, soundsEnabled } from "./ui-sounds";

describe("number accents", () => {
  it("marks numbers with their units and leaves the words around them", () => {
    const numbers = (text: string) => numberParts(text).filter(part => part.number).map(part => part.text);
    expect(numbers("Longest 2 h 29 min, 41% of the time")).toEqual(["2 h 29 min", "41%"]);
    expect(numbers("Usually 7:32 am and 6:13 pm")).toEqual(["7:32 am", "6:13 pm"]);
    expect(numbers("active 45 points less than before (4 plays)")).toEqual(["45 points", "4 plays"]);
    expect(numbers("the last 7 days, 8 hours of watching")).toEqual(["7 days", "8 hours"]);
    expect(numberParts("No numbers here")).toEqual([{ text: "No numbers here", number: false }]);
    expect(numbers("K9 crate, 2 plays")).toEqual(["2 plays"]);
    expect(numbers("the 4th day, 10x faster, 12.5x, and 3 min.")).toEqual(["3 min"]);
    expect(numberParts("Busiest around 7 am").map(part => part.text).join("")).toBe("Busiest around 7 am");
  });
});

describe("flip tiles", () => {
  const day = (date: string, label: string, crying: number | null, heard: number) => ({ date, label, crying_minutes: crying, heard_minutes: heard });
  const episode = (date: string, minutes: number, mood: "calm" | "unsettled" | "upset") => ({ date, start_minute: 540, minutes, settle_minutes: 12, restless_share: 0.1, door_share: 0.05, heard_minutes: minutes, crying_minutes: 1, music: false, seen_enough: true, mood });
  const group = (episodes: number, settle: number | null, crying: number | null) => ({ episodes, settle_minutes: settle, crying_per_hour: crying, upset: 0 });
  const report = {
    days: ["2026-09-26", "2026-09-27", "2026-09-28"],
    feelings: {
      episodes: [episode("2026-09-26", 300, "calm"), episode("2026-09-27", 240, "calm"), episode("2026-09-27", 60, "upset"), episode("2026-09-28", 100, "unsettled")],
      counts: { calm: 2, unsettled: 1, upset: 1 }, mostly: "calm", typical_settle_minutes: 12, alone_minutes: 700
    },
    // Today's crying is left out of crying a day, since today is not over, and so is a day heard for under half an hour.
    crying: { listening: true, heard_minutes: 900, crying_minutes: 14.5, alone_crying_minutes: 12.5, barking_minutes: 1, longest_minutes: 4, by_day: [day("2026-09-26", "Sat", 3, 300), day("2026-09-27", "Sun", 6, 290), day("2026-09-28", "Today", 3.5, 100)], by_hour: [] },
    music: { plays: 3, with_music: group(2, 10, 0.4), without_music: group(2, 28, 1.6), verdict: "helped" }
  } as unknown as PetAnalytics;

  it("answers how the dog felt, how long it cried, whether music helped and how long it was alone, two ways each", () => {
    const [felt, cried, music, alone] = flipStats(report);
    expect(felt.front).toMatchObject({ label: "Felt when alone", value: "Mostly calm", note: "Usually settled after 12 min" });
    expect(felt.back).toMatchObject({ label: "Times alone", value: "4", note: "2 calm · 1 unsettled · 1 upset" });
    expect(cried.front).toMatchObject({ value: "13 min", note: "This week, while alone" });
    expect(cried.back).toMatchObject({ label: "Crying a day", value: "5 min", note: "Longest stretch 4 min" });
    expect(music.front).toMatchObject({ value: "Seems to", note: "Settled after 10 min with music, 28 min without" });
    expect(music.back).toMatchObject({ value: "3", note: "Cried 0.4 vs 1.6 min an hour alone" });
    // Alone a day counts complete days only: 300 minutes on Saturday and 300 on Sunday.
    expect(alone.front).toMatchObject({ value: "11 h 40 min" });
    expect(alone.back).toMatchObject({ label: "Alone a day", value: "5 h", note: "Longest stretch 5 h" });
  });

  it("says so when nothing was heard yet or there is too little to compare", () => {
    const quiet = { ...report, crying: { ...report.crying, listening: false }, music: { ...report.music, verdict: "not_enough" } } as unknown as PetAnalytics;
    const [, cried, music] = flipStats(quiet);
    expect(cried.front).toMatchObject({ value: "—", note: "Waiting to hear the camera" });
    expect(music.front).toMatchObject({ value: "Too soon", note: "Needs 2 times alone with music and 2 without" });
    expect(minutesText(0.4)).toBe("under 1 min");
    // Stretches the camera did not see enough of are counted apart, and a week of only those says why there is no settling time.
    const unseen = { ...episode("2026-09-28", 90, "calm"), seen_enough: false, mood: null };
    const [partly] = flipStats({ ...report, feelings: { ...report.feelings, episodes: [...report.feelings.episodes, unseen] } } as unknown as PetAnalytics);
    expect(partly.back).toMatchObject({ value: "5", note: "2 calm · 1 unsettled · 1 upset · 1 not seen" });
    const [hidden] = flipStats({ ...report, feelings: { episodes: [unseen], counts: { calm: 0, unsettled: 0, upset: 0 }, mostly: null, typical_settle_minutes: null, alone_minutes: 90 } } as unknown as PetAnalytics);
    expect(hidden.front).toMatchObject({ value: "—", note: "Out of view most of the time alone" });
    expect(minutesText(null)).toBe("—");
  });
});

describe("interface sounds", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("are on until turned off, remember the choice, and never throw without audio", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) });
    const heard: boolean[] = [];
    const stop = onSoundsChange(enabled => heard.push(enabled));
    expect(soundsEnabled()).toBe(true);
    setSoundsEnabled(false);
    expect(soundsEnabled()).toBe(false);
    expect(store.get("dogmaai.sounds")).toBe("off");
    setSoundsEnabled(true);
    expect(store.has("dogmaai.sounds")).toBe(false);
    stop();
    setSoundsEnabled(false);
    expect(heard).toEqual([false, true]);
    // Node has no Web Audio, so playing is a quiet no-op rather than an error.
    expect(() => playSound("tap", true)).not.toThrow();
  });

  it("stays on when storage is blocked", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    expect(soundsEnabled()).toBe(true);
    expect(() => setSoundsEnabled(false)).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import type { LoggedEvent, Reading, SoundReading } from "./dog-log.js";
import { buildAnalytics, moodOf, watchedHours } from "./pet-analytics.js";
import { sampleWeek } from "./sample-week.js";

const minute = 60_000;
const at = (date: string, time: string) => Date.parse(`${date}T${time}:00Z`);
// One reading a minute from `from` for `minutes`, all with the same state.
function run(from: number, minutes: number, activity: string, location: string, person = "no", visible = "yes"): Reading[] {
  return Array.from({ length: minutes }, (_, index) => ({ t: from + index * minute, visible, activity, location, person }));
}
const input = (readings: Reading[], events: LoggedEvent[] = [], now = at("2026-09-28", "23:00"), sounds: SoundReading[] = []) => ({
  readings, sounds, events, now, timeZone: "UTC", dogName: "Simba", sample: false, realWatchedHours: watchedHours(readings), neededHours: 8, logging: true, loggingProblem: null
});
// One minute of microphone for each of `minutes`, with `crying` seconds of crying in each.
function hear(from: number, minutes: number, crying = 0): SoundReading[] {
  return Array.from({ length: minutes }, (_, index) => ({ t: from + index * minute, heard: 60, crying, barking: 0 }));
}

describe("PetAnalytics", () => {
  it("splits watched time by activity, by hour and by day", () => {
    const readings = [
      ...run(at("2026-09-28", "09:00"), 30, "resting", "bed"),
      ...run(at("2026-09-28", "09:30"), 30, "moving", "floor"),
      ...run(at("2026-09-28", "17:00"), 30, "playing", "floor", "yes"),
      ...run(at("2026-09-28", "17:30"), 10, "eating", "floor", "yes")
    ];
    const report = buildAnalytics(input(readings));
    expect(report.watched_minutes).toBe(100);
    expect(report.activity.shares).toEqual({ resting: 0.3, moving: 0.3, playing: 0.3, eating: 0.1 });
    expect(report.activity.active_share).toBe(0.6);
    expect(report.activity.by_hour[9]).toMatchObject({ watched_minutes: 60, active_share: 0.5 });
    expect(report.activity.by_hour[17]).toMatchObject({ watched_minutes: 40, active_share: 0.75 });
    // Hours watched for less than twenty minutes are left blank rather than guessed.
    expect(report.activity.by_hour[3].active_share).toBeNull();
    expect(report.activity.most_active_hour).toBe(17);
    expect(report.activity.by_day.at(-1)).toMatchObject({ date: "2026-09-28", label: "Today", watched_minutes: 100, active_minutes: 60 });
    expect(report.days).toHaveLength(7);
  });

  it("finds naps of ten minutes or more, broken by activity or a gap in watching", () => {
    const readings = [
      ...run(at("2026-09-28", "10:00"), 40, "resting", "bed"),
      ...run(at("2026-09-28", "10:40"), 5, "moving", "floor"),
      ...run(at("2026-09-28", "10:45"), 8, "resting", "bed"),
      ...run(at("2026-09-28", "11:00"), 20, "resting", "furniture"),
      // Ten minutes unwatched splits this rest into two.
      ...run(at("2026-09-28", "11:30"), 15, "resting", "bed")
    ];
    const report = buildAnalytics(input(readings));
    expect(report.naps.list).toEqual([
      { date: "2026-09-28", start_minute: 600, minutes: 40 },
      { date: "2026-09-28", start_minute: 660, minutes: 20 },
      { date: "2026-09-28", start_minute: 690, minutes: 15 }
    ]);
    expect(report.naps.longest_minutes).toBe(40);
    expect(report.naps.usual_hours).toEqual([10, 11]);
  });

  it("works out naps per day from complete days, not today's unfinished one", () => {
    const readings = [...run(at("2026-09-27", "10:00"), 30, "resting", "bed"), ...run(at("2026-09-27", "14:00"), 30, "resting", "bed"), ...run(at("2026-09-28", "07:00"), 120, "resting", "bed")];
    expect(buildAnalytics(input(readings, [], at("2026-09-28", "09:00"))).naps.per_day).toBe(2);
  });

  it("keeps seven calendar days across a clock change", () => {
    // Clocks in Los Angeles went forward on 8 March 2026; half an hour after the next midnight, that Sunday still counts.
    const report = buildAnalytics({ ...input([]), now: Date.parse("2026-03-09T07:30:00Z"), timeZone: "America/Los_Angeles" });
    expect(report.days).toEqual(["2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"]);
  });

  it("reports favourite spots and time alone, with the calmest and most unsettled hours", () => {
    const readings = [
      ...run(at("2026-09-28", "09:00"), 30, "moving", "door"),
      ...run(at("2026-09-28", "09:30"), 30, "resting", "floor"),
      ...run(at("2026-09-28", "13:00"), 60, "resting", "bed"),
      ...run(at("2026-09-28", "19:00"), 30, "playing", "furniture", "yes")
    ];
    const report = buildAnalytics(input(readings));
    // Equal shares keep the fixed order of spots, so each spot keeps its place.
    expect(report.spots.map(spot => [spot.spot, spot.share])).toEqual([["bed", 0.4], ["floor", 0.2], ["furniture", 0.2], ["door", 0.2]]);
    expect(report.alone).toMatchObject({ watched_minutes: 120, restless_share: 0.25, door_share: 0.25, resting_share: 0.75, calmest_hour: 13, most_unsettled_hour: 9 });
    expect(report.tips.map(tip => tip.id)).toEqual(expect.arrayContaining(["door"]));
    expect(report.ideas[0].id).toBe("frozen");
  });

  it("compares activity in the 15 minutes before and after each comfort sound", () => {
    const start = at("2026-09-28", "09:00");
    const readings = [...run(start - 15 * minute, 15, "moving", "door"), ...run(start, 12, "resting", "bed"), ...run(start + 12 * minute, 3, "moving", "floor")];
    const events: LoggedEvent[] = [
      { id: "c1", t: start, kind: "comfort", detail: "dog-music", source: "camera" },
      // A sound with too little watching around it is left out rather than guessed.
      { id: "c2", t: at("2026-09-28", "15:00"), kind: "comfort", detail: "dog-noise", source: "camera" }
    ];
    const report = buildAnalytics(input(readings, events));
    expect(report.comfort).toEqual([{ sound: "Calm music", plays: 1, active_before: 1, active_after: 0.2 }]);
  });

  it("reads how the dog seemed alone from settling, crying and time at the door", () => {
    const calm = { minutes: 60, settle_minutes: 20, door_share: 0.05, crying_minutes: 0.5 };
    expect(moodOf(calm)).toBe("calm");
    expect(moodOf({ ...calm, settle_minutes: 21 })).toBe("unsettled");
    expect(moodOf({ ...calm, crying_minutes: 5 })).toBe("upset");
    expect(moodOf({ ...calm, door_share: 0.3 })).toBe("upset");
    expect(moodOf({ ...calm, settle_minutes: null, minutes: 45 })).toBe("upset");
    // A short stretch that never settled is unsettled rather than upset, and unheard crying counts as none.
    expect(moodOf({ ...calm, settle_minutes: null, minutes: 30 })).toBe("unsettled");
    expect(moodOf({ ...calm, crying_minutes: null })).toBe("calm");
  });

  it("finds each stretch alone and how long the dog cried in it", () => {
    const readings = [
      ...run(at("2026-09-28", "08:00"), 30, "playing", "floor", "yes"),
      // Calm: pottering for 8 minutes, then an hour's rest.
      ...run(at("2026-09-28", "08:30"), 8, "moving", "floor"), ...run(at("2026-09-28", "08:38"), 60, "resting", "bed"),
      ...run(at("2026-09-28", "09:38"), 20, "playing", "floor", "yes"),
      // Upset: half an hour at the door and 50 minutes before settling, with six minutes of crying.
      ...run(at("2026-09-28", "10:00"), 30, "moving", "door"), ...run(at("2026-09-28", "10:30"), 20, "moving", "floor"), ...run(at("2026-09-28", "10:50"), 30, "resting", "bed"),
      ...run(at("2026-09-28", "11:20"), 20, "playing", "floor", "yes"),
      // Unsettled: 25 minutes before settling, and two minutes of crying.
      ...run(at("2026-09-28", "12:00"), 25, "moving", "floor"), ...run(at("2026-09-28", "12:25"), 40, "resting", "bed"),
      ...run(at("2026-09-28", "13:05"), 20, "playing", "floor", "yes"),
      // Ten minutes alone is too short to judge.
      ...run(at("2026-09-28", "14:00"), 10, "resting", "bed")
    ];
    const sounds = [...hear(at("2026-09-28", "08:30"), 68), ...hear(at("2026-09-28", "10:00"), 6, 60), ...hear(at("2026-09-28", "10:06"), 74), ...hear(at("2026-09-28", "12:00"), 2, 60), ...hear(at("2026-09-28", "12:02"), 63)];
    const report = buildAnalytics(input(readings, [], at("2026-09-28", "23:00"), sounds));
    expect(report.feelings.episodes.map(episode => [episode.start_minute, episode.minutes, episode.settle_minutes, episode.crying_minutes, episode.mood])).toEqual([
      [510, 68, 8, 0, "calm"], [600, 80, 50, 6, "upset"], [720, 65, 25, 2, "unsettled"]
    ]);
    expect(report.feelings).toMatchObject({ counts: { calm: 1, unsettled: 1, upset: 1 }, mostly: "upset", typical_settle_minutes: 25, alone_minutes: 213 });
    expect(report.crying).toMatchObject({ listening: true, alone_crying_minutes: 8, crying_minutes: 8, longest_minutes: 6 });
    expect(report.crying.by_day.at(-1)).toMatchObject({ label: "Today", crying_minutes: 8, heard_minutes: 213 });
  });

  it("counts a dog already asleep as you leave as settled, and does not judge stretches it was barely seen in", () => {
    const readings = [
      // Asleep before and after you leave at 8:20: settled at once, so calm.
      ...run(at("2026-09-28", "08:00"), 20, "resting", "bed", "yes"), ...run(at("2026-09-28", "08:20"), 60, "resting", "bed"),
      ...run(at("2026-09-28", "09:20"), 10, "playing", "floor", "yes"),
      // Asleep as you leave at 10:20, but awake two minutes later and waiting at the door: that rest is not settling.
      ...run(at("2026-09-28", "10:00"), 20, "resting", "bed", "yes"), ...run(at("2026-09-28", "10:20"), 2, "resting", "bed"), ...run(at("2026-09-28", "10:22"), 48, "moving", "door"),
      ...run(at("2026-09-28", "11:10"), 10, "playing", "floor", "yes"),
      // Out of view for 70 of 80 minutes, with music playing: no mood rather than a guess, and left out of the music comparison.
      ...run(at("2026-09-28", "12:10"), 10, "moving", "floor"), ...run(at("2026-09-28", "12:20"), 70, "unknown", "unknown", "no", "no"),
      ...run(at("2026-09-28", "13:30"), 10, "playing", "floor", "yes"),
      // Out of view, but heard crying for six minutes: upset.
      ...run(at("2026-09-28", "15:00"), 60, "unknown", "unknown", "no", "no"),
      ...run(at("2026-09-28", "16:00"), 10, "playing", "floor", "yes")
    ];
    const sounds = [...hear(at("2026-09-28", "08:20"), 60), ...hear(at("2026-09-28", "15:00"), 6, 60), ...hear(at("2026-09-28", "15:06"), 54)];
    const events: LoggedEvent[] = [{ id: "m1", t: at("2026-09-28", "12:15"), kind: "comfort", detail: "dog-music", source: "camera" }];
    const report = buildAnalytics(input(readings, events, at("2026-09-28", "23:00"), sounds));
    expect(report.feelings.episodes.map(episode => [episode.start_minute, episode.minutes, episode.settle_minutes, episode.seen_enough, episode.mood])).toEqual([
      [500, 60, 0, true, "calm"], [620, 50, null, true, "upset"], [730, 80, null, false, null], [900, 60, null, false, "upset"]
    ]);
    expect(report.feelings).toMatchObject({ counts: { calm: 1, unsettled: 0, upset: 2 }, typical_settle_minutes: 0 });
    expect(report.music.with_music.episodes).toBe(0);
  });

  it("does not count a rest cut short by your return as settling", () => {
    const readings = [
      ...run(at("2026-09-28", "09:00"), 10, "playing", "floor", "yes"),
      // Pacing for 44 minutes, lying down 6 minutes before you come back, and sleeping on after.
      ...run(at("2026-09-28", "09:10"), 44, "moving", "floor"), ...run(at("2026-09-28", "09:54"), 6, "resting", "bed"),
      ...run(at("2026-09-28", "10:00"), 30, "resting", "bed", "yes")
    ];
    const [episode] = buildAnalytics(input(readings)).feelings.episodes;
    expect(episode).toMatchObject({ minutes: 50, settle_minutes: null, mood: "upset" });
  });

  it("finds the longest crying stretch in time alone only", () => {
    const readings = [
      ...run(at("2026-09-28", "18:00"), 30, "moving", "floor", "yes"),
      ...run(at("2026-09-28", "18:30"), 30, "resting", "bed")
    ];
    // Twenty minutes of crying with someone there, then three minutes alone.
    const sounds = [...hear(at("2026-09-28", "18:00"), 20, 60), ...hear(at("2026-09-28", "18:20"), 10), ...hear(at("2026-09-28", "18:30"), 3, 60), ...hear(at("2026-09-28", "18:33"), 27)];
    const report = buildAnalytics(input(readings, [], at("2026-09-28", "23:00"), sounds));
    expect(report.crying).toMatchObject({ crying_minutes: 23, alone_crying_minutes: 3, longest_minutes: 3 });
  });

  it("takes the true middle of two stretches, so one quick settle does not make music look like it helped", () => {
    const readings: Reading[] = [];
    const sounds: SoundReading[] = [];
    const events: LoggedEvent[] = [];
    // With music the dog settles after 10 and 60 minutes; without, after 30 and 35. Middles: 35 against 33.
    [["2026-09-25", 10, true], ["2026-09-26", 30, false], ["2026-09-27", 60, true], ["2026-09-28", 35, false]].forEach(([date, settle, music], index) => {
      const from = at(date as string, "08:10");
      readings.push(...run(at(date as string, "08:00"), 10, "playing", "floor", "yes"), ...run(from, settle as number, "moving", "floor"), ...run(from + (settle as number) * minute, 30, "resting", "bed"), ...run(from + ((settle as number) + 30) * minute, 10, "playing", "floor", "yes"));
      sounds.push(...hear(from, (settle as number) + 30));
      if (music) events.push({ id: `m${index}`, t: from, kind: "comfort", detail: "dog-music", source: "camera" });
    });
    const report = buildAnalytics(input(readings, events, at("2026-09-28", "23:00"), sounds));
    expect(report.music).toMatchObject({ verdict: "no_difference", with_music: { episodes: 2, settle_minutes: 35 }, without_music: { episodes: 2, settle_minutes: 33 } });
  });

  it("compares stretches alone with music against those without", () => {
    const readings: Reading[] = [];
    const sounds: SoundReading[] = [];
    const events: LoggedEvent[] = [];
    // Four mornings: with music the dog settles after 10 minutes and does not cry; without, after 30 minutes with 3 minutes of crying.
    ["2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"].forEach((date, index) => {
      const music = index % 2 === 0;
      const settle = music ? 10 : 30;
      readings.push(...run(at(date, "08:00"), 10, "playing", "floor", "yes"), ...run(at(date, "08:10"), settle, "moving", "floor"), ...run(at(date, "08:10") + settle * minute, 60, "resting", "bed"), ...run(at(date, "09:30"), 10, "playing", "floor", "yes"));
      sounds.push(...hear(at(date, "08:10"), 3, music ? 0 : 60), ...hear(at(date, "08:13"), settle + 57));
      if (music) events.push({ id: `m${index}`, t: at(date, "08:12"), kind: "comfort", detail: "dog-music", source: "camera" });
    });
    const report = buildAnalytics(input(readings, events, at("2026-09-28", "23:00"), sounds));
    expect(report.music).toMatchObject({ plays: 2, verdict: "helped", with_music: { episodes: 2, settle_minutes: 10, upset: 0 }, without_music: { episodes: 2, settle_minutes: 30 } });
    expect(report.music.without_music.crying_per_hour).toBeGreaterThan(report.music.with_music.crying_per_hour!);
    expect(report.tips.map(tip => tip.id)).toContain("music");
    // With only one stretch of each, it is too soon to say.
    const early = buildAnalytics(input(readings.filter(reading => reading.t >= at("2026-09-27", "00:00")), events, at("2026-09-28", "23:00"), sounds));
    expect(early.music.verdict).toBe("not_enough");
  });

  it("builds a sample week that fills every section and looks the same on each visit", () => {
    const now = new Date(2026, 8, 28, 21, 0).getTime();
    const first = sampleWeek(now);
    expect(first).toEqual(sampleWeek(now));
    const report = buildAnalytics({ ...first, now, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, dogName: "Simba", sample: true, realWatchedHours: 0.2, neededHours: 8, logging: false, loggingProblem: null });
    expect(report.sample).toBe(true);
    expect(report.watched_minutes).toBeGreaterThan(7 * 12 * 60);
    expect(report.feelings.episodes).toHaveLength(7);
    expect(report.feelings.counts).toEqual({ calm: 4, unsettled: 2, upset: 1 });
    expect(report.crying.listening).toBe(true);
    expect(report.crying.alone_crying_minutes).toBeGreaterThan(10);
    expect(report.music.verdict).toBe("helped");
    expect(report.naps.list.length).toBeGreaterThan(7);
    expect(report.comfort.find(item => item.sound === "Calm music")!.active_after).toBeLessThan(report.comfort.find(item => item.sound === "Calm music")!.active_before);
    expect(report.tips.map(tip => tip.id)).toEqual(expect.arrayContaining(["crying", "music"]));
    expect(report.ideas).toHaveLength(4);
    for (const link of [...report.tips.map(tip => tip.source.url), ...report.ideas.map(idea => idea.source.url)]) expect(link).toMatch(/^https:\/\/(www\.akc\.org|www\.aspca\.org|vcahospitals\.com|pubmed\.ncbi\.nlm\.nih\.gov)\//);
  });
});

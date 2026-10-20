import type { ActivityKey, AloneEpisode, AloneHour, ComfortStat, CryingStat, DayStat, Feelings, HourStat, Mood, MusicGroup, MusicStat, Nap, PetAnalytics, SpotKey, SpotStat } from "../shared/analytics.js";
import type { LoggedEvent, Reading, SoundReading } from "./dog-log.js";
import { chooseIdeas, chooseTips } from "./pet-advice.js";

export interface AnalyticsInput {
  readings: Reading[];
  sounds?: SoundReading[];
  events: LoggedEvent[];
  now: number;
  timeZone: string;
  dogName: string;
  sample: boolean;
  realWatchedHours: number;
  neededHours: number;
  logging: boolean;
  loggingProblem: string | null;
  /** Set when Tinybird could not be read just now and the page shows the last data it read. */
  readProblem?: string | null;
  /** Why crying cannot be heard yet, such as a sound model that is not set up. */
  soundProblem?: string | null;
  /** The crying cut-off tuned to the dog, and when; minutes before then were counted with the default. */
  soundTuning?: { cutoff: number; set_at: string } | null;
}

const activityKeys: ActivityKey[] = ["resting", "moving", "playing", "eating"];
const spotKeys: SpotKey[] = ["bed", "floor", "furniture", "door"];
const moods: Mood[] = ["calm", "unsettled", "upset"];
const minute = 60_000;
// A reading stands for the time until the next one, but never more than a minute. The last reading before a break in
// watching counts for the usual spacing between readings: about 12 seconds from the live camera.
const longestGap = minute;
const analysisGap = 12_000;

function durations(readings: Reading[]) {
  const gaps = readings.slice(1).map((reading, index) => reading.t - readings[index].t).filter(gap => gap > 0 && gap <= longestGap).sort((left, right) => left - right);
  const usual = gaps.length ? gaps[Math.floor(gaps.length / 2)] : analysisGap;
  return readings.map((reading, index) => {
    const gap = (readings[index + 1]?.t ?? Number.NaN) - reading.t;
    return gap > 0 && gap <= longestGap ? gap : usual;
  });
}
export function watchedHours(readings: Reading[]) {
  return durations(readings).reduce((sum, value) => sum + value, 0) / 3_600_000;
}

// Calendar date, hour and minute of the day in the owner's time zone.
function localClock(timeZone: string) {
  const format = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const cache = new Map<number, { date: string; hour: number; minute: number }>();
  return (t: number) => {
    const key = Math.floor(t / minute);
    let parts = cache.get(key);
    if (!parts) {
      const fields = Object.fromEntries(format.formatToParts(new Date(key * minute)).map(part => [part.type, part.value]));
      const hour = Number(fields.hour) % 24;
      parts = { date: `${fields.year}-${fields.month}-${fields.day}`, hour, minute: hour * 60 + Number(fields.minute) };
      cache.set(key, parts);
    }
    return parts;
  };
}
const weekday = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
const round = (value: number, places = 3) => Math.round(value * 10 ** places) / 10 ** places;
const share = (part: number, whole: number, floor: number) => whole >= floor ? round(part / whole) : null;
const isActive = (activity: string) => activity === "moving" || activity === "playing";
const soundName = (detail: string) => detail === "dog-music" ? "Calm music" : detail === "dog-noise" ? "Brown noise" : detail.startsWith("found:") ? "Found sounds" : null;
// The middle value, or the mean of the two middle values, rounded to whole minutes.
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length / 2;
  return Math.round(sorted.length % 2 ? sorted[Math.floor(middle)] : (sorted[middle - 1] + sorted[middle]) / 2);
};

/**
 * How a stretch alone seemed, from the signs of separation distress the ASPCA lists: crying, pacing and waiting at the
 * door. Upset: five minutes of crying or more, not settling within 45 minutes, or 30% of the time at the door.
 * Calm: settled within 20 minutes, with under a minute of crying and little time at the door. Anything else is unsettled.
 */
export function moodOf(episode: Pick<AloneEpisode, "minutes" | "settle_minutes" | "door_share" | "crying_minutes">): Mood {
  const cried = episode.crying_minutes ?? 0;
  const door = episode.door_share ?? 0;
  const settledLate = episode.settle_minutes === null ? episode.minutes >= 45 : episode.settle_minutes >= 45;
  if (cried >= 5 || settledLate || door >= 0.3) return "upset";
  if (episode.settle_minutes !== null && episode.settle_minutes <= 20 && cried < 1 && door < 0.1) return "calm";
  return "unsettled";
}

export function buildAnalytics(input: AnalyticsInput): PetAnalytics {
  const local = localClock(input.timeZone);
  const today = local(input.now).date;
  // The last seven dates, counted on the calendar so a clock change never skips or repeats one.
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${today}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (6 - index));
    return date.toISOString().slice(0, 10);
  });
  const inRange = new Set(days);
  const readings = [...input.readings].filter(reading => reading.t <= input.now && inRange.has(local(reading.t).date)).sort((left, right) => left.t - right.t);
  const sounds = [...(input.sounds ?? [])].filter(sound => sound.t <= input.now && inRange.has(local(sound.t).date)).sort((left, right) => left.t - right.t);
  const comfortEvents = input.events.filter(event => event.kind === "comfort" && event.t <= input.now);
  const spans = durations(readings);
  const known = (reading: Reading) => reading.visible === "yes" && (activityKeys as string[]).includes(reading.activity);

  // Activity: how the watched time was spent, by hour of day and by date.
  const byActivity: Record<ActivityKey, number> = { resting: 0, moving: 0, playing: 0, eating: 0 };
  const hours = Array.from({ length: 24 }, () => ({ known: 0, active: 0, resting: 0 }));
  const perDay = new Map(days.map(date => [date, { watched: 0, active: 0 }]));
  let watched = 0;
  readings.forEach((reading, index) => {
    const span = spans[index];
    const when = local(reading.t);
    watched += span;
    const dayTotals = perDay.get(when.date)!;
    dayTotals.watched += span;
    if (!known(reading)) return;
    byActivity[reading.activity as ActivityKey] += span;
    hours[when.hour].known += span;
    if (isActive(reading.activity)) { hours[when.hour].active += span; dayTotals.active += span; }
    if (reading.activity === "resting") hours[when.hour].resting += span;
  });
  const knownTotal = activityKeys.reduce((sum, key) => sum + byActivity[key], 0);
  // An hour needs 20 minutes of watching before it is charted or ranked, so the bars and the busiest hour agree.
  const byHour: HourStat[] = hours.map((totals, hour) => ({ hour, watched_minutes: Math.round(totals.known / minute), active_share: share(totals.active, totals.known, 20 * minute) }));
  const busiest = byHour.filter(hour => hour.active_share !== null).sort((left, right) => right.active_share! - left.active_share!)[0];

  // Naps: unbroken resting of at least ten minutes, with no gap in watching longer than a minute and a half.
  const restRuns: { start: number; end: number }[] = [];
  let restStart: number | null = null;
  let restEnd = 0;
  const closeRest = () => {
    if (restStart !== null && restEnd - restStart >= 10 * minute) restRuns.push({ start: restStart, end: restEnd });
    restStart = null;
  };
  readings.forEach((reading, index) => {
    const resting = reading.visible === "yes" && reading.activity === "resting";
    const continuous = index > 0 && reading.t - readings[index - 1].t <= 90_000;
    if (resting && restStart !== null && continuous) { restEnd = reading.t + spans[index]; return; }
    closeRest();
    if (resting) { restStart = reading.t; restEnd = reading.t + spans[index]; }
  });
  closeRest();
  const naps: Nap[] = restRuns.map(run => ({ date: local(run.start).date, start_minute: local(run.start).minute, minutes: Math.round((run.end - run.start) / minute) }));

  // Favourite spots: where the dog was seen, by time.
  const spotTime: Record<SpotKey, number> = { bed: 0, floor: 0, furniture: 0, door: 0 };
  readings.forEach((reading, index) => { if (reading.visible === "yes" && (spotKeys as string[]).includes(reading.location)) spotTime[reading.location as SpotKey] += spans[index]; });
  const spotTotal = spotKeys.reduce((sum, key) => sum + spotTime[key], 0);
  const spots: SpotStat[] = spotKeys.map(spot => ({ spot, share: spotTotal ? round(spotTime[spot] / spotTotal) : 0, minutes: Math.round(spotTime[spot] / minute) })).sort((left, right) => right.minutes - left.minutes);

  // Time alone: watched time with nobody in view.
  const aloneHours = Array.from({ length: 24 }, () => ({ total: 0, restless: 0 }));
  let aloneTotal = 0; let aloneRestless = 0; let aloneDoor = 0; let aloneResting = 0;
  readings.forEach((reading, index) => {
    if (!known(reading) || reading.person !== "no") return;
    const span = spans[index];
    const hour = local(reading.t).hour;
    aloneTotal += span; aloneHours[hour].total += span;
    if (reading.activity === "moving") { aloneRestless += span; aloneHours[hour].restless += span; }
    if (reading.activity === "resting") aloneResting += span;
    if (reading.location === "door") aloneDoor += span;
  });
  // An hour needs 20 minutes alone before it is charted or ranked, so the chart and the calmest and most unsettled hours agree.
  const aloneByHour: AloneHour[] = aloneHours.map((totals, hour) => ({ hour, minutes: Math.round(totals.total / minute), restless_share: share(totals.restless, totals.total, 20 * minute) }));
  const rankedAlone = aloneByHour.filter(hour => hour.restless_share !== null).sort((left, right) => left.restless_share! - right.restless_share!);
  const unsettled = rankedAlone.at(-1);

  // Stretches alone: nobody in view, with no break in watching longer than five minutes. Stretches under 15 minutes are
  // too short to say how the dog coped.
  const stretches: { first: number; last: number }[] = [];
  let open: { first: number; last: number } | null = null;
  readings.forEach((reading, index) => {
    if (reading.person === "no") {
      if (open && reading.t - readings[open.last].t <= 5 * minute) open.last = index;
      else { if (open) stretches.push(open); open = { first: index, last: index }; }
    } else if (reading.person === "yes" && open) { stretches.push(open); open = null; }
  });
  if (open) stretches.push(open);
  const soundsBetween = (from: number, to: number) => sounds.filter(sound => sound.t >= from && sound.t < to);
  const episodes: (AloneEpisode & { startAt: number; endAt: number })[] = stretches.flatMap(({ first, last }) => {
    const startAt = readings[first].t;
    const endAt = readings[last].t + spans[last];
    const length = Math.round((endAt - startAt) / minute);
    if (length < 15) return [];
    let seen = 0; let moving = 0; let door = 0;
    for (let index = first; index <= last; index++) {
      const reading = readings[index];
      if (!known(reading)) continue;
      seen += spans[index];
      if (reading.activity === "moving") moving += spans[index];
      if (reading.location === "door") door += spans[index];
    }
    // Settling needs ten minutes of rest while alone. A rest already under way as you leave counts from the start, so a dog
    // that sleeps on is settled at once and one that wakes as the door shuts is not; a rest cut short by your return counts
    // only if ten minutes of it came first.
    const settled = restRuns.find(run => Math.min(run.end, endAt) - Math.max(run.start, startAt) >= 10 * minute);
    const heard = soundsBetween(startAt, endAt);
    const heardSeconds = heard.reduce((sum, sound) => sum + sound.heard, 0);
    const episode = {
      date: local(startAt).date, start_minute: local(startAt).minute, minutes: length,
      settle_minutes: settled ? Math.max(0, Math.round((settled.start - startAt) / minute)) : null,
      restless_share: share(moving, seen, 5 * minute), door_share: share(door, seen, 5 * minute),
      heard_minutes: Math.round(heardSeconds / 60),
      crying_minutes: heardSeconds ? round(heard.reduce((sum, sound) => sum + sound.crying, 0) / 60, 1) : null,
      music: comfortEvents.some(event => event.t >= startAt - 5 * minute && event.t < endAt),
      startAt, endAt
    };
    // A stretch where the dog was in view for under half the time cannot be read from behaviour, so it gets no mood,
    // unless it was heard crying for five minutes or more.
    const seenEnough = seen >= (endAt - startAt) / 2;
    return [{ ...episode, seen_enough: seenEnough, mood: seenEnough ? moodOf(episode) : (episode.crying_minutes ?? 0) >= 5 ? "upset" as Mood : null }];
  });
  const judged = episodes.filter(episode => episode.seen_enough);
  const moodMinutes = Object.fromEntries(moods.map(mood => [mood, episodes.filter(episode => episode.mood === mood).reduce((sum, episode) => sum + episode.minutes, 0)])) as Record<Mood, number>;
  const feelings: Feelings = {
    episodes: episodes.map(({ startAt: _start, endAt: _end, ...episode }) => episode),
    counts: Object.fromEntries(moods.map(mood => [mood, episodes.filter(episode => episode.mood === mood).length])) as Record<Mood, number>,
    mostly: episodes.some(episode => episode.mood) ? [...moods].sort((left, right) => moodMinutes[right] - moodMinutes[left])[0] : null,
    typical_settle_minutes: median(judged.flatMap(episode => episode.settle_minutes === null ? [] : [episode.settle_minutes])),
    alone_minutes: episodes.reduce((sum, episode) => sum + episode.minutes, 0)
  };

  // Crying, from the minutes the camera's microphone was heard.
  const aloneAt = (t: number) => episodes.some(episode => t >= episode.startAt && t < episode.endAt);
  const cryingHours = Array.from({ length: 24 }, () => ({ crying: 0, heard: 0 }));
  const cryingDays = new Map(days.map(date => [date, { crying: 0, heard: 0 }]));
  let longest = 0; let run = 0; let previous = -Infinity;
  for (const sound of sounds) {
    // A minute alone counts toward a stretch of crying when a quarter of it or more was crying.
    const alone = aloneAt(sound.t);
    const crying = alone && sound.crying >= 15;
    run = crying ? (sound.t - previous <= minute ? run + 1 : 1) : 0;
    if (crying) previous = sound.t;
    longest = Math.max(longest, run);
    if (!alone) continue;
    const when = local(sound.t);
    cryingHours[when.hour].crying += sound.crying; cryingHours[when.hour].heard += sound.heard;
    const day = cryingDays.get(when.date)!;
    day.crying += sound.crying; day.heard += sound.heard;
  }
  const heardTotal = sounds.reduce((sum, sound) => sum + sound.heard, 0);
  const crying: CryingStat = {
    listening: heardTotal > 0,
    heard_minutes: Math.round(heardTotal / 60),
    crying_minutes: round(sounds.reduce((sum, sound) => sum + sound.crying, 0) / 60, 1),
    alone_crying_minutes: round([...cryingDays.values()].reduce((sum, day) => sum + day.crying, 0) / 60, 1),
    barking_minutes: round(sounds.reduce((sum, sound) => sum + sound.barking, 0) / 60, 1),
    longest_minutes: longest,
    by_day: days.map(date => { const day = cryingDays.get(date)!; return { date, label: date === today ? "Today" : weekday(date), crying_minutes: day.heard ? round(day.crying / 60, 1) : null, heard_minutes: Math.round(day.heard / 60) }; }),
    by_hour: cryingHours.map((totals, hour) => ({ hour, crying_minutes: round(totals.crying / 60, 1), heard_minutes: Math.round(totals.heard / 60) }))
  };

  // Did the music help? Stretches alone with a comfort sound are compared with those without: how long the dog took to
  // settle (a stretch that never settled counts its whole length), and how much it cried per hour heard.
  const group = (list: typeof episodes): MusicGroup => {
    const heardMinutes = list.reduce((sum, episode) => sum + episode.heard_minutes, 0);
    const cried = list.reduce((sum, episode) => sum + (episode.crying_minutes ?? 0), 0);
    return {
      episodes: list.length,
      settle_minutes: median(list.map(episode => episode.settle_minutes ?? episode.minutes)),
      crying_per_hour: heardMinutes >= 10 ? round((cried / heardMinutes) * 60, 1) : null,
      upset: list.filter(episode => episode.mood === "upset").length
    };
  };
  // Only stretches the dog was seen for enough of are compared, since the others have no reliable settling time.
  const withMusic = group(judged.filter(episode => episode.music));
  const withoutMusic = group(judged.filter(episode => !episode.music));
  const verdict = ((): MusicStat["verdict"] => {
    if (withMusic.episodes < 2 || withoutMusic.episodes < 2) return "not_enough";
    const settleGain = (withoutMusic.settle_minutes ?? 0) - (withMusic.settle_minutes ?? 0);
    const cryCompare = withMusic.crying_per_hour !== null && withoutMusic.crying_per_hour !== null;
    const better = settleGain >= 5 || (cryCompare && withoutMusic.crying_per_hour! >= 1 && withMusic.crying_per_hour! <= withoutMusic.crying_per_hour! * 0.7);
    const worse = settleGain <= -5 || (cryCompare && withMusic.crying_per_hour! >= 1 && withMusic.crying_per_hour! >= withoutMusic.crying_per_hour! * 1.3);
    return better && !worse ? "helped" : worse && !better ? "worse" : "no_difference";
  })();
  const music: MusicStat = { plays: comfortEvents.filter(event => inRange.has(local(event.t).date)).length, with_music: withMusic, without_music: withoutMusic, verdict };

  // Comfort sounds: how active the dog was in the 15 minutes before each sound started and the 15 minutes after.
  const windowShare = (from: number, to: number) => {
    let total = 0; let active = 0;
    readings.forEach((reading, index) => { if (reading.t >= from && reading.t < to && known(reading)) { total += spans[index]; if (isActive(reading.activity)) active += spans[index]; } });
    return total >= 5 * minute ? active / total : null;
  };
  const comfortTotals = new Map<string, { plays: number; before: number; after: number }>();
  for (const event of comfortEvents) {
    const sound = soundName(event.detail);
    if (!sound) continue;
    const before = windowShare(event.t - 15 * minute, event.t);
    const after = windowShare(event.t, event.t + 15 * minute);
    if (before === null || after === null) continue;
    const totals = comfortTotals.get(sound) ?? { plays: 0, before: 0, after: 0 };
    totals.plays += 1; totals.before += before; totals.after += after;
    comfortTotals.set(sound, totals);
  }
  const comfort: ComfortStat[] = [...comfortTotals].map(([sound, totals]) => ({ sound, plays: totals.plays, active_before: round(totals.before / totals.plays), active_after: round(totals.after / totals.plays) }));

  const byDay: DayStat[] = days.map(date => {
    const napsThatDay = naps.filter(nap => nap.date === date);
    const totals = perDay.get(date)!;
    return { date, label: date === today ? "Today" : weekday(date), watched_minutes: Math.round(totals.watched / minute), active_minutes: Math.round(totals.active / minute), naps: napsThatDay.length, longest_nap_minutes: Math.max(0, ...napsThatDay.map(nap => nap.minutes)) };
  });
  // Today is not over, so rates per day use the complete days before it (or today, on the first day).
  const fullDays = byDay.filter(entry => entry.date !== today && entry.watched_minutes >= 60);
  const rateDays = fullDays.length ? fullDays : byDay.filter(entry => entry.watched_minutes >= 60);
  const napsPerDay = rateDays.length ? round(rateDays.reduce((sum, entry) => sum + entry.naps, 0) / rateDays.length, 1) : null;
  const longestNap = Math.max(0, ...naps.map(nap => nap.minutes));
  const usualHours = hours.map((totals, hour) => ({ hour, resting: totals.resting })).filter(hour => hour.resting > 0).sort((left, right) => right.resting - left.resting).slice(0, 3).map(hour => hour.hour).sort((left, right) => left - right);
  const activeShare = share(byActivity.moving + byActivity.playing, knownTotal, 10 * minute);
  const aloneShare = (part: number) => share(part, aloneTotal, 10 * minute);
  const cryingDaysHeard = crying.by_day.filter(day => day.date !== today && day.heard_minutes >= 30);
  const facts = {
    dogName: input.dogName,
    watchedHours: watched / 3_600_000,
    activeShare,
    alone: { minutes: aloneTotal / minute, restless: aloneShare(aloneRestless), door: aloneShare(aloneDoor) },
    naps: { perDay: napsPerDay, longest: longestNap },
    comfort,
    feelings: { ...feelings.counts, typicalSettle: feelings.typical_settle_minutes },
    crying: { minutesPerDay: cryingDaysHeard.length ? round(cryingDaysHeard.reduce((sum, day) => sum + (day.crying_minutes ?? 0), 0) / cryingDaysHeard.length, 1) : null },
    music
  };

  return {
    dog_name: input.dogName,
    sample: input.sample,
    real_watched_hours: round(input.realWatchedHours, 1),
    needed_hours: input.neededHours,
    logging: input.logging,
    logging_problem: input.loggingProblem,
    read_problem: input.readProblem ?? null,
    time_zone: input.timeZone,
    days,
    watched_minutes: Math.round(watched / minute),
    activity: {
      shares: Object.fromEntries(activityKeys.map(key => [key, knownTotal ? round(byActivity[key] / knownTotal) : 0])) as Record<ActivityKey, number>,
      active_share: activeShare,
      by_hour: byHour,
      by_day: byDay,
      most_active_hour: busiest?.hour ?? null
    },
    naps: { list: naps, per_day: napsPerDay, longest_minutes: longestNap, usual_hours: usualHours },
    spots,
    alone: {
      watched_minutes: Math.round(aloneTotal / minute),
      restless_share: aloneShare(aloneRestless),
      door_share: aloneShare(aloneDoor),
      resting_share: aloneShare(aloneResting),
      calmest_hour: rankedAlone[0]?.hour ?? null,
      most_unsettled_hour: unsettled && unsettled.hour !== rankedAlone[0]?.hour && (unsettled.restless_share ?? 0) >= 0.15 ? unsettled.hour : null,
      by_hour: aloneByHour
    },
    feelings,
    crying,
    music,
    comfort,
    sound_problem: input.soundProblem ?? null,
    sound_tuning: input.soundTuning ?? null,
    tips: chooseTips(facts),
    ideas: chooseIdeas(facts)
  };
}

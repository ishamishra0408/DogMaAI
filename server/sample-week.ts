import type { LoggedEvent, Reading, SoundReading } from "./dog-log.js";

// The labelled sample week PetAnalytics shows until the dog's own data covers enough watching.
// A seeded random per calendar day keeps it the same on every visit.
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Block { from: number; minutes: number; visible: string; activity: string; location: string; person: string }

export function sampleWeek(now: number): { readings: Reading[]; sounds: SoundReading[]; events: LoggedEvent[] } {
  const readings: Reading[] = [];
  const sounds: SoundReading[] = [];
  const events: LoggedEvent[] = [];
  for (let back = 6; back >= 0; back--) {
    // Counted on the calendar, so a clock change never skips or repeats a day.
    const midnightDate = new Date(now);
    midnightDate.setHours(0, 0, 0, 0);
    midnightDate.setDate(midnightDate.getDate() - back);
    const midnight = midnightDate.getTime();
    const key = `${midnightDate.getFullYear()}-${midnightDate.getMonth() + 1}-${midnightDate.getDate()}`;
    const random = seeded(midnightDate.getFullYear() * 1000 + midnightDate.getMonth() * 40 + midnightDate.getDate());
    const between = (low: number, high: number) => Math.round(low + random() * (high - low));
    const dayIndex = 6 - back;
    const blocks: Block[] = [];
    let cursor = 7 * 60 + between(-10, 10);
    const block = (minutes: number, activity: string, location: string, person: string, visible = "yes") => { blocks.push({ from: cursor, minutes, visible, activity, location, person }); cursor += minutes; };
    const event = (kind: string, detail: string, source: string) => events.push({ id: `sample-${key}-${events.length}`, t: midnight + (cursor + 1) * 60_000, kind, detail, source });
    // Seconds of crying and barking in given minutes of the day, and the minutes the camera's microphone is muted.
    const crying = new Map<number, number>();
    const barking = new Map<number, number>();
    const cry = (from: number, minutes: number, low: number, high: number) => { for (let offset = 0; offset < minutes; offset++) crying.set(from + offset, between(low, high)); };
    let mutedFrom = -1; let mutedUntil = -1;

    // Morning with the family.
    block(between(15, 30), "moving", "floor", "yes");
    block(between(5, 8), "eating", "floor", "yes");
    block(between(15, 30), "playing", "floor", "yes");
    block(between(10, 20), "resting", "furniture", "yes");
    // Left alone, the dog paces and cries at the door. On alternate days calm music starts partway through and plays for
    // half an hour through the camera, which mutes its microphone, and the dog settles sooner. One day is harder.
    const music = dayIndex % 2 === 0;
    const hard = dayIndex === 3;
    const left = cursor;
    block(music ? between(8, 11) : hard ? between(32, 36) : between(15, 19), "moving", "door", "no");
    if (music) { event("comfort", "dog-music", "camera"); mutedFrom = cursor; mutedUntil = cursor + 30; }
    block(music ? between(4, 6) : hard ? between(12, 15) : between(9, 12), "moving", "floor", "no");
    cry(left + 1, music ? 2 : hard ? 16 : 8, music ? 10 : hard ? 30 : 20, music ? 20 : hard ? 50 : 45);
    // The day alone: long naps with short bouts of pottering and play.
    let outOfView = dayIndex !== 4;
    while (cursor < 16 * 60 + 20) {
      block(between(45, 100), "resting", random() < 0.7 ? "bed" : "furniture", "no");
      if (outOfView && cursor > 12 * 60) { block(between(3, 8), "unknown", "unknown", "no", "no"); outOfView = false; }
      if (random() < 0.6) block(between(5, 12), "moving", "floor", "no"); else block(between(5, 10), "playing", "floor", "no");
    }
    // Waiting for the family, with a little whining on days without music, then an evening together and a few happy barks.
    const waiting = cursor;
    block(between(15, 30), "moving", random() < 0.6 ? "door" : "floor", "no");
    if (!music) cry(waiting + 5, between(1, 2), 10, 20);
    block(between(5, 15), "resting", "floor", "no");
    const home = cursor;
    block(between(8, 12), "moving", "floor", "yes");
    for (let offset = 0; offset < 2; offset++) barking.set(home + offset, between(4, 9));
    block(between(20, 35), "playing", "floor", "yes");
    block(between(6, 9), "eating", "floor", "yes");
    block(between(10, 20), "moving", "floor", "yes");
    block(Math.max(10, 20 * 60 + 30 - cursor), "resting", random() < 0.5 ? "furniture" : "bed", "yes");

    for (const item of blocks) {
      for (let offset = 0; offset < item.minutes; offset++) {
        const minuteOfDay = item.from + offset;
        const t = midnight + minuteOfDay * 60_000;
        if (t > now) break;
        readings.push({ t, visible: item.visible, activity: item.activity, location: item.location, person: item.person });
        if (minuteOfDay >= mutedFrom && minuteOfDay < mutedUntil) continue;
        sounds.push({ t, heard: 60, crying: crying.get(minuteOfDay) ?? 0, barking: barking.get(minuteOfDay) ?? 0 });
      }
    }
  }
  return { readings, sounds, events: events.filter(item => item.t <= now) };
}

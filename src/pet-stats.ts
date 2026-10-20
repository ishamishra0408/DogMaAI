import type { Mood, MusicStat, PetAnalytics, SpotKey } from "../shared/analytics";

export const spotNames: Record<SpotKey, string> = { bed: "Bed", floor: "Floor", furniture: "Sofa & chairs", door: "By the door" };
export const pct = (share: number | null) => share === null ? "—" : `${Math.round(share * 100)}%`;
export const clock = (minuteOfDay: number) => { const hour = Math.floor(minuteOfDay / 60) % 24; return `${hour % 12 || 12}:${String(minuteOfDay % 60).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`; };
export const hourName = (hour: number) => `${hour % 12 || 12} ${hour < 12 ? "am" : "pm"}`;
export const shortHour = (hour: number) => `${hour % 12 || 12}${hour < 12 ? "a" : "p"}`;
// The name may be the default "your dog", so a title or sentence that opens with it gets a capital.
export const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export const span = (minutes: number) => minutes >= 60 ? `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;

/** Minutes that can be a fraction, such as crying: under a minute reads as such rather than as nothing. */
export const minutesText = (minutes: number | null) => minutes === null ? "—" : minutes > 0 && minutes < 1 ? "under 1 min" : span(Math.round(minutes));
export const moodNames: Record<Mood, string> = { calm: "Calm", unsettled: "Unsettled", upset: "Upset" };
export const verdictNames: Record<MusicStat["verdict"], string> = { helped: "Seems to", no_difference: "Not clearly", worse: "Not really", not_enough: "Too soon" };

export interface FlipSide { label: string; value: string; note: string }
export interface FlipStat { key: "felt" | "cried" | "music" | "alone"; front: FlipSide; back: FlipSide }

// The bento tiles: each shows one view and flips to another when tapped, like the height on joshwcomeau.com.
export function flipStats(report: PetAnalytics): FlipStat[] {
  const { feelings, crying, music } = report;
  const today = report.days.at(-1);
  const times = feelings.episodes.length;
  const unseen = feelings.episodes.filter(episode => !episode.mood).length;
  const judged = feelings.episodes.filter(episode => episode.seen_enough).length;
  const settleNote = feelings.typical_settle_minutes !== null ? `Usually settled after ${span(feelings.typical_settle_minutes)}`
    : !times ? "Needs time alone on camera" : !judged ? "Out of view most of the time alone" : "Not seen to settle yet";
  // Amounts a day leave out today, which is not over: crying counts days heard for half an hour or more while alone.
  const heardDays = crying.by_day.filter(day => day.date !== today && day.heard_minutes >= 30);
  const cryingPerDay = heardDays.length ? heardDays.reduce((sum, day) => sum + (day.crying_minutes ?? 0), 0) / heardDays.length : null;
  const aloneByDay = new Map<string, number>();
  for (const episode of feelings.episodes) if (episode.date !== today) aloneByDay.set(episode.date, (aloneByDay.get(episode.date) ?? 0) + episode.minutes);
  const alonePerDay = aloneByDay.size ? Math.round([...aloneByDay.values()].reduce((sum, minutes) => sum + minutes, 0) / aloneByDay.size) : null;
  const longestAlone = Math.max(0, ...feelings.episodes.map(episode => episode.minutes));
  const withMusic = music.with_music; const withoutMusic = music.without_music;
  return [
    {
      key: "felt",
      front: { label: "Felt when alone", value: feelings.mostly ? `Mostly ${moodNames[feelings.mostly].toLowerCase()}` : "—", note: settleNote },
      back: { label: "Times alone", value: String(times), note: times ? `${feelings.counts.calm} calm · ${feelings.counts.unsettled} unsettled · ${feelings.counts.upset} upset${unseen ? ` · ${unseen} not seen` : ""}` : "None seen yet" }
    },
    {
      key: "cried",
      front: { label: "Cried when alone", value: crying.listening ? minutesText(crying.alone_crying_minutes) : "—", note: crying.listening ? "This week, while alone" : "Waiting to hear the camera" },
      back: { label: "Crying a day", value: minutesText(cryingPerDay), note: crying.longest_minutes ? `Longest stretch ${span(crying.longest_minutes)}` : "No long stretches heard" }
    },
    {
      key: "music",
      front: { label: "Did music help?", value: verdictNames[music.verdict], note: music.verdict === "not_enough" ? "Needs 2 times alone with music and 2 without" : `Settled after ${span(withMusic.settle_minutes ?? 0)} with music, ${span(withoutMusic.settle_minutes ?? 0)} without` },
      back: { label: "Music played", value: String(music.plays), note: withMusic.crying_per_hour !== null && withoutMusic.crying_per_hour !== null ? `Cried ${withMusic.crying_per_hour} vs ${withoutMusic.crying_per_hour} min an hour alone` : `${music.plays === 1 ? "Time" : "Times"} this week` }
    },
    {
      key: "alone",
      front: { label: "Time alone", value: span(feelings.alone_minutes), note: "This week, on camera" },
      back: { label: "Alone a day", value: alonePerDay === null ? "—" : span(alonePerDay), note: longestAlone ? `Longest stretch ${span(longestAlone)}` : "None seen yet" }
    }
  ];
}

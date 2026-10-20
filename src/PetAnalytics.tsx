import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ActivityKey, AloneEpisode, Mood, PetAnalytics } from "../shared/analytics";
import { CloudEdge, DogsPlaying, DogsTogether, SleepyDog } from "./DogArt";
import { managerApi } from "./ManagerSetup";
import { Bars, ChartCard, Columns, DayRows, Dumbbell, SplitBar, colors } from "./PetCharts";
import { capital, clock, flipStats, hourName, minutesText, moodNames, pct, shortHour, span, spotNames, verdictNames, type FlipStat } from "./pet-stats";
import { Numbers } from "./Whimsy";
import "./pet-analytics.css";

const activityNames: Record<ActivityKey, string> = { resting: "Resting", moving: "Moving", playing: "Playing", eating: "Eating" };
const moods: Mood[] = ["calm", "unsettled", "upset"];
// A stretch the camera saw too little of says so, rather than "did not settle"; one judged from crying alone says that.
const settleText = (episode: AloneEpisode) => episode.settle_minutes !== null ? span(episode.settle_minutes) : episode.seen_enough ? "Did not settle" : "Not seen";
const seemedText = (episode: AloneEpisode) => !episode.mood ? "Not seen enough" : episode.seen_enough ? moodNames[episode.mood] : `${moodNames[episode.mood]}, from crying`;
const dayTicks = [6, 9, 12, 15, 18, 21].map(hour => ({ minute: hour * 60, label: shortHour(hour) }));

type IconName = "paw" | "moon" | "home" | "music" | "clock" | "spark" | "heart" | "tear";
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    paw: <><ellipse cx="12" cy="15.6" rx="4.4" ry="3.7" /><circle cx="6.4" cy="10.2" r="1.9" /><circle cx="9.9" cy="6.3" r="1.9" /><circle cx="14.1" cy="6.3" r="1.9" /><circle cx="17.6" cy="10.2" r="1.9" /></>,
    moon: <path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5Z" />,
    home: <><path d="m3 11 9-7 9 7v9H3Z" /><path d="M9.5 20v-5h5v5" /></>,
    music: <><path d="M9 17V5l10-2v12" /><circle cx="6.5" cy="17" r="2.5" /><circle cx="16.5" cy="15" r="2.5" /></>,
    clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
    spark: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />,
    heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z" />,
    tear: <path d="M12 3.5C9.2 7.6 6.5 10.8 6.5 14a5.5 5.5 0 0 0 11 0c0-3.2-2.7-6.4-5.5-10.5Z" />
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

const tileIcons: Record<FlipStat["key"], IconName> = { felt: "heart", cried: "tear", music: "music", alone: "home" };
// A bento tile that flips between two views of its number when tapped, like the height on joshwcomeau.com.
function FlipTile({ stat, tag, art }: { stat: FlipStat; tag?: string; art?: ReactNode }) {
  const [flipped, setFlipped] = useState(false);
  const side = flipped ? stat.back : stat.front;
  return <button className={`pa-tile pa-tile-${stat.key}`} data-sound="flip" aria-pressed={flipped} onClick={() => setFlipped(!flipped)}>
    <span className="pa-tile-icon" aria-hidden="true"><Icon name={tileIcons[stat.key]} /></span>
    <span className="pa-tile-label">{side.label}{tag && <> <span className="pa-tag">{tag}</span></>}</span>
    <strong key={`value-${flipped}`} className="pa-flip-in">{side.value}</strong>
    <small key={`note-${flipped}`} className="pa-flip-in"><Numbers text={side.note} /></small>
    <span className="pa-flip-hint" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4.5 10a8 8 0 0 1 14-3.5L20 8M20 3.5V8h-4.5M19.5 14a8 8 0 0 1-14 3.5L4 16M4 20.5V16h4.5" /></svg></span>
    <span className="visually-hidden">Flip for another view</span>
    {art}
  </button>;
}

// A cute, dog-only dashboard of the last seven days: how the dog felt alone, how long it cried, whether the music helped,
// and how it spent the day, built from the camera's readings and microphone minutes in Tinybird.
export function PetAnalyticsPage({ active, onTuneHearing }: { active: boolean; onTuneHearing?: () => void }) {
  const [report, setReport] = useState<PetAnalytics | null>(null);
  const [view, setView] = useState<"auto" | "real">("auto");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setReport(await managerApi<PetAnalytics>(`analytics${view === "real" ? "?view=real" : ""}`)); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "PetAnalytics could not load."); }
    finally { setLoading(false); }
  }, [view]);
  useEffect(() => {
    if (!active) return;
    void load();
    // A tab left in the background does not refresh; each refresh can cost Tinybird reads.
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => clearInterval(timer);
  }, [active, load]);

  if (!report) return <div className="pa"><div className="pa-empty"><DogsTogether className="pa-empty-art" /><p>{error || "Fetching the week…"}</p></div></div>;
  const name = report.dog_name;
  const possessive = `${name}${name.endsWith("s") ? "'" : "'s"}`;
  const dayLabel = (date: string) => report.activity.by_day.find(entry => entry.date === date)?.label ?? date;
  const dayRows = report.activity.by_day.map(entry => ({ key: entry.date, label: entry.label }));
  const noWatching = report.watched_minutes === 0;
  const dayMax = Math.max(60, ...report.activity.by_day.map(entry => entry.active_minutes));
  const dayCeiling = Math.ceil(dayMax / 60) * 60;
  const napsPerDay = report.naps.per_day === null ? null : Math.round(report.naps.per_day);
  const { feelings, crying, music } = report;
  const unseen = feelings.episodes.filter(episode => !episode.mood).length;
  const cryMax = Math.max(5, ...crying.by_day.map(day => day.crying_minutes ?? 0));
  // A scale in tens keeps the middle tick on a whole number.
  const cryCeiling = Math.ceil(cryMax / 10) * 10;
  const settleWith = music.with_music.settle_minutes; const settleWithout = music.without_music.settle_minutes;
  const settleMax = Math.max(1, settleWith ?? 0, settleWithout ?? 0);
  const cryWith = music.with_music.crying_per_hour; const cryWithout = music.without_music.crying_per_hour;
  const cryRateMax = Math.max(0.1, cryWith ?? 0, cryWithout ?? 0);
  // A one-line answer to the three questions, as far as the week can say.
  const summary = [
    feelings.mostly ? `Mostly ${moodNames[feelings.mostly].toLowerCase()} when alone` : null,
    crying.listening ? `cried ${minutesText(crying.alone_crying_minutes)} while alone` : null,
    music.verdict === "helped" ? "music seemed to help" : music.verdict === "worse" ? "music did not seem to help" : music.verdict === "no_difference" ? "music made no clear difference" : null
  ].filter(Boolean).join(" · ");
  // In the sample week every figure carries its own marker, not only the banner at the top.
  const tag = report.sample ? "Sample" : undefined;

  return <div className={`pa ${loading ? "pa-loading" : ""}`}>
    <header className="pa-hero">
      <div className="pa-hero-text">
        <p className="pa-kicker"><Icon name="paw" />PetAnalytics</p>
        <h1>{capital(possessive)} week{report.sample && <> <span className="pa-badge pa-title-badge">Sample</span></>}</h1>
        <p><Numbers text={`${report.sample ? "A sample week" : "What the camera saw and heard"} · the last 7 days · ${span(report.watched_minutes)} watched`} /></p>
        {summary && <p className="pa-summary"><Numbers text={capital(summary)} /></p>}
      </div>
      <DogsPlaying className="pa-hero-art" />
      <CloudEdge className="pa-hero-clouds" />
    </header>

    {report.sample && <div className="pa-sample" role="note">
      <span className="pa-badge">Sample week</span>
      <p><Numbers text={`This is example data, so you can see every chart. ${capital(possessive)} own data takes over once DogMaAI has watched for ${report.needed_hours} h; so far it has watched for ${report.real_watched_hours} h.`} /></p>
      {report.real_watched_hours > 0 && <button className="quiet-link" data-sound="tap" onClick={() => setView("real")}>Show {possessive} data so far</button>}
    </div>}
    {!report.sample && view === "real" && report.real_watched_hours < report.needed_hours && <div className="pa-sample" role="note">
      <span className="pa-badge">Early days</span>
      <p><Numbers text={`These charts use only ${report.real_watched_hours} h of watching, so they will change a lot as more comes in.`} /></p>
      <button className="quiet-link" data-sound="tap" onClick={() => setView("auto")}>Back to the sample week</button>
    </div>}
    {!report.logging && report.logging_problem && <p className="pa-problem" role="status">{report.logging_problem}</p>}
    {report.read_problem && <p className="pa-notice" role="status">{report.read_problem}</p>}
    {report.sound_problem && <p className="pa-notice" role="status">{report.sound_problem}</p>}
    {error && <p className="pa-problem" role="status">{error}</p>}

    {noWatching ? <div className="pa-empty"><DogsTogether className="pa-empty-art" /><p>Nothing to show yet. Use the home camera with Liquid AI running, and PetAnalytics fills in as {name} goes about the day.</p></div> : <>
      <div className="pa-tiles">
        {flipStats(report).map(stat => <FlipTile key={stat.key} stat={stat} tag={tag} art={stat.key === "felt" ? <DogsTogether className="pa-tile-art" /> : undefined} />)}
      </div>

      <div className="pa-grid">
        <ChartCard tag={tag} wide icon={<Icon name="heart" />} title={`How ${name} felt when alone`} subtitle="Each stretch with nobody in view, read from settling down, pacing, waiting at the door and crying"
          table={{ head: ["Day", "From", "Alone", "Settled after", "Cried", "Music", "Seemed"], rows: feelings.episodes.map(episode => [dayLabel(episode.date), clock(episode.start_minute), span(episode.minutes), settleText(episode), episode.crying_minutes === null ? "Not heard" : minutesText(episode.crying_minutes), episode.music ? "Yes" : "No", seemedText(episode)]) }}>
          {feelings.episodes.length ? <>
            <DayRows label="Stretches alone by day and time, coloured by how the dog seemed" days={dayRows} from={5 * 60} to={23 * 60} ticks={dayTicks}
              items={feelings.episodes.map((episode, index) => ({ key: `${episode.date}-${episode.start_minute}-${index}`, day: episode.date, start: episode.start_minute, end: episode.start_minute + episode.minutes, color: episode.mood ? colors[episode.mood] : colors.unseen, hollow: !episode.mood,
                lines: [`${seemedText(episode)}${episode.music ? " · music played" : ""}`, `${clock(episode.start_minute)} · ${span(episode.minutes)} alone`, episode.settle_minutes !== null ? `Settled after ${span(episode.settle_minutes)}` : episode.seen_enough ? "Did not settle" : "Out of view most of the time", episode.crying_minutes === null ? "Crying not heard" : `Cried ${minutesText(episode.crying_minutes)}`] }))} />
            <ul className="pa-legend">
              {moods.map(mood => <li key={mood}><i style={{ background: colors[mood] }} />{moodNames[mood]}<b>{feelings.counts[mood]}</b></li>)}
              {unseen > 0 && <li><i className="pa-dash" style={{ borderColor: colors.unseen }} />Not seen enough<b>{unseen}</b></li>}
            </ul>
            <div className="pa-mini-tiles">
              <div><strong>{feelings.typical_settle_minutes === null ? "—" : span(feelings.typical_settle_minutes)}</strong><span>usual time to settle</span></div>
              <div><strong>{pct(report.alone.restless_share)}</strong><span>of alone time up and moving</span></div>
              <div><strong>{pct(report.alone.door_share)}</strong><span>by the door</span></div>
              <div><strong>{report.alone.calmest_hour === null ? "—" : hourName(report.alone.calmest_hour)}</strong><span>calmest hour</span></div>
              <div><strong>{report.alone.most_unsettled_hour === null ? "—" : hourName(report.alone.most_unsettled_hour)}</strong><span>most unsettled hour</span></div>
            </div>
            <p className="pa-note">Calm: settled within 20 minutes, with under a minute of crying and under 10% of the time at the door. Upset: 5 minutes of crying or more, not settling within 45 minutes, or 30% of the time at the door. A stretch where {name} was in view for under half the time is not judged, unless {name} cried for 5 minutes or more. These are signs the ASPCA lists for separation distress, read from the camera; they are not a diagnosis.</p>
          </> : <div className="pa-card-empty"><DogsTogether className="pa-card-art" /><p>No time alone seen yet. Stretches of 15 minutes or more with nobody in view appear here.</p></div>}
        </ChartCard>

        <ChartCard tag={tag} wide icon={<Icon name="tear" />} title={`How long ${name} cried`} subtitle="Minutes of whimpering or howling while alone, heard through the camera's microphone"
          table={{ head: ["Day", "Cried", "Heard"], rows: crying.by_day.map(day => [day.label, day.crying_minutes === null ? "Not heard" : minutesText(day.crying_minutes), span(day.heard_minutes)]) }}>
          {crying.listening ? <>
            <Columns label="Minutes of crying while alone, each day" data={crying.by_day.map(day => ({ key: day.date, axis: day.label, value: day.crying_minutes, lines: day.crying_minutes === null ? ["Not heard", day.label] : [`${minutesText(day.crying_minutes)} crying`, `${day.label} · ${span(day.heard_minutes)} heard alone`] }))}
              max={cryCeiling} ticks={[0, cryCeiling / 2, cryCeiling]} format={value => `${Math.round(value)} min`} color={colors.upset} />
            <div className="pa-mini-tiles">
              <div><strong>{minutesText(crying.alone_crying_minutes)}</strong><span>crying while alone</span></div>
              <div><strong>{crying.longest_minutes ? span(crying.longest_minutes) : "—"}</strong><span>longest stretch</span></div>
              <div><strong>{minutesText(crying.barking_minutes)}</strong><span>barking, all week</span></div>
              <div><strong>{span(crying.heard_minutes)}</strong><span>heard in all</span></div>
            </div>
            <p className="pa-note">Heard by the YAMNet sound model on this computer; only minutes are saved, never the sound. It can miss quiet whining or mistake other sounds, so its crying cut-off can be tuned to {possessive} own crying. The Tapo mutes its microphone while DogMaAI plays sound through it, so those minutes are not counted.</p>
            {report.sound_tuning && <p className="pa-note">Crying is counted with a cut-off of {report.sound_tuning.cutoff.toFixed(2)}, tuned to {name}{report.sound_tuning.set_at ? ` on ${new Date(report.sound_tuning.set_at).toLocaleDateString([], { day: "numeric", month: "short" })}` : ""}; minutes before then were counted with the default, so days either side of it may not compare exactly.</p>}
            {onTuneHearing && <button type="button" className="quiet-link" data-sound="page" onClick={onTuneHearing}>{report.sound_tuning ? `Check ${possessive} crying cut-off in Settings` : `Tune crying to ${name} in Settings`}</button>}
          </> : <div className="pa-card-empty"><SleepyDog className="pa-card-art" /><p>{report.sound_problem ?? `Nothing heard yet. Crying is counted while the home camera is on and its microphone can be heard.`}</p></div>}
        </ChartCard>

        <ChartCard tag={tag} wide icon={<Icon name="music" />} title={`Did the music help ${name}?`} subtitle={music.verdict === "not_enough" ? "Stretches alone with music are compared with those without once there are two of each" : `${verdictNames[music.verdict]}, from ${music.with_music.episodes} stretches alone with music and ${music.without_music.episodes} without`}
          table={{ head: ["", "Times alone", "Settled after", "Crying an hour", "Upset"], rows: [["With music", music.with_music.episodes, settleWith === null ? "—" : span(settleWith), cryWith === null ? "—" : `${cryWith} min`, music.with_music.upset], ["Without music", music.without_music.episodes, settleWithout === null ? "—" : span(settleWithout), cryWithout === null ? "—" : `${cryWithout} min`, music.without_music.upset]] }}>
          {music.with_music.episodes || music.without_music.episodes || music.plays || report.comfort.length ? <>
            {settleWith === null && settleWithout === null ? <p className="pa-note">{capital(name)} was not seen enough while alone to compare time to settle yet.</p> : <>
              <p className="pa-subhead">Time to settle when alone</p>
              <Bars label="Minutes to settle, with and without music" color={colors.resting} rows={[["with", "With music", settleWith], ["without", "Without music", settleWithout]].filter(([, , value]) => value !== null).map(([key, label, value]) => ({ key: String(key), label: String(label), value: Number(value) / settleMax, text: span(Number(value)), lines: [span(Number(value)), `${label} · the middle stretch`] }))} />
            </>}
            {cryWith !== null && cryWithout !== null && <>
              <p className="pa-subhead">Crying per hour alone</p>
              <Bars label="Minutes of crying per hour alone, with and without music" color={colors.upset} rows={[["with", "With music", cryWith], ["without", "Without music", cryWithout]].map(([key, label, value]) => ({ key: String(key), label: String(label), value: Number(value) / cryRateMax, text: `${value} min`, lines: [`${value} min an hour`, String(label)] }))} />
            </>}
            {report.comfort.length > 0 && <>
              <p className="pa-subhead">Up and about, 15 minutes before and after a sound started</p>
              <Dumbbell label="Activity before and after each kind of sound" rows={report.comfort.map(sound => ({ key: sound.sound, label: sound.sound, before: sound.active_before, after: sound.active_after, lines: [`${pct(sound.active_before)} → ${pct(sound.active_after)} active`, `${sound.sound} · ${sound.plays} play${sound.plays === 1 ? "" : "s"}`] }))} />
            </>}
            <p className="pa-note">A stretch that never settled counts its whole length. Dogs often settle on their own too, so read this as a hint rather than proof.</p>
          </> : <div className="pa-card-empty"><DogsTogether className="pa-card-art" /><p>Play calm music, brown noise or a found sound while {name} is alone and the camera is on, and PetAnalytics compares those times with the others.</p></div>}
        </ChartCard>

        <ChartCard tag={tag} wide icon={<Icon name="paw" />} title={`How active is ${name}?`} subtitle="Share of the watched time spent moving or playing, by hour of the day"
          table={{ head: ["Hour", "Active", "Watched"], rows: report.activity.by_hour.filter(hour => hour.watched_minutes > 0).map(hour => [hourName(hour.hour), pct(hour.active_share), `${hour.watched_minutes} min`]) }}>
          <Columns label={`Active share by hour of the day. Busiest hour: ${report.activity.most_active_hour === null ? "not known yet" : hourName(report.activity.most_active_hour)}.`}
            data={report.activity.by_hour.map(hour => ({ key: String(hour.hour), axis: hour.hour % 3 === 0 ? shortHour(hour.hour) : "", value: hour.active_share, lines: hour.active_share === null ? ["Not watched enough", `${hourName(hour.hour)} · ${hour.watched_minutes} min watched`] : [`${pct(hour.active_share)} active`, `${hourName(hour.hour)} · ${hour.watched_minutes} min watched`] }))}
            max={1} ticks={[0, 0.5, 1]} format={value => `${Math.round(value * 100)}%`} color={colors.moving} />
          <p className="pa-subhead">How the watched time was spent</p>
          <SplitBar label="How the watched time was spent" segments={(Object.keys(activityNames) as ActivityKey[]).map(key => ({ key, label: activityNames[key], share: report.activity.shares[key], color: colors[key], ink: key === "eating" ? colors.ink : "#ffffff" }))} />
        </ChartCard>

        <ChartCard tag={tag} icon={<Icon name="clock" />} title="Active minutes each day" subtitle="Minutes spent moving or playing while watched. Today is still going."
          table={{ head: ["Day", "Active", "Watched"], rows: report.activity.by_day.map(entry => [entry.label, `${entry.active_minutes} min${entry.label === "Today" ? " so far" : ""}`, `${entry.watched_minutes} min`]) }}>
          <Columns label="Active minutes each day" data={report.activity.by_day.map(entry => ({ key: entry.date, axis: entry.label, value: entry.watched_minutes ? entry.active_minutes : null, lines: entry.watched_minutes ? [`${entry.active_minutes} min active${entry.label === "Today" ? " so far" : ""}`, `${entry.label} · ${span(entry.watched_minutes)} watched`] : ["Not watched", entry.label] }))}
            max={dayCeiling} ticks={[0, dayCeiling / 2, dayCeiling]} format={value => `${Math.round(value)} min`} color={colors.moving} />
        </ChartCard>

        <ChartCard tag={tag} icon={<Icon name="moon" />} title="Nap time" subtitle={report.naps.list.length ? `About ${napsPerDay ?? 0} naps a day, usually around ${report.naps.usual_hours.map(hourName).join(", ")}` : "Naps are rests of ten minutes or more"}
          table={{ head: ["Day", "Started", "Length"], rows: report.naps.list.map(nap => [dayLabel(nap.date), clock(nap.start_minute), span(nap.minutes)]) }}>
          {report.naps.list.length
            ? <DayRows label="Naps by day and time" days={dayRows} from={5 * 60} to={23 * 60} ticks={dayTicks}
                items={report.naps.list.map((nap, index) => ({ key: `${nap.date}-${nap.start_minute}-${index}`, day: nap.date, start: nap.start_minute, end: nap.start_minute + nap.minutes, color: colors.resting, lines: [span(nap.minutes), `From ${clock(nap.start_minute)}`] }))} />
            : <div className="pa-card-empty"><SleepyDog className="pa-card-art" /><p>No naps seen yet.</p></div>}
        </ChartCard>

        <ChartCard tag={tag} wide icon={<Icon name="home" />} title="Favourite spots" subtitle="Where the camera saw the dog"
          table={{ head: ["Spot", "Share", "Time"], rows: report.spots.map(spot => [spotNames[spot.spot], pct(spot.share), span(spot.minutes)]) }}>
          <Bars label="Share of time by spot" color={colors.spot} rows={report.spots.map(spot => ({ key: spot.spot, label: spotNames[spot.spot], value: spot.share, text: pct(spot.share), lines: [pct(spot.share), `${spotNames[spot.spot]} · ${span(spot.minutes)}`] }))} />
        </ChartCard>
      </div>

      <section className="pa-advice" aria-label="Pawrent tips">
        <h2><Icon name="heart" />Pawrent tips{tag && <> <span className="pa-tag">From the sample week</span></>}</h2>
        <div className="pa-cards">{report.tips.map(tip => <article key={tip.id} className="pa-tip">
          <h3><Icon name="paw" />{tip.title}</h3><p><Numbers text={tip.why} /></p>
          <a href={tip.source.url} target="_blank" rel="noreferrer">{tip.source.name} ↗</a>
        </article>)}</div>
      </section>
      <section className="pa-advice" aria-label="Things to try">
        <h2><Icon name="spark" />Things to try{tag && <> <span className="pa-tag">For the sample week</span></>}</h2>
        <div className="pa-cards pa-ideas">{report.ideas.map(idea => <article key={idea.id} className="pa-idea">
          <h3>{idea.title}</h3><p>{idea.how}</p>{idea.because && <small><Numbers text={idea.because} /></small>}
          <a href={idea.source.url} target="_blank" rel="noreferrer">{idea.source.name} ↗</a>
        </article>)}</div>
      </section>
    </>}
    <p className="pa-footnote">From Tinybird (dog_readings, dog_sounds and dog_events) · Times in {report.time_zone} · Alone means nobody in view of the camera. Based only on what the camera can see and hear; not a health assessment, so ask your vet about any sudden change.</p>
  </div>;
}

import { useEffect, useState } from "react";
import { markDelaySeconds, markWindow, type HeardSecond, type HearingAction, type HearingView } from "../shared/hearing";
import { managerApi } from "./manager-api";

// Listen live: what the YAMNet sound model hears through the home camera, second by second, on screen only. Moments marked
// as crying or quiet tune the crying cut-off to the dog's own sounds. Only scores are kept, never sound.

const shown = 30;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const score = (value: number) => value.toFixed(2);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const reasons: Record<NonNullable<HeardSecond["reason"]>, string> = {
  quiet: "Near silence", muted: "Microphone off while DogMaAI plays a sound", busy: "Skipped while the model caught up", failed: "Could not be read"
};
const kinds = { crying: "Crying", barking: "Barking", other: "Other sound", unheard: "Not heard" } as const;
const kindOf = (second: HeardSecond): keyof typeof kinds => !second.heard ? "unheard" : second.sound ?? "other";
export function describeSecond(second: HeardSecond) {
  const time = new Date(second.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  if (!second.heard) return `${time}: ${reasons[second.reason ?? "quiet"]}`;
  const top = second.top.map(label => `${label.label} ${score(label.score)}`).join(", ");
  return `${time}: ${kinds[kindOf(second)]}, crying ${score(second.crying)}, barking ${score(second.barking)}${top ? `. Heard: ${top}` : ""}`;
}
/** What is still needed before a cut-off can be worked out, as a sentence. */
export function progressText(view: HearingView) {
  const { marks, suggestion } = view;
  const done = `Marked ${plural(marks.crying_moments, "crying moment")} and ${plural(marks.quiet_seconds, "quiet second")}.`;
  if (suggestion.ready) return done;
  const needs = [suggestion.needs.crying_moments && plural(suggestion.needs.crying_moments, "more crying moment"), suggestion.needs.quiet_seconds && plural(suggestion.needs.quiet_seconds, "more quiet second")].filter(Boolean);
  return `${done} Still needed: ${needs.join(" and ")}.`;
}

export function HearingCheck({ active = true }: { active?: boolean }) {
  const [view, setView] = useState<HearingView | null>(null);
  // A refresh that fails says so until one works; a button that fails says so until the next button.
  const [offline, setOffline] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState<HearingAction | null>(null);

  // The live view refreshes every second while this row is open and Settings is on screen, and stops otherwise.
  useEffect(() => {
    if (!active) return;
    let open = true;
    const load = () => {
      if (document.hidden) return;
      managerApi<HearingView>("hearing").then(next => { if (open) { setView(next); setOffline(null); } }).catch(() => { if (open) setOffline("DogMaAI's server is not answering. It may be restarting; this retries every second."); });
    };
    load();
    const timer = setInterval(load, 1000);
    return () => { open = false; clearInterval(timer); };
  }, [active]);

  async function act(action: HearingAction) {
    if (action === "clear" && !window.confirm("Remove every crying and quiet mark? The cut-off in use stays as it is.")) return;
    setPending(action);
    try { setView(await managerApi<HearingView>("hearing", { action })); setProblem(null); }
    catch (error) { setProblem((error as Error).message); }
    finally { setPending(null); }
  }
  const busy = pending !== null;

  if (!view) return <div className="hearing"><p className="hearing-hint">{offline ?? "Checking what the camera hears…"}</p></div>;
  const name = view.dog_name;
  const Name = capital(name);
  const listening = view.listening && !offline;
  const latest = listening ? [...view.seconds].reverse().find(second => second.heard) : undefined;
  const cells = Array.from({ length: shown }, (_, index) => view.seconds[view.seconds.length - shown + index]);
  const { suggestion, tuned } = view;
  const marked = view.marks.crying_moments + view.marks.quiet_seconds > 0;
  const manyFalseAlarms = suggestion.ready && suggestion.false_alarms / Math.max(1, suggestion.quiet_seconds) > 0.05;
  const meterScale = 0.5;

  return <div className="hearing">
    <div className="hearing-head">
      <strong>Listen live</strong>
      <span className={`hearing-status${listening ? " on" : ""}`}>{listening ? "Hearing the home camera" : "Not hearing the camera"}</span>
    </div>
    {offline ? <p className="hearing-hint">{offline}</p> : <>
      {view.problem && <p className="hearing-hint hearing-warning">{view.problem}</p>}
      {!listening && !view.problem && <p className="hearing-hint">DogMaAI listens while the home camera is open on Overview. Open it there, then come back.</p>}
    </>}
    <ol className="hearing-strip" aria-label="The last 30 seconds, oldest first">
      {cells.map((second, index) => second
        ? <li key={second.t} className={kindOf(second)} title={describeSecond(second)}><span className="visually-hidden">{describeSecond(second)}</span></li>
        : <li key={`empty-${index}`} className="empty" aria-hidden="true" />)}
    </ol>
    <div className="hearing-axis" aria-hidden="true"><span>30 s ago</span><span>now</span></div>
    <ul className="hearing-legend">{(Object.keys(kinds) as (keyof typeof kinds)[]).map(kind => <li key={kind}><i className={kind} />{kinds[kind]}</li>)}</ul>

    <div className="hearing-now">
      <p>Now: <b>{latest ? latest.top.map(label => `${label.label} ${score(label.score)}`).join(" · ") || "—" : "nothing heard just now"}</b></p>
      <div className="hearing-meter" role="img" aria-label={`Crying score ${score(latest?.crying ?? 0)}, cut-off ${score(view.cutoffs.crying)}`}>
        <i style={{ width: `${Math.min(1, (latest?.crying ?? 0) / meterScale) * 100}%` }} />
        <em style={{ left: `${Math.min(1, view.cutoffs.crying / meterScale) * 100}%` }} />
      </div>
      <p className="hearing-meter-label">Crying {score(latest?.crying ?? 0)} · counts as crying from {score(view.cutoffs.crying)}</p>
    </div>

    <div className="hearing-tune">
      <h4>Tune crying to {Name}</h4>
      <p>When {name} whimpers or cries, press <b>Crying now</b> straight away. It keeps the seconds from {markWindow.crying.before} before the press to {markWindow.crying.after} after, since the camera's sound arrives a moment late, so each mark takes {markDelaySeconds} seconds. When {name} is quiet, or there are everyday sounds such as talking or the TV, press <b>Quiet now</b>; it keeps the {markWindow.quiet.before} seconds before. No second is marked twice. Only scores are kept on this computer, never sound.</p>
      <div className="hearing-keys">
        <button type="button" className="keycap cry" data-sound="key" disabled={busy || !listening} onClick={() => void act("mark-crying")}>{pending === "mark-crying" ? "Marking…" : "Crying now"}</button>
        <button type="button" className="keycap" data-sound="key" disabled={busy || !listening} onClick={() => void act("mark-quiet")}>{pending === "mark-quiet" ? "Marking…" : "Quiet now"}</button>
        <button type="button" className="hearing-link" data-sound="tap" disabled={busy || !marked} onClick={() => void act("undo")}>Undo last</button>
        <button type="button" className="hearing-link" data-sound="tap" disabled={busy || !marked} onClick={() => void act("clear")}>Start over</button>
      </div>
      <p className="hearing-progress" role="status">{progressText(view)}</p>
      {suggestion.ready && suggestion.cutoff !== null && <div className="hearing-suggestion">
        <p><b>{Name}'s cut-off: {score(suggestion.cutoff)}.</b> It catches {suggestion.caught} of {plural(suggestion.moments, "crying moment")} you marked, and {suggestion.false_alarms} of {plural(suggestion.quiet_seconds, "quiet second")} would count as crying too.{manyFalseAlarms && " That is more than 1 in 20 of the quiet seconds: mark more quiet moments, or keep the default."}</p>
        <button type="button" className="keycap" data-sound="switchOn" disabled={busy || tuned?.cutoff === suggestion.cutoff} onClick={() => void act("use-suggested")}>{tuned?.cutoff === suggestion.cutoff ? "In use" : `Use ${score(suggestion.cutoff)}`}</button>
      </div>}
      <p className="hearing-inuse">
        {tuned
          ? <>In use: <b>{score(tuned.cutoff)}</b>, tuned to {name}{tuned.set_at ? ` on ${new Date(tuned.set_at).toLocaleDateString([], { day: "numeric", month: "short" })}` : ""}. It applies from now on; minutes already saved keep their counts. <button type="button" className="hearing-link" data-sound="switchOff" disabled={busy} onClick={() => void act("use-default")}>Back to the default ({score(view.default_cutoffs.crying)})</button></>
          : <>In use: <b>{score(view.cutoffs.crying)}</b>, the default.</>}
      </p>
    </div>
    {problem && <p className="setup-feedback failed" role="alert">{problem}</p>}
  </div>;
}

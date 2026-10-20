import { useState } from "react";
import type { SpeakerVolume } from "../shared/comfort";
import type { FoundSound, SoundSearch } from "../shared/sounds";
import { playLocalComfort, playLocalRecording, type ComfortAction } from "./comfort";
import { managerApi } from "./ManagerSetup";

export interface SpeakerState { configured: boolean; playing: ComfortAction | "found" | null; title?: string; volume?: SpeakerVolume }

function minutes(seconds: number) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
const commonsPage = (url: string) => url.startsWith("https://commons.wikimedia.org/") ? url : null;

// On request, Nimble finds free-license recordings on Wikimedia Commons: music for the time of day, or a sound the owner types. Each result keeps its attribution.
const quickSearches = ["Birdsong", "Rain", "Dog barking"];
export function FoundSounds({ onCamera, onSpeaker, onStatus }: { onCamera: boolean; onSpeaker: (state: SpeakerState) => void; onStatus: (line: string) => void }) {
  const [search, setSearch] = useState<SoundSearch | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [local, setLocal] = useState<string | null>(null);
  const [words, setWords] = useState("");
  async function find(query = "") {
    setBusy("search"); setError("");
    try { setSearch(await managerApi<SoundSearch>("sounds/search", query ? { query } : {})); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The sound search did not complete."); }
    finally { setBusy(null); }
  }
  function playHere(sound: FoundSound) {
    if (local === sound.id) { playLocalComfort("stop"); onStatus(""); return; }
    setError("");
    playLocalRecording(sound.preview_url, () => { setLocal(current => current === sound.id ? null : current); onStatus(""); })
      .then(() => onStatus(`Playing “${sound.title}” on this computer`))
      .catch(() => { setLocal(null); setError("This browser could not play that recording."); });
    setLocal(sound.id);
  }
  async function playOnCamera(sound: FoundSound) {
    setBusy(sound.id); setError("");
    try { onSpeaker({ configured: true, ...await managerApi<Omit<SpeakerState, "configured">>("camera/speaker", { sound: sound.id }) }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The camera speaker did not start."); }
    finally { setBusy(null); }
  }
  return <div className="found-sounds">
    <form className="found-search" onSubmit={event => { event.preventDefault(); void find(words.trim()); }}>
      <input value={words} maxLength={60} onChange={event => setWords(event.target.value)} placeholder="Search sounds, such as birdsong" aria-label="Search for a sound with Nimble" />
      <button className="secondary-button" data-sound="tap" disabled={busy !== null || words.trim().length < 2}>{busy === "search" && words.trim() ? "Searching…" : "Search"}</button>
    </form>
    <div className="found-heading">
      {quickSearches.map(item => <button key={item} className="found-chip keycap" data-sound="key" disabled={busy !== null} onClick={() => { setWords(item); void find(item); }}>{item}</button>)}
      <button className="found-chip keycap" data-sound="key" disabled={busy !== null} onClick={() => { setWords(""); void find(); }}>Music for now</button>
    </div>
    <small className="found-note">Barking and birdsong can make some dogs more alert. Preview first, and watch the camera the first time you play one.</small>
    {search && <span className="found-label">{search.label}</span>}
    {error && <small className="found-error" role="alert">{error}</small>}
    {search && <>
      {search.sounds.length > 0 && <ul className="found-list">{search.sounds.map(sound => {
        const page = commonsPage(sound.page);
        return <li key={sound.id}>
          <div className="found-title">{page ? <a href={page} target="_blank" rel="noreferrer">{sound.title}</a> : <span>{sound.title}</span>}<small>{sound.artist} · {sound.license_url ? <a href={sound.license_url} target="_blank" rel="noreferrer">{sound.license}</a> : sound.license} · {minutes(sound.duration_seconds)}</small></div>
          <div className="found-actions">
            <button data-sound="tap" onClick={() => playHere(sound)}>{local === sound.id ? "Stop" : onCamera ? "Preview" : "Play"}</button>
            {onCamera && <button data-sound="tap" disabled={busy !== null} onClick={() => void playOnCamera(sound)}>{busy === sound.id ? "Starting…" : "Play on camera"}</button>}
          </div>
        </li>;
      })}</ul>}
      <small className="found-note">{search.message} {onCamera ? "Preview plays on this computer." : "Found sounds play on this computer."}</small>
    </>}
  </div>;
}

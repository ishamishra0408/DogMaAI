import { useEffect, useState } from "react";
import type { DiaryListing } from "../shared/diary";
import { managerApi } from "./ManagerSetup";

function when(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

// Liquid AI's descriptions of the dog, one entry each time what the dog is doing or where it is changes.
export function DogDiary({ refresh }: { refresh: number }) {
  const [listing, setListing] = useState<DiaryListing | null>(null);
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const load = () => managerApi<DiaryListing>("diary")
      .then(next => { if (!cancelled) { setListing(next); setError(""); } })
      .catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "The diary could not be loaded."); });
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [refresh]);
  const entries = listing?.entries ?? [];
  const note = error || listing?.message || "Loading the diary…";
  return <section className="dog-diary" aria-label="Dog diary">
    <div className="diary-heading"><h2>Dog diary</h2><span>{listing && listing.storage !== "memory" ? listing.place : "This session only"}</span></div>
    {entries.length === 0 ? <p className="diary-empty">{note}</p> : <>
      <ol className="diary-list">{entries.slice(0, all ? entries.length : 4).map(entry => <li key={entry.entry_id}>
        <time dateTime={entry.observed_at}>{when(entry.observed_at)}</time>
        <p>{entry.description}{!entry.saved && listing && listing.storage !== "memory" && <small> · Not saved yet</small>}</p>
      </li>)}</ol>
      <small className="diary-note" role="status">{note}</small>
      {entries.length > 4 && <button className="quiet-link" data-sound="tap" onClick={() => setAll(!all)}>{all ? "Show recent entries" : `View all ${entries.length} entries`}</button>}
    </>}
  </section>;
}

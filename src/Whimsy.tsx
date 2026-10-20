import { useEffect, useState } from "react";
import { numberParts } from "./numbers";
import { onSoundsChange, playSound, setSoundsEnabled, soundsEnabled } from "./ui-sounds";

/** The speaker switch: sounds are on until turned off, and this browser remembers the choice. */
export function SoundToggle({ className = "" }: { className?: string }) {
  const [on, setOn] = useState(soundsEnabled);
  useEffect(() => onSoundsChange(setOn), []);
  function toggle() {
    if (on) { playSound("soundOff", true); setSoundsEnabled(false); }
    else { setSoundsEnabled(true); playSound("soundOn"); }
  }
  return <button className={`sound-toggle ${className}`} aria-pressed={on} aria-label="Sounds" title={on ? "Turn sounds off" : "Turn sounds on"} onClick={toggle}>
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4Z" />
      {on ? <path d="M15.5 9.2a4 4 0 0 1 0 5.6M18.2 6.6a7.6 7.6 0 0 1 0 10.8" /> : <path d="m16 9.5 5 5m0-5-5 5" />}
    </svg>
  </button>;
}

/** Prose whose numbers get the monospace accent. */
export function Numbers({ text }: { text: string }) {
  return <>{numberParts(text).map((part, index) => part.number ? <em key={index} className="num">{part.text}</em> : part.text)}</>;
}

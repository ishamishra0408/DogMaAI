// Small interface sounds, made on the fly with the Web Audio API: soft clicks, pops, whooshes and chimes in the spirit
// of joshwcomeau.com. Nothing is downloaded, and there are no barks or squeaks that could excite a dog near this computer.
// Sounds are on unless turned off with the speaker switch, which this browser remembers.

export type SoundName = "tap" | "key" | "page" | "open" | "close" | "flip" | "switchOn" | "switchOff" | "soundOn" | "soundOff";

const preference = "dogmaai.sounds";
const listeners = new Set<(enabled: boolean) => void>();

export function soundsEnabled() {
  try { return globalThis.localStorage?.getItem(preference) !== "off"; } catch { return true; }
}
export function setSoundsEnabled(enabled: boolean) {
  try { if (enabled) globalThis.localStorage?.removeItem(preference); else globalThis.localStorage?.setItem(preference, "off"); }
  catch { /* Storage can be blocked; the choice then lasts until the page reloads. */ }
  listeners.forEach(listener => listener(enabled));
}
export function onSoundsChange(listener: (enabled: boolean) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

type AudioContextClass = typeof AudioContext;
let context: AudioContext | null = null;
let output: GainNode | null = null;
function audio() {
  const Context = (globalThis as { AudioContext?: AudioContextClass; webkitAudioContext?: AudioContextClass }).AudioContext
    ?? (globalThis as { webkitAudioContext?: AudioContextClass }).webkitAudioContext;
  if (!Context) return null;
  if (!context) {
    context = new Context();
    output = context.createGain();
    output.gain.value = 0.6;
    output.connect(context.destination);
  }
  if (context.state === "suspended") void context.resume();
  return context;
}

interface Tone { type?: OscillatorType; from: number; to?: number; at?: number; length: number; volume: number; attack?: number }
function tone(ctx: AudioContext, { type = "sine", from, to = from, at = 0, length, volume, attack = 0.004 }: Tone) {
  const start = ctx.currentTime + at;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(from, start);
  if (to !== from) oscillator.frequency.exponentialRampToValueAtTime(to, start + length);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  oscillator.connect(gain).connect(output!);
  oscillator.start(start);
  oscillator.stop(start + length + 0.02);
}

interface Noise { filter?: BiquadFilterType; from: number; to?: number; q?: number; at?: number; length: number; volume: number; attack?: number }
function noise(ctx: AudioContext, { filter = "bandpass", from, to = from, q = 1, at = 0, length, volume, attack = 0.003 }: Noise) {
  const start = ctx.currentTime + at;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * length), ctx.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index++) samples[index] = Math.random() * 2 - 1;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const shape = ctx.createBiquadFilter();
  shape.type = filter;
  shape.Q.value = q;
  shape.frequency.setValueAtTime(from, start);
  if (to !== from) shape.frequency.exponentialRampToValueAtTime(to, start + length);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  source.connect(shape).connect(gain).connect(output!);
  source.start(start);
  source.stop(start + length);
}

const notes = { E5: 659.25, B5: 987.77 };
const sounds: Record<SoundName, (ctx: AudioContext) => void> = {
  // A light tick for ordinary buttons.
  tap: ctx => { tone(ctx, { type: "triangle", from: 1800, to: 1300, length: 0.04, volume: 0.07 }); noise(ctx, { filter: "highpass", from: 3200, length: 0.012, volume: 0.025 }); },
  // A soft keycap "thock": a muffled knock with a low body.
  key: ctx => { noise(ctx, { from: 950, to: 480, q: 2.2, length: 0.05, volume: 0.2 }); tone(ctx, { from: 200, to: 120, length: 0.08, volume: 0.12 }); },
  // A short airy whoosh for moving between pages.
  page: ctx => noise(ctx, { from: 450, to: 2100, q: 0.8, length: 0.17, volume: 0.06, attack: 0.05 }),
  open: ctx => { noise(ctx, { from: 600, to: 1800, q: 0.9, length: 0.12, volume: 0.05, attack: 0.03 }); tone(ctx, { type: "triangle", from: 660, to: 880, length: 0.07, volume: 0.025 }); },
  close: ctx => { noise(ctx, { from: 1800, to: 600, q: 0.9, length: 0.12, volume: 0.05, attack: 0.03 }); tone(ctx, { type: "triangle", from: 880, to: 660, length: 0.07, volume: 0.025 }); },
  // Two quick ticks, like a card turning over.
  flip: ctx => { noise(ctx, { filter: "highpass", from: 2200, length: 0.02, volume: 0.06 }); noise(ctx, { filter: "highpass", from: 2600, at: 0.05, length: 0.02, volume: 0.05 }); tone(ctx, { type: "triangle", from: 1150, to: 1500, at: 0.05, length: 0.04, volume: 0.035 }); },
  switchOn: ctx => { noise(ctx, { filter: "highpass", from: 2600, length: 0.012, volume: 0.07 }); tone(ctx, { from: 700, to: 1100, at: 0.012, length: 0.06, volume: 0.07 }); },
  switchOff: ctx => { noise(ctx, { filter: "highpass", from: 2400, length: 0.012, volume: 0.07 }); tone(ctx, { from: 1100, to: 650, at: 0.012, length: 0.06, volume: 0.07 }); },
  soundOn: ctx => { tone(ctx, { type: "triangle", from: notes.E5, length: 0.12, volume: 0.08 }); tone(ctx, { type: "triangle", from: notes.B5, at: 0.08, length: 0.16, volume: 0.08 }); },
  soundOff: ctx => { tone(ctx, { type: "triangle", from: notes.B5, length: 0.1, volume: 0.06 }); tone(ctx, { type: "triangle", from: notes.E5, at: 0.07, length: 0.14, volume: 0.06 }); }
};

/** Plays a sound unless sounds are off; `force` plays it anyway, for the chime that confirms sounds were just turned off. */
export function playSound(name: SoundName, force = false) {
  if (!force && !soundsEnabled()) return;
  try {
    const ctx = audio();
    if (ctx) sounds[name](ctx);
  } catch { /* A sound is never worth an error. */ }
}

// Elements say which sound they make with data-sound. "disclosure" picks open or close from the element's state.
function soundFor(element: HTMLElement): SoundName | null {
  const name = element.dataset.sound;
  if (!name) return null;
  if (name === "disclosure") {
    const open = element.getAttribute("aria-expanded") === "true" || (element.tagName === "SUMMARY" && (element.parentElement as HTMLDetailsElement | null)?.open === true);
    return open ? "close" : "open";
  }
  return name in sounds ? name as SoundName : null;
}
export function installClickSounds(root: Document = document) {
  const flagged = root as Document & { dogmaaiClickSounds?: boolean };
  if (flagged.dogmaaiClickSounds) return;
  flagged.dogmaaiClickSounds = true;
  root.addEventListener("click", event => {
    const element = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-sound]");
    if (!element || element.matches(":disabled")) return;
    const name = soundFor(element);
    if (name) playSound(name);
  }, true);
}

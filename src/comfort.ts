import { calmBeatSeconds, calmPhrase, calmPhraseBeats, type ComfortAction } from "../shared/comfort";
export type { ComfortAction } from "../shared/comfort";

let context: AudioContext | null = null;
let stopCurrent: (() => void) | null = null;

// A paired phone unlocks audio with a tap and hands its context over, so later queued actions can play.
export function adoptComfortAudio(unlocked: AudioContext | null) { context = unlocked; }

function audio() {
  context ??= new AudioContext();
  void context.resume();
  return context;
}
function output(ctx: AudioContext, level: number, fadeInSeconds: number) {
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(level, ctx.currentTime + fadeInSeconds);
  gain.connect(ctx.destination);
  return gain;
}
function fadeOut(ctx: AudioContext, gain: GainNode) {
  const now = ctx.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(gain.gain.value, now);
  gain.gain.linearRampToValueAtTime(0, now + 0.3);
  setTimeout(() => gain.disconnect(), 400);
}
function tone(ctx: AudioContext, destination: AudioNode, type: OscillatorType, frequency: number, start: number, seconds: number, level: number, attack = 0.15) {
  const oscillator = ctx.createOscillator();
  const envelope = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  // The default soft attack avoids the sudden onsets that startle dogs.
  envelope.gain.setValueAtTime(0, start);
  envelope.gain.linearRampToValueAtTime(level, start + Math.min(attack, seconds / 4));
  envelope.gain.exponentialRampToValueAtTime(0.001, start + seconds);
  oscillator.connect(envelope);
  envelope.connect(destination);
  oscillator.start(start);
  oscillator.stop(start + seconds + 0.05);
  return oscillator;
}

// Composed as it plays, so the music varies; dogs habituate to a single repeated piece.
function playCalmMusic(ctx: AudioContext) {
  // Music and noise are levelled to a similar soft loudness, so switching between them never jumps.
  const gain = output(ctx, 0.22, 2);
  const scheduled = new Set<OscillatorNode>();
  let next = ctx.currentTime + 0.1;
  let previous = 4;
  const schedule = () => {
    // Scheduling a minute ahead keeps the music going when a background tab's timers slow down.
    while (next < ctx.currentTime + 60) {
      const phrase = calmPhrase(Math.random, previous);
      previous = phrase.last;
      for (const note of phrase.notes) {
        const oscillator = tone(ctx, gain, note.beats === calmPhraseBeats ? "sine" : "triangle", note.frequency, next + note.beat * calmBeatSeconds, note.beats * calmBeatSeconds, note.level);
        scheduled.add(oscillator);
        oscillator.onended = () => scheduled.delete(oscillator);
      }
      next += calmPhraseBeats * calmBeatSeconds;
    }
  };
  schedule();
  const timer = setInterval(schedule, 5000);
  return () => {
    clearInterval(timer);
    fadeOut(ctx, gain);
    for (const oscillator of scheduled) oscillator.stop(ctx.currentTime + 0.4);
  };
}

// Brown noise is weighted to low frequencies, so it masks doorbells, footsteps and barking outside without hiss.
function playBrownNoise(ctx: AudioContext) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 10, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let index = 0; index < data.length; index++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    data[index] = last * 3.5;
  }
  // Tilting the buffer so both ends match removes the click where the loop restarts.
  const drift = data[data.length - 1] - data[0];
  for (let index = 0; index < data.length; index++) data[index] -= drift * index / (data.length - 1);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 900;
  const gain = output(ctx, 0.1, 3);
  source.connect(filter);
  filter.connect(gain);
  source.start();
  return () => { fadeOut(ctx, gain); source.stop(ctx.currentTime + 0.4); };
}

export function playLocalComfort(action: ComfortAction) {
  stopCurrent?.();
  stopCurrent = null;
  if (action === "stop") return;
  const ctx = audio();
  stopCurrent = action === "dog-music" ? playCalmMusic(ctx) : playBrownNoise(ctx);
}

// A found recording plays through an audio element, near the level of the built-in sounds. Any comfort action, including Stop, ends it.
export function playLocalRecording(url: string, onDone: () => void = () => {}) {
  playLocalComfort("stop");
  const player = new Audio(url);
  player.volume = 0.3;
  const stop = () => { player.onended = null; player.pause(); player.removeAttribute("src"); player.load(); onDone(); };
  player.onended = () => { if (stopCurrent === stop) stopCurrent = null; onDone(); };
  stopCurrent = stop;
  return player.play();
}

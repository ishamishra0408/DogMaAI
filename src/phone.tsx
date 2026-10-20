import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./phone.css";
import { adoptComfortAudio, playLocalComfort } from "./comfort";
import { comfortLabels, isComfortAction, type ComfortAction } from "../shared/comfort";

// Keep pairing credentials in memory, not browser history, storage or referrers.
const fragment = new URLSearchParams(location.hash.slice(1));
const pairing = { id: fragment.get("id"), key: fragment.get("key") };
if (location.hash) history.replaceState(null, "", location.pathname);

function PhoneCamera() {
  const preview = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const sender = useRef<string | null>(null);
  const generation = useRef(0);
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  const sound = useRef<AudioContext | null>(null);
  const heard = useRef(0);
  const [soundReady, setSoundReady] = useState(false);
  const [soundLabel, setSoundLabel] = useState("");
  const [state, setState] = useState<"ready" | "starting" | "live" | "stopped" | "error">("ready");
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState(document.hidden);
  const valid = Boolean(pairing.id && pairing.key);
  function release() {
    generation.current++;
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    void wakeLock.current?.release();
    wakeLock.current = null;
  }
  async function keepAwake() {
    if ("wakeLock" in navigator && !document.hidden && stream.current) {
      try { wakeLock.current = await navigator.wakeLock.request("screen"); } catch { /* Keeping the page visible is still required. */ }
    }
  }
  useEffect(() => {
    const visibility = () => { setHidden(document.hidden); if (!document.hidden) void keepAwake(); };
    const pagehide = () => release();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pagehide);
    return () => { release(); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("pagehide", pagehide); };
  }, []);
  useEffect(() => {
    if (!soundReady || state !== "live") return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      try {
        const response = await fetch(`/api/camera/${pairing.id}/action?after=${heard.current}`, { headers: { Authorization: `Bearer ${sender.current}` }, cache: "no-store" });
        // Dog sounds play until stopped, so an ended pairing must silence them here.
        if (response.status === 403) { stopSound(); return; }
        if (response.ok && response.status !== 204) {
          const action = await response.json() as { sequence: number; type: unknown };
          if (!stopped && action.sequence > heard.current) { heard.current = action.sequence; if (isComfortAction(action.type)) playAction(action.type); }
        }
      } catch { /* A later poll may recover. */ }
      if (!stopped) timer = setTimeout(() => void check(), 600);
    }
    void check();
    return () => { stopped = true; clearTimeout(timer); };
  }, [soundReady, state]);
  function stopSound() {
    playLocalComfort("stop");
    setSoundLabel("");
  }
  function playAction(type: ComfortAction) {
    playLocalComfort(type);
    setSoundLabel(type === "stop" ? "" : comfortLabels[type]);
  }
  async function enableSound() {
    try {
      const context = new AudioContext(); await context.resume();
      sound.current = context;
      adoptComfortAudio(context);
      // A soft two-note chime confirms sound works; no voice plays near the dog.
      for (const [offset, frequency] of [[0, 523.25], [0.18, 659.25]]) {
        const tone = context.createOscillator(); const gain = context.createGain();
        tone.frequency.value = frequency; tone.connect(gain).connect(context.destination);
        const start = context.currentTime + offset;
        gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(0.08, start + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
        tone.start(start); tone.stop(start + 0.4);
      }
      const response = await fetch(`/api/camera/${pairing.id}/speaker`, { method: "POST", headers: { Authorization: `Bearer ${sender.current}`, "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) });
      if (!response.ok) throw new Error("Could not enable sound. Reconnect the phone and try again.");
      setSoundReady(true); setError("");
    } catch (reason) {
      void sound.current?.close(); sound.current = null; adoptComfortAudio(null);
      setError(reason instanceof Error ? reason.message : "Sound is unavailable on this phone.");
    }
  }
  async function start() {
    if (!valid || state === "starting" || state === "live") return;
    release();
    const run = generation.current;
    setState("starting"); setError("");
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Open the secure QR-code link from the manager to use your camera.");
      const media = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 10, max: 15 } } });
      if (run !== generation.current) { media.getTracks().forEach(track => track.stop()); return; }
      stream.current = media;
      if (!sender.current) {
        const response = await fetch(`/api/camera/${pairing.id}/claim`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: pairing.key }), signal: AbortSignal.timeout(15_000) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
        sender.current = body.senderToken;
      }
      if (run !== generation.current) {
        const key = sender.current; sender.current = null;
        if (key) void fetch(`/api/camera/${pairing.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${key}` } }).catch(() => {});
        return;
      }
      const video = preview.current!;
      video.srcObject = media;
      await video.play();
      await keepAwake();
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d")!;
      let failures = 0;
      while (run === generation.current) {
        if (document.hidden || video.readyState < 2) { await new Promise(resolve => setTimeout(resolve, 500)); continue; }
        const width = Math.min(640, video.videoWidth);
        canvas.width = width;
        canvas.height = Math.round(video.videoHeight * width / video.videoWidth);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frame = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", .65));
        if (run !== generation.current) return;
        if (!frame) throw new Error("The camera could not produce an image. Try again.");
        try {
          const response = await fetch(`/api/camera/${pairing.id}/frame`, { method: "POST", headers: { Authorization: `Bearer ${sender.current}`, "Content-Type": "image/jpeg" }, body: frame, signal: AbortSignal.timeout(8000) });
          if (response.status === 403) { sender.current = null; throw new Error("Pairing ended. Scan a new QR code in the manager."); }
          if (!response.ok) throw new Error("Camera connection interrupted. Try again.");
          failures = 0;
          if (run === generation.current) { setState("live"); setError(""); }
        } catch (reason) {
          if (!sender.current || ++failures >= 3) throw reason;
          setError("Reconnecting…");
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } catch (reason) {
      if (run !== generation.current) return;
      release(); stopSound(); setState("error");
      const message = reason instanceof Error ? reason.message : "Could not start the camera.";
      setError(reason instanceof DOMException && reason.name === "NotAllowedError" ? "Camera access was declined. Allow this site to use your camera, then try again." : message);
    }
  }
  function stop() {
    stopSound(); void sound.current?.close(); sound.current = null; adoptComfortAudio(null); setSoundReady(false);
    release(); setState("stopped"); setError("");
    const key = sender.current;
    sender.current = null;
    if (key) void fetch(`/api/camera/${pairing.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${key}` }, keepalive: true }).catch(() => {});
  }
  return <main className="phone-page">
    <span className="phone-eyebrow">DogMaAI camera</span>
    <h1>{state === "live" ? "You’re connected." : state === "stopped" ? "Camera stopped." : "Use your phone as a camera."}</h1>
    <p>{state === "stopped" ? "Create a new link in the manager to connect again." : "Keep this page open and your phone plugged in."}</p>
    <div className="phone-view"><video ref={preview} muted playsInline autoPlay /><span>{state === "live" ? hidden ? "Paused in background" : "Sharing with your manager" : "Rear camera · No audio"}</span></div>
    {!valid ? <p className="phone-error" role="alert">Scan a fresh QR code from Camera in your manager.</p> : <>
      {error && <p className="phone-error" role="status">{error}</p>}
      {state === "live" || state === "starting" ? <button onClick={stop}>Stop camera</button> : state !== "stopped" && <button className="phone-primary" onClick={() => void start()}>{state === "error" ? "Try again" : "Start camera"}</button>}
      {state === "live" && !soundReady && <button className="phone-sound" onClick={() => void enableSound()}>Enable sound for comfort tools</button>}
      {state === "live" && soundReady && <p role="status">{soundLabel || "Sound enabled · Awaiting the manager"}</p>}
      {state === "starting" && <p role="status">Connecting camera…</p>}
    </>}
    <small>Live images pass through Cloudflare’s HTTPS relay to your computer. Only the latest image is kept in server memory. The microphone is off. Sound plays only after you enable it and choose a comfort action in the manager.</small>
  </main>;
}
createRoot(document.getElementById("root")!).render(<PhoneCamera />);

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { RuntimeSnapshot, TimelineEvent } from "../shared/api";
import { situationLabels, type RoomState, type StateMutation } from "../shared/domain";
import "./manager.css";
import { playLocalComfort, type ComfortAction } from "./comfort";
import { comfortLabels, speakerVolumes, type SpeakerVolume } from "../shared/comfort";
import { ManagerAlerts } from "./ManagerAlerts";
import { CameraSettings, usePhoneConnection } from "./PhoneConnection";
import { DogMark, DogsPlaying, DogsTogether } from "./DogArt";
import { DogDiary } from "./DogDiary";
import { FoundSounds, type SpeakerState } from "./FoundSounds";
import { ConnectionsSettings, DemoAssets, managerApi, type ConnectionStates } from "./ManagerSetup";
import { PetAnalyticsPage } from "./PetAnalytics";
import { installClickSounds } from "./ui-sounds";
import { SoundToggle } from "./Whimsy";

type IconName = "home" | "settings" | "paw" | "eye" | "arrow" | "close" | "camera" | "speaker";
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    speaker: <><path d="M3 9v6h4l5 4V5L7 9Z" /><path d="M16 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14" /></>,
    camera: <><path d="M8 6 10 3h4l2 3h5v15H3V6Z" /><circle cx="12" cy="13" r="4" /></>,
    home: <><path d="m3 10 9-7 9 7v10H3Z" /><path d="M9 20v-7h6v7" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="8" cy="7" r="3" /><circle cx="16" cy="17" r="3" /></>,
    eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>,
    paw: <><ellipse cx="12" cy="15.6" rx="4.4" ry="3.7" /><circle cx="6.4" cy="10.2" r="1.9" /><circle cx="9.9" cy="6.3" r="1.9" /><circle cx="14.1" cy="6.3" r="1.9" /><circle cx="17.6" cy="10.2" r="1.9" /></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    close: <path d="m6 6 12 12M6 18 18 6" />
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error("Could not reach the local service. Check that the API is running and retry.");
  return response.json();
}
function time(value: number) { return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`; }
function age(seconds: number) { const elapsed = Math.max(0, Math.floor(seconds)); return elapsed < 2 ? "Now" : elapsed < 60 ? `${elapsed}s ago` : `${Math.floor(elapsed / 60)}m ago`; }
function words(value: string) { return value.replaceAll("_", " "); }
function eventCopy(m: StateMutation) {
  switch (m.type) {
    case "ROOM_STATE_CHANGED": return { title: "Room memory updated", source: "Memory", detail: "Matching observations updated the room state.", result: Object.entries(m.patch).filter(([key]) => !["uncertainties", "observed_at_seconds"].includes(key)).map(([key, value]) => `${words(key)}: ${String(value)}`).join(" · ") };
    case "SITUATION_OPENED": return { title: situationLabels[m.situation.type], source: "Rules", detail: "A confirmed room change matched a monitoring rule.", result: "A new situation is open and being tracked." };
    case "SITUATION_UPDATED": return { title: "New evidence added", source: "Rules", detail: "An open situation received another observation.", result: "The existing situation was updated." };
    case "SITUATION_RESOLVED": return { title: "Situation resolved", source: "Rules", detail: m.reason, result: "The situation is closed in the current session." };
    case "ALERT_EMITTED": return { title: "Review requested", source: "Rules", detail: "The configured alert threshold was reached.", result: "An in-app alert was recorded. No phone call was made." };
    case "MONITORING_UNCERTAIN": return { title: "View needs a check", source: "Vision", detail: m.reason, result: "Uncertainty was retained in the room state." };
  }
}

// Voices drew dogs' attention without calming them during owner separation, so the tools offer music and masking noise only.
const comfortChoices: [ComfortAction, string][] = [["dog-music", "Calm music"], ["dog-noise", "Brown noise"], ["stop", "Stop"]];
const volumeNames: Record<SpeakerVolume, string> = { soft: "Soft", normal: "Normal", loud: "Loud" };
// The chosen camera volume is remembered in this browser, since the server starts at Loud after a restart.
const volumeChoice = "dogmaai.speaker-volume";
const storedVolume = () => { try { const value = localStorage.getItem(volumeChoice); return speakerVolumes.includes(value as SpeakerVolume) ? value as SpeakerVolume : null; } catch { return null; } };
const dogPlace: Record<RoomState["dog_location"], string> = { bed: "on its bed", floor: "on the floor", furniture: "on furniture", door: "at the door", unknown: "" };
function roomSummary(room: RoomState) {
  if (room.stale) return "Needs confirmation";
  if (room.dog_visible === false) return "Dog not in view";
  const activity = room.dog_activity === "unknown" ? "In view" : room.dog_activity[0].toUpperCase() + room.dog_activity.slice(1);
  return `${activity} ${dogPlace[room.dog_location]}`.trim();
}

function Manager() {
  const phoneCamera = usePhoneConnection();
  const phoneMode = phoneCamera.mode === "phone";
  // A home camera has no phone speaker; its sounds play through a configured camera speaker, or else on this computer.
  const homeCamera = phoneMode && phoneCamera.source === "home";
  const [tab, setTab] = useState<"overview" | "settings" | "analytics">("overview");
  const [settingsTab, setSettingsTab] = useState("Connections");
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [selected, setSelected] = useState<TimelineEvent | null>(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [pulse, setPulse] = useState<string[]>([]);
  const [feedStatus, setFeedStatus] = useState<"connecting" | "observing" | "unavailable">("connecting");
  const [history, setHistory] = useState(false);
  const [connectionStates, setConnectionStates] = useState<ConnectionStates>({});
  // Whether this page reaches the local DogMaAI service, checked every 5 seconds whichever camera is shown.
  const [serviceReachable, setServiceReachable] = useState<boolean | null>(null);
  const [connectionFocus, setConnectionFocus] = useState<{ id: string } | null>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const [liveVision, setLiveVision] = useState("");
  const [visionError, setVisionError] = useState("");
  const [visionWorking, setVisionWorking] = useState(false);
  const [comfortStatus, setComfortStatus] = useState("");
  const [comfortWorking, setComfortWorking] = useState(false);
  const [sessionNote, setSessionNote] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const session = useRef("");
  const restartFeed = useRef<() => void>(() => {});
  const received = useRef("");
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [retry, setRetry] = useState(0);

  const [cameraSpeaker, setCameraSpeaker] = useState<SpeakerState>({ configured: false, playing: null });
  const volumeSynced = useRef(false);
  const [diaryRefresh, setDiaryRefresh] = useState(0);
  // With a speaker-capable home camera, comfort sounds play where the dog is rather than on this computer.
  const speakerOnCamera = homeCamera && cameraSpeaker.configured;
  useEffect(() => {
    const refresh = () => {
      void managerApi<ConnectionStates>("connections").then(states => { setConnectionStates(states); setServiceReachable(true); }).catch(() => setServiceReachable(false));
      void managerApi<SpeakerState>("camera/speaker").then(setCameraSpeaker).catch(() => {});
    };
    refresh();
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => () => playLocalComfort("stop"), []);
  useEffect(() => {
    const wanted = storedVolume();
    if (volumeSynced.current || !cameraSpeaker.configured || !cameraSpeaker.volume) return;
    volumeSynced.current = true;
    if (wanted && wanted !== cameraSpeaker.volume) void setVolume(wanted);
  }, [cameraSpeaker.configured, cameraSpeaker.volume]);
  useEffect(() => {
    if (!phoneMode || phoneCamera.status !== "live" || !connectionStates.liquid?.verifiedAt || !phoneCamera.pair) {
      setLiveVision(""); setVisionWorking(false); return;
    }
    let cancelled = false; let working = false;
    const controller = new AbortController();
    const analyze = async () => {
      if (working || cancelled) return;
      working = true; setVisionWorking(true);
      try {
        const response = await fetch(`/api/camera/${phoneCamera.pair!.id}/analyze`, { method: "POST", headers: { Authorization: `Bearer ${phoneCamera.pair!.ownerToken}` }, signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Vision request failed.");
        if (!cancelled) { setLiveVision(result.description); setVisionError(""); setPulse(["vision"]); setTimeout(() => setPulse([]), 1000); if (result.diaryEntry) setDiaryRefresh(value => value + 1); }
      } catch (reason) { if (!cancelled && !(reason instanceof DOMException && reason.name === "AbortError")) setVisionError(reason instanceof Error ? reason.message : "Vision request failed."); }
      finally { working = false; if (!cancelled) setVisionWorking(false); }
    };
    void analyze();
    const timer = setInterval(() => void analyze(), 12_000);
    return () => { cancelled = true; controller.abort(); clearInterval(timer); };
  }, [phoneMode, phoneCamera.status, phoneCamera.pair?.id, connectionStates.liquid?.verifiedAt]);

  useEffect(() => {
    if (phoneMode) {
      setSnapshot(null); setEvents([]); setSelected(null); setPulse([]); setError("");
      return;
    }
    let cancelled = false;
    let stream: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let requestNumber = 0;
    const reconnectSoon = () => {
      if (cancelled || retryTimer) return;
      retryTimer = setTimeout(() => { retryTimer = undefined; setRetry(value => value + 1); }, 1500);
    };
    // A retry keeps the current banner and status until it succeeds, so an outage does not make the page jump every attempt.
    setFeedStatus(status => status === "unavailable" ? status : "connecting");
    api<RuntimeSnapshot>("/api/sessions", {}).then(initial => {
      if (cancelled) return;
      session.current = initial.state.session_id;
      setSnapshot(initial);
      let starting = false;
      const camera = video.current;
      const openStream = () => {
        if (stream) return;
        stream = new EventSource(`/api/sessions/${initial.state.session_id}/stream`);
        // The server sends a heartbeat every 5 seconds. A stream silent for 15 seconds is dead even if it looks open,
        // as when the API restarts behind the development proxy, so the page starts over instead of freezing.
        let heard = Date.now();
        stream.addEventListener("heartbeat", () => { heard = Date.now(); });
        watchdog = setInterval(() => {
          if (cancelled || Date.now() - heard < 15_000) return;
          clearInterval(watchdog); stream?.close();
          setConnected(false); setFeedStatus("unavailable"); setError("Lost contact with the local service. Reconnecting…"); reconnectSoon();
        }, 5_000);
        stream.addEventListener("state", event => {
          heard = Date.now();
          if (cancelled) return;
          const next = JSON.parse((event as MessageEvent).data) as RuntimeSnapshot;
          setSnapshot(next);
          setConnected(true);
          if (next.playback.status === "playing" && !camera?.paused) setFeedStatus("observing");
          const frame = next.latest_observation?.frame_id ?? "";
          if (frame && frame !== received.current) {
            received.current = frame;
            setPulse(["vision"]);
            clearTimeout(pulseTimer.current);
            pulseTimer.current = setTimeout(() => setPulse([]), 1100);
          }
          if (next.playback.status === "complete") restartFeed.current();
          const request = ++requestNumber;
          void api<{ events: TimelineEvent[] }>(`/api/sessions/${initial.state.session_id}/events`).then(result => {
            if (!cancelled && request === requestNumber) setEvents(result.events);
          }).catch(reason => { if (!cancelled) { setFeedStatus("unavailable"); setError(String(reason.message)); reconnectSoon(); } });
        });
        stream.onerror = () => { setConnected(false); setFeedStatus("unavailable"); reconnectSoon(); };
      };
      const startFeed = async (restart = false) => {
        if (cancelled || starting || !camera) return;
        starting = true;
        setFeedStatus("connecting");
        try {
          if (restart) {
            await api(`/api/sessions/${initial.state.session_id}/reset`, {});
            if (cancelled) return;
            received.current = "";
            setEvents([]);
            setSelected(null);
          }
          camera.pause();
          camera.currentTime = 0;
          const next = await api<RuntimeSnapshot>(`/api/sessions/${initial.state.session_id}/start`, { speed: 1 });
          if (cancelled) {
            await api(`/api/sessions/${initial.state.session_id}/pause`, {});
            return;
          }
          await camera.play();
          if (cancelled) { camera.pause(); return; }
          setSnapshot(next);
          setFeedStatus("observing");
          setError("");
          openStream();
        } catch (reason) {
          camera.pause();
          void api(`/api/sessions/${initial.state.session_id}/pause`, {}).catch(() => {});
          if (!cancelled) {
            setFeedStatus("unavailable");
            if (reason instanceof DOMException && reason.name === "NotAllowedError") {
              setError("Click Start preview to allow video playback in this browser.");
            } else {
              setError("Camera preview interrupted. Reconnecting…");
              reconnectSoon();
            }
          }
        } finally { starting = false; }
      };
      restartFeed.current = () => { void startFeed(true); };
      void startFeed();
    }).catch(reason => { if (!cancelled) { setFeedStatus("unavailable"); setError(String(reason.message)); reconnectSoon(); } });
    return () => { cancelled = true; restartFeed.current = () => {}; video.current?.pause(); stream?.close(); clearInterval(watchdog); clearTimeout(retryTimer); clearTimeout(pulseTimer.current); if (session.current) void api(`/api/sessions/${session.current}/pause`, {}).catch(() => {}); };
  }, [retry, phoneMode]);

  function configure(section = "Connections", provider?: string) { setConnectionFocus(provider ? { id: provider } : null); setSettingsTab(section); setTab("settings"); }
  async function sessionCheck(action: "restart" | "occlusion") {
    if (!session.current || phoneMode || sessionBusy) return;
    setSessionBusy(true); setSessionNote("");
    try {
      if (action === "restart") video.current?.pause();
      const next = await api<RuntimeSnapshot>(`/api/sessions/${session.current}/${action}`, action === "occlusion" ? { enabled: !snapshot?.playback.manual_occlusion } : {});
      setSnapshot(next);
      if (action === "restart" && video.current) {
        video.current.currentTime = next.playback.current_time;
        await video.current.play();
        setSnapshot(await api<RuntimeSnapshot>(`/api/sessions/${session.current}/start`, { speed: 1 }));
        setSessionNote("Saved state restored. Fresh observations will confirm the room again.");
      } else setSessionNote(next.playback.manual_occlusion ? "View blocked. Monitoring uncertainty is retained." : "View restored. Waiting for confirmed observations.");
    } catch (reason) { setSessionNote(reason instanceof Error ? reason.message : "The session check failed."); }
    finally { setSessionBusy(false); }
  }
  async function comfort(action: ComfortAction) {
    if (comfortWorking) return;
    setComfortWorking(true);
    try {
      if (speakerOnCamera) {
        playLocalComfort("stop");
        const result = await managerApi<Omit<SpeakerState, "configured">>("camera/speaker", { action });
        setCameraSpeaker(previous => ({ ...previous, playing: result.playing, title: result.title, volume: result.volume ?? previous.volume }));
        setComfortStatus(action === "stop" ? comfortLabels.stop : "");
        return;
      }
      if (phoneMode && !homeCamera) {
        if (!phoneCamera.pair || phoneCamera.status !== "live" || !phoneCamera.speakerReady) throw new Error("Enable sound on the connected phone first.");
        const response = await fetch(`/api/camera/${phoneCamera.pair.id}/action`, { method: "POST", headers: { Authorization: `Bearer ${phoneCamera.pair.ownerToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ type: action }) });
        if (!response.ok) { const result = await response.json(); throw new Error(result.error || "The phone did not accept the sound action."); }
        // PetAnalytics compares the dog's activity before and after each sound it can hear: the server logs the camera
        // speaker, and this logs the paired phone. Sound on this computer is not logged, since the dog may not hear it.
        if (action !== "stop") void managerApi("log/comfort", { sound: action }).catch(() => {});
      } else playLocalComfort(action);
      setComfortStatus(comfortLabels[action]);
    } catch (reason) { setComfortStatus(reason instanceof Error ? reason.message : "Sound action failed."); }
    finally { setComfortWorking(false); }
  }
  async function setVolume(level: SpeakerVolume) {
    try {
      const result = await managerApi<Omit<SpeakerState, "configured">>("camera/speaker", { volume: level });
      setCameraSpeaker(previous => ({ ...previous, ...result }));
      try { localStorage.setItem(volumeChoice, level); } catch { /* The choice then lasts until the server restarts. */ }
    } catch (reason) { setComfortStatus(reason instanceof Error ? reason.message : "The volume did not change."); }
  }
  const playing = phoneMode ? phoneCamera.status === "live" : feedStatus === "observing" && connected;
  const observation = snapshot?.latest_observation;
  const activity = [...events].reverse();
  const detail = selected ? eventCopy(selected.mutation) : null;
  // The camera speaker can outlive this page, so its state comes from the server.
  const speakerLine = cameraSpeaker.playing === "found" ? `Playing “${cameraSpeaker.title ?? "a found recording"}” on the camera` : cameraSpeaker.playing ? `${comfortLabels[cameraSpeaker.playing]} on the camera` : "";
  const comfortLine = speakerOnCamera && cameraSpeaker.playing ? speakerLine : comfortStatus;
  return <div className="manager">
    <aside className="sidebar">
      <div className="sidebar-head"><div className="wordmark"><DogMark className="wordmark-mark" /><span>DogMaAI</span></div><SoundToggle className="top-bar-only" /></div>
      <nav className="main-nav" aria-label="Workspace">
        <button className={tab === "overview" ? "selected" : ""} data-sound="page" onClick={() => setTab("overview")}><Icon name="home" />Overview</button>
        <button className={tab === "settings" ? "selected" : ""} data-sound="page" onClick={() => configure()}><Icon name="settings" />Settings</button>
        <button className={tab === "analytics" ? "selected" : ""} data-sound="page" onClick={() => setTab("analytics")}><Icon name="paw" />PetAnalytics</button>
      </nav>
      <div className="sidebar-bottom"><DogsPlaying className="sidebar-art" onCloud /><span className={`service-dot ${serviceReachable ? "online" : ""}`} /><span>{serviceReachable === null ? "Connecting…" : serviceReachable ? "Local connection" : "Offline"}</span><SoundToggle /></div>
    </aside>
    <main className="main-content">
      {error && <div className="error-note" role="alert">{error}<button data-sound="tap" onClick={() => { setConnected(false); setRetry(value => value + 1); }}>{error.startsWith("Click Start preview") ? "Start preview" : "Reconnect"}</button></div>}
      <div hidden={tab !== "overview"}>
        <div className="workspace-grid">
          <section className="camera-section" aria-label="Camera">
            <div className="section-heading"><h1 className="camera-heading">DogMaAI</h1><span className={`feed-status ${playing ? "is-observing" : ""}`}><i />{phoneMode ? playing ? "Live" : phoneCamera.status === "stale" || phoneCamera.status === "error" ? "Connection lost" : "Waiting for camera" : playing ? "Observing" : feedStatus === "unavailable" ? "Connection lost" : "Connecting"}</span></div>
            <div className="camera-stage observer-stage">
              <video hidden={phoneMode} ref={video} src="/demo.mp4" poster="/dog-poster.jpg" muted playsInline preload="auto" disablePictureInPicture onEnded={() => restartFeed.current()} onError={() => { if (phoneMode) return; setFeedStatus("unavailable"); setError("Camera source is unavailable. Reconnect to try again."); }} />
              {phoneMode && (phoneCamera.image && playing ? <img className="live-camera-image" src={phoneCamera.image} alt={homeCamera ? "Live view from your home camera" : "Live view from your paired phone"} /> : <div className="camera-waiting"><DogsTogether className="waiting-art" /><p>{homeCamera ? phoneCamera.status === "error" ? "Reconnect your home camera" : phoneCamera.status === "off" ? "Home camera disconnected" : phoneCamera.error || "Connecting to your home camera…" : phoneCamera.status === "stale" ? "Open the camera page on your phone" : phoneCamera.status === "error" ? "Connect your phone again" : "Your phone’s view will appear here"}</p><button className="secondary-button" onClick={() => configure("Connections", "camera")}>{homeCamera ? "Camera settings" : phoneCamera.pair && phoneCamera.status !== "error" ? "Show pairing code" : "Connect camera"}</button></div>)}
              {(!phoneMode || playing) && <span className="camera-position">{phoneMode ? homeCamera ? "Home camera" : "Phone camera" : "Sample clip · Kennel"}</span>}
              {!phoneMode && <a className="clip-credit" href="https://www.pexels.com/video/a-dog-is-in-a-cage-with-its-head-sticking-out-17747645/" target="_blank" rel="noreferrer" title="Video by Nothing Ahead on Pexels, free to use under the Pexels License. Converted to MP4 without sound; shown in greyscale.">Video: Nothing Ahead · Pexels</a>}
            </div>
            {!phoneMode && snapshot?.playback.manual_occlusion && <p className="view-uncertain">View blocked · Waiting for fresh evidence</p>}
            <div className={`observation ${pulse.includes("vision") ? "recent" : ""}`}><Icon name="eye" /><p>{phoneMode ? liveVision || (connectionStates.liquid?.verifiedAt ? visionWorking ? "Liquid AI is analyzing the live view…" : "Waiting for a model description…" : "Start the vision model with npm run vision to describe this camera.") : observation?.short_description ?? "Waiting for the next observation…"}</p></div>
            {phoneMode && visionError && <p className="view-uncertain" role="status">Liquid AI: {visionError}</p>}
            {!phoneMode && snapshot && <details className="room-context"><summary data-sound="disclosure">Room context <span>{roomSummary(snapshot.state.room)}</span></summary><p>{snapshot.state.room.uncertainties.join(" ") || "Confirmed from repeated observations."}</p>{snapshot.state.situations.filter(item => item.status !== "resolved").map(item => <p key={item.id}>{situationLabels[item.type]} · {words(item.status)}</p>)}<small>{snapshot.state.metrics.frames_sampled} frames · {snapshot.state.metrics.repeated_observations_discarded} repeats discarded · State saved locally</small></details>}
            <DogDiary refresh={diaryRefresh} />
          </section>
          <section className="activity-section" aria-label="Activity">
            <div className="section-heading"><h2>Activity</h2><span className="listening" aria-label={playing ? "Following activity" : "Ready"}><i className={playing ? "on" : ""} /></span></div>
            <ManagerAlerts notifications={snapshot?.owner_notifications ?? []} />
            <div className="activity-list">
              {phoneMode && <div className="camera-activity"><Icon name="camera" /><div><span className="event-meta">Camera</span><strong>{playing ? homeCamera ? "Home camera connected" : "Phone camera connected" : phoneCamera.status === "stale" ? "Camera feed interrupted" : phoneCamera.status === "error" ? "Camera pairing ended" : phoneCamera.status === "off" ? "Camera disconnected" : homeCamera ? "Connecting to your home camera" : "Waiting for your phone"}</strong><p>{playing ? "Live images · No recording" : "Open Camera in Connections to manage the feed."}</p></div></div>}
              {!phoneMode && !activity.length && <div className="empty-activity"><DogsPlaying className="empty-art" /><p>Activity will appear here.</p></div>}
              {activity.slice(0, history ? 50 : 4).map(event => { const copy = eventCopy(event.mutation); return <button className={`activity-event ${selected?.id === event.id ? "is-selected" : ""}`} key={event.id} data-sound="tap" onClick={() => setSelected(selected?.id === event.id ? null : event)}><span className={`event-dot ${event.mutation.type === "ALERT_EMITTED" ? "attention" : ""}`} /><span><span className="event-meta">{copy.source}<time>{age((snapshot?.playback.current_time ?? 0) - event.video_timestamp)}</time></span><strong>{copy.title}</strong></span><Icon name="arrow" /></button>; })}
            </div>
            {detail && selected && <div className="event-detail"><div className="detail-title"><h3>Why this happened</h3><button aria-label="Close event details" data-sound="tap" onClick={() => setSelected(null)}><Icon name="close" /></button></div><dl><dt>Evidence</dt><dd>{selected.frame_id ?? "Monitoring rule"} · {time(selected.video_timestamp)}</dd><dt>Decision summary</dt><dd>{detail.detail}</dd><dt>Result</dt><dd>{detail.result}</dd></dl><small>Summary from recorded events, not model reasoning.</small></div>}
            <div className="comfort-tools" id="comfort-tools"><div className="comfort-heading"><Icon name="speaker" /><strong>Comfort tools</strong><span>Manual demo</span></div><div className="comfort-body"><p>Calm music may help a dog settle while alone, and brown noise may soften outside sounds. Neither treats separation anxiety. {speakerOnCamera ? "Sound plays through the camera's speaker and keeps going if you close this page." : phoneMode && !homeCamera ? "The phone plays sound only after you enable it there." : "Sound plays on this computer."}</p><DogsTogether className="comfort-art" /></div><div className="comfort-actions">{comfortChoices.map(([action, label]) => <button key={action} className="keycap" data-sound="key" disabled={comfortWorking || (phoneMode && !homeCamera && !phoneCamera.speakerReady)} onClick={() => void comfort(action)}>{label}</button>)}</div>{speakerOnCamera && <div className="volume-row" role="group" aria-label="Camera speaker volume"><span>Camera volume</span>{speakerVolumes.map(level => <button key={level} className="keycap" data-sound="tap" aria-pressed={cameraSpeaker.volume === level} onClick={() => void setVolume(level)}>{volumeNames[level]}</button>)}</div>}{comfortLine && <small role="status">{comfortLine}</small>}<FoundSounds onCamera={speakerOnCamera} onSpeaker={setCameraSpeaker} onStatus={setComfortStatus} /></div>
            {activity.length > 4 && <button className="quiet-link history-link" data-sound="tap" onClick={() => setHistory(!history)}>{history ? "Show recent activity" : `View all ${activity.length} events`}<Icon name="arrow" /></button>}
          </section>
        </div>
      </div>
      <section hidden={tab !== "analytics"} className="analytics-page" aria-label="PetAnalytics"><PetAnalyticsPage active={tab === "analytics"} onTuneHearing={() => configure("Connections", "sound")} /></section>
      <section hidden={tab !== "settings"} className="settings-page">
        <div className="page-heading"><h1>Settings</h1><button className="quiet-link" onClick={() => setTab("overview")}>Back to overview <Icon name="arrow" /></button></div>
        <nav className="settings-tabs" aria-label="Settings sections">{["Connections", "Demo assets"].map(item => <button key={item} aria-current={settingsTab === item ? "page" : undefined} className={settingsTab === item ? "active" : ""} data-sound="tap" onClick={() => setSettingsTab(item)}>{item}</button>)}</nav>
        {settingsTab === "Connections" && <ConnectionsSettings active={tab === "settings"} states={connectionStates} focus={connectionFocus} cameraSettings={(expanded, onToggle) => <CameraSettings camera={phoneCamera} expanded={expanded} onToggle={onToggle} />} />}
        {settingsTab === "Demo assets" && <><section className="asset-section"><h3>Session checks</h3><p>Check how the current sample session handles a blocked view and restores saved memory.</p><div className="setup-actions"><button className="secondary-button" data-sound="tap" disabled={phoneMode || sessionBusy || !snapshot} onClick={() => void sessionCheck("occlusion")}>{snapshot?.playback.manual_occlusion ? "Restore view" : "Block view"}</button><button className="secondary-button" data-sound="tap" disabled={phoneMode || sessionBusy || !snapshot} onClick={() => void sessionCheck("restart")}>Restore saved state</button></div>{phoneMode && <p className="draft-notice">These checks apply to sample footage. Switch back in Camera settings to use them.</p>}{sessionNote && <p className="setup-feedback" role="status">{sessionNote}</p>}</section><DemoAssets /></>}
      </section>
    </main>
  </div>;
}
// Buttons say which sound they make with data-sound; one listener plays them all.
installClickSounds();
const managerWindow = window as Window & { __dogmaManagerRoot?: ReturnType<typeof createRoot> };
(managerWindow.__dogmaManagerRoot ??= createRoot(document.getElementById("root")!)).render(<Manager />);

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { managerApi } from "./ManagerSetup";

interface Pairing { id: string; ownerToken: string; url: string; expiresAt: number }
export type CameraStatus = "off" | "waiting" | "paired" | "live" | "stale" | "error";

// The home camera choice is remembered in this browser, so a reload or a DogMaAI restart reconnects by itself and
// PetAnalytics keeps collecting. Choosing the sample clip, a phone or Disconnect forgets it.
const homeChoice = "dogmaai.camera";
function remembersHome() { try { return localStorage.getItem(homeChoice) === "home"; } catch { return false; } }
function rememberHome(on: boolean) {
  try { if (on) localStorage.setItem(homeChoice, "home"); else localStorage.removeItem(homeChoice); }
  catch { /* Storage can be blocked; the choice then lasts until the page reloads. */ }
}

export function usePhoneConnection() {
  const [pair, setPair] = useState<Pairing | null>(null);
  const [mode, setMode] = useState<"sample" | "phone">(() => remembersHome() ? "phone" : "sample");
  const [source, setSource] = useState<"phone" | "home">(() => remembersHome() ? "home" : "phone");
  const [homeConfigured, setHomeConfigured] = useState(false);
  const [status, setStatus] = useState<CameraStatus>(() => remembersHome() ? "waiting" : "off");
  const [image, setImage] = useState("");
  const [qr, setQr] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [speakerReady, setSpeakerReady] = useState(false);
  const imageRef = useRef("");
  const mounted = useRef(true);
  const reconnectHome = useRef<() => void>(() => {});
  // A retry waiting after a failed reconnect, and the times of recent automatic reconnects.
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoReconnects = useRef<number[]>([]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; clearTimeout(retryTimer.current); }; }, []);
  useEffect(() => {
    // Retried so a page opened while the API restarts still offers the home camera.
    let timer: ReturnType<typeof setTimeout>;
    const check = () => { void managerApi<{ configured: boolean }>("camera/home").then(result => {
      if (!mounted.current) return;
      setHomeConfigured(result.configured);
      if (!remembersHome()) return;
      if (result.configured) reconnectHome.current();
      else { rememberHome(false); setMode("sample"); setSource("phone"); setStatus("off"); }
    }).catch(() => { if (mounted.current) timer = setTimeout(check, 5000); }); };
    check();
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!pair) return;
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    let sequence = "0";
    const abort = new AbortController();
    if (pair.url) void QRCode.toDataURL(pair.url, { width: 220, margin: 2, color: { dark: "#303749", light: "#ffffff" } }).then(value => { if (!closed) setQr(value); }).catch(() => { if (!closed) setError("QR code unavailable. Copy the camera link instead."); });
    async function receive() {
      try {
        const response = await fetch(`/api/camera/${pair!.id}/frame?after=${sequence}`, { headers: { Authorization: `Bearer ${pair!.ownerToken}` }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(8000)]), cache: "no-store" });
        if (closed) return;
        if (response.status === 403) {
          setImage("");
          // A remembered home view that ended, as it does when DogMaAI restarts, reconnects by itself: up to three times in
          // five minutes, so tabs pushed out by the server's limit on camera sessions do not keep pushing each other out.
          const recent = autoReconnects.current.filter(time => Date.now() - time < 5 * 60_000);
          if (!pair!.url && remembersHome() && recent.length < 3) {
            autoReconnects.current = [...recent, Date.now()];
            setStatus("waiting"); setError("");
            timer = setTimeout(() => { if (remembersHome()) reconnectHome.current(); }, 2000);
            return;
          }
          setStatus("error"); setError(pair!.url ? "Pairing ended or expired. Connect your phone again." : "The home camera view ended. Select Use home camera to reconnect."); return;
        }
        if (!response.ok) throw new Error("Camera connection interrupted.");
        const frameAt = Number(response.headers.get("X-Frame-Time"));
        const paired = response.headers.get("X-Camera-State") === "paired";
        setSpeakerReady(response.headers.get("X-Speaker-Ready") === "1");
        if (response.status === 200) {
          const blob = await response.blob();
          if (closed) return;
          const url = URL.createObjectURL(blob);
          if (imageRef.current) URL.revokeObjectURL(imageRef.current);
          imageRef.current = url;
          setImage(url);
          sequence = response.headers.get("X-Frame-Sequence") ?? sequence;
        }
        const fresh = frameAt > 0 && Date.now() - frameAt < 5000;
        setStatus(fresh ? "live" : paired ? frameAt ? "stale" : "paired" : "waiting");
        if (!fresh) setImage("");
        setError(fresh ? "" : response.headers.get("X-Camera-Problem") ?? "");
      } catch {
        if (!closed) { setStatus("stale"); setImage(""); setError(pair!.url ? "Camera connection interrupted. Keep the phone page open." : "Lost contact with DogMaAI. Check that it is still running."); }
      }
      if (!closed) timer = setTimeout(() => void receive(), 300);
    }
    void receive();
    return () => {
      closed = true; abort.abort(); clearTimeout(timer);
      if (imageRef.current) URL.revokeObjectURL(imageRef.current);
      imageRef.current = "";
      void fetch(`/api/camera/${pair.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${pair.ownerToken}` }, keepalive: true }).catch(() => {});
    };
  }, [pair]);
  async function releasePair() {
    if (!pair) return;
    const response = await fetch(`/api/camera/${pair.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${pair.ownerToken}` }, signal: AbortSignal.timeout(8000) });
    if (!response.ok && response.status !== 403) throw new Error("Could not disconnect. Try again or stop the camera on your phone.");
    setPair(null); setImage(""); setQr(""); setSpeakerReady(false);
  }
  async function connect() {
    if (busy) return;
    clearTimeout(retryTimer.current);
    setBusy(true); setError("");
    try {
      await releasePair();
      const next = await managerApi<Pairing>("camera/pair", {});
      if (!mounted.current) { void fetch(`/api/camera/${next.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${next.ownerToken}` } }); return; }
      rememberHome(false); setSource("phone"); setPair(next); setMode("phone"); setStatus("waiting");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create a camera link."); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function connectHome() {
    if (busy) return;
    clearTimeout(retryTimer.current);
    setBusy(true); setError("");
    try {
      await releasePair();
      const next = await managerApi<Pairing>("camera/home", {});
      if (!mounted.current) { void fetch(`/api/camera/${next.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${next.ownerToken}` } }); return; }
      rememberHome(true); setSource("home"); setPair(next); setMode("phone"); setStatus("waiting");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not connect your home camera.");
      // While DogMaAI restarts, the request fails without an answer; a remembered home camera tries again.
      if (mounted.current && remembersHome() && (reason instanceof TypeError || reason instanceof SyntaxError)) {
        retryTimer.current = setTimeout(() => { if (remembersHome()) reconnectHome.current(); }, 5000);
      }
    }
    finally { if (mounted.current) setBusy(false); }
  }
  reconnectHome.current = () => { if (mounted.current) void connectHome(); };
  async function disconnect(sample = false) {
    if (busy) return;
    clearTimeout(retryTimer.current);
    setBusy(true); setError("");
    try { await releasePair(); rememberHome(false); setStatus("off"); if (sample) setMode("sample"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not disconnect."); }
    finally { setBusy(false); }
  }
  return { pair, mode, source, homeConfigured, status, image, qr, error, busy, speakerReady, connect, connectHome, disconnect };
}
export type PhoneConnection = ReturnType<typeof usePhoneConnection>;
export function CameraSettings({ camera, expanded, onToggle }: { camera: PhoneConnection; expanded: boolean; onToggle: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const home = camera.source === "home" && camera.pair !== null && camera.status !== "error";
  const label = camera.busy ? "Connecting…" : camera.status === "live" ? "Live" : camera.source === "home" && camera.pair ? camera.status === "error" ? "Reconnect" : "Connecting" : camera.pair ? "Pairing" : "Connect";
  return <section className="setup-provider">
    <button className="provider-disclosure" data-sound="disclosure" aria-expanded={expanded} onClick={onToggle}><span><strong>Camera</strong><small>{camera.homeConfigured ? "Use your home Wi-Fi camera or your phone" : "Use your phone’s rear camera"}</small></span><span className={camera.status === "live" ? "verified-label" : ""}>{label}<span className="disclosure-chevron">{expanded ? "−" : "+"}</span></span></button>
    {expanded && <div className="provider-body">
      {home ? <p className="draft-notice">{camera.status === "live" ? "Your home camera is connected." : "Connecting to your home camera…"}</p> : camera.pair && camera.status !== "error" ? <div className="camera-pairing">
        {camera.qr && <img src={camera.qr} alt="Scan with your phone to connect its camera" width="180" height="180" />}
        <div><h3>{camera.status === "live" ? "Your phone is connected" : "Scan with your phone"}</h3><p className="draft-notice">Open the link, tap Start camera, and allow camera access. Keep the phone page open.</p><p className="draft-notice">This pairing link can be used once and expires after 10 minutes.</p><button className="secondary-button" onClick={async () => { try { await navigator.clipboard.writeText(camera.pair!.url); setCopied(true); setCopyError(false); } catch { setCopyError(true); } }}>{copied ? "Link copied" : "Copy camera link"}</button>{copyError && <p className="draft-notice">Copy this link: <a className="camera-url" href={camera.pair.url}>{camera.pair.url}</a></p>}</div>
      </div> : <p className="draft-notice">{camera.homeConfigured ? "Use your home camera or connect a phone" : "Connect a phone"} to replace the sample footage with a live camera view.</p>}
      <div className="setup-actions">
        {camera.homeConfigured && !home && <button className="primary-button" data-sound="switchOn" disabled={camera.busy} onClick={() => void camera.connectHome()}>Use home camera</button>}
        {(!camera.pair || camera.status === "error") && <button className={camera.homeConfigured ? "secondary-button" : "primary-button"} data-sound="switchOn" disabled={camera.busy} onClick={() => void camera.connect()}>{camera.busy ? "Connecting…" : "Connect phone"}</button>}
        {camera.pair && <button className="secondary-button" data-sound="switchOff" disabled={camera.busy} onClick={() => void camera.disconnect()}>Disconnect</button>}
        {camera.mode === "phone" && <button className="quiet-link" data-sound="switchOff" disabled={camera.busy} onClick={() => void camera.disconnect(true)}>Use sample footage</button>}
      </div>
      {camera.error && <p className="setup-feedback failed" role="alert">{camera.error}</p>}
      {!camera.homeConfigured && <p className="draft-notice">To use a Wi-Fi camera such as Tapo, add its RTSP address as CAMERA_RTSP_URL in .env and restart DogMaAI.</p>}
      <p className="draft-notice">{home ? "This computer reads your home camera directly over your network; no relay is used. Only the latest image is held in memory and nothing is recorded. Liquid AI can describe the live view; comfort sounds play on this computer." : camera.homeConfigured && !camera.pair ? "A home camera is read directly over your network. A phone sends images through a Cloudflare HTTPS relay. Only the latest image is held in memory and nothing is recorded." : "Images travel through a Cloudflare HTTPS relay to this computer. Only the latest image is held in memory. The microphone is off. Liquid AI can describe the live view; comfort sounds play only after you enable them on the phone."}</p>
    </div>}
  </section>;
}

import { useEffect, useRef, useState, type ReactNode } from "react";
import { HearingCheck } from "./HearingCheck";

export type ServiceId = "liquid" | "nimble" | "tinybird" | "sound";
export type ConnectionStates = Partial<Record<ServiceId, { configured: boolean; verifiedAt?: string | null; message: string; source?: "env" }>>;
export { managerApi } from "./manager-api";

// Services are set up in .env on this computer; Settings only shows their state and where each one is configured.
const services: { id: ServiceId; name: string; role: string; setup: string }[] = [
  { id: "liquid", name: "Liquid AI", role: "Describes the camera on this computer", setup: "Start it with npm run vision. DogMaAI finds it by itself, at the port set by LIQUID_PORT in .env." },
  { id: "nimble", name: "Nimble", role: "Finds new sounds and alert guidance", setup: "Set by NIMBLE_API_KEY in .env." },
  { id: "tinybird", name: "Tinybird", role: "Keeps the dog diary, PetAnalytics and telemetry", setup: "npm run tinybird:setup deploys the tables and fills in TINYBIRD_TOKEN and TINYBIRD_API_URL in .env." },
  { id: "sound", name: "Sound recognition", role: "Hears crying and barking from the home camera", setup: "npm run sound-model:setup downloads Google's YAMNet sound model (16 MB, Apache-2.0) into models/yamnet, and npm run tinybird:setup adds the dog_sounds table that keeps the minutes. The model runs on this computer; audio is never recorded or sent anywhere." }
];
export function ConnectionsSettings({ states, focus, cameraSettings, active = true }: { states: ConnectionStates; focus: { id: string } | null; cameraSettings: (expanded: boolean, toggle: () => void) => ReactNode; active?: boolean }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  // A link to one service opens its row and brings it into view.
  useEffect(() => {
    setExpanded(focus?.id ?? null);
    if (!focus) return;
    const frame = requestAnimationFrame(() => document.getElementById(`setup-${focus.id}`)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  return <>
    {cameraSettings(expanded === "camera", () => setExpanded(expanded === "camera" ? null : "camera"))}
    <p className="draft-notice">Services are set up in .env on this computer, and their keys never reach this page. After changing .env, restart DogMaAI.</p>
    {services.map(service => {
      const state = states[service.id];
      return <section className="setup-provider" id={`setup-${service.id}`} key={service.id}>
        <button className="provider-disclosure" data-sound="disclosure" aria-expanded={expanded === service.id} onClick={() => setExpanded(expanded === service.id ? null : service.id)}><span><strong>{service.name}</strong><small>{service.role}</small></span><span className={state?.configured ? "verified-label" : ""}>{!state ? "Checking…" : state.configured ? "Ready" : "Not set up"}<span className="disclosure-chevron">{expanded === service.id ? "−" : "+"}</span></span></button>
        {expanded === service.id && <div className="provider-body"><p className="setup-feedback" role="status">{state?.message ?? "Checking…"}</p><p className="draft-notice">{service.setup}</p>{service.id === "sound" && <HearingCheck active={active} />}</div>}
      </section>;
    })}
  </>;
}

export function DemoAssets() {
  const [preview, setPreview] = useState("");
  const previewRef = useRef("");
  useEffect(() => () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); }, []);
  return <>
    <section className="asset-section"><h3>Test your phone camera</h3><p>Open the sample clip full screen on this computer, point your phone’s rear camera at it, and watch the manager update.</p><a className="secondary-button test-screen-link" href="/test-screen.html" target="_blank" rel="noreferrer">Open camera test screen ↗</a></section>
    <section className="asset-section"><h3>Sample footage</h3><p>The bundled 32-second clip matches the sample observations: a dog alone in its kennel stands at the bars, a person’s hand reaches in with a treat, pulls away and comes back. Other videos can be previewed here; their observations need a real vision provider or their own reviewed annotations.</p><p className="draft-notice"><a href="https://www.pexels.com/video/a-dog-is-in-a-cage-with-its-head-sticking-out-17747645/" target="_blank" rel="noreferrer">Video by Nothing Ahead on Pexels</a>, free to use under the <a href="https://www.pexels.com/license/" target="_blank" rel="noreferrer">Pexels License</a>. Converted to MP4 without sound and shown in greyscale.</p><label className="file-picker">Preview a local video<input type="file" accept="video/mp4,video/webm,video/quicktime" onChange={event => { const file = event.target.files?.[0]; if (!file) return; if (previewRef.current) URL.revokeObjectURL(previewRef.current); const url = URL.createObjectURL(file); previewRef.current = url; setPreview(url); }} /></label>{preview && <><video className="asset-video" src={preview} controls playsInline /><p className="draft-notice">Local preview only. This file is not uploaded or analyzed.</p></>}</section>
    <section className="asset-section"><h3>The most convincing sequence</h3><p>Use a fixed camera in the room where your dog stays. Film a short, continuous sequence: you leave, your dog settles or goes to the door, you briefly block the camera, then you come back. Keep it continuous so the audience can see why the context changes.</p></section>
  </>;
}

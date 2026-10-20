import type { OwnerNotification } from "../shared/api";

function sourceUrl(url: string) {
  try { const parsed = new URL(url); return parsed.protocol === "https:" ? parsed.href : null; } catch { return null; }
}
export function ManagerAlerts({ notifications }: { notifications: OwnerNotification[] }) {
  return <>{notifications.slice(0, 2).map(notification => <details className="manager-alert" key={notification.id}>
    <summary data-sound="disclosure"><span className="event-meta"><span>In-app alert</span><span>{notification.status === "researching" ? "Sources loading" : notification.research_provider === "nimble_live" ? "Nimble" : "Saved sources"}</span></span><strong>Check on your dog</strong></summary>
    <p>{notification.message}</p>
    {notification.research_summary && <p>{notification.research_summary}</p>}
    <div className="alert-sources">{notification.sources.map(source => { const url = sourceUrl(source.url); return url ? <a key={url} href={url} target="_blank" rel="noreferrer">{source.title} ↗</a> : null; })}</div>
    <small>Shown in this manager. No text message or phone call was sent.</small>
  </details>)}</>;
}

import Nimble from "@nimble-way/nimble-js";
import { randomBytes } from "node:crypto";
import express, { Router } from "express";
import { z } from "zod";
import type { DayPeriod, FoundSound, SoundSearch } from "../shared/sounds.js";
import { requireLocalManager } from "./manager-api.js";
import { isCommonsUpload, wikimediaUserAgent } from "./remote-sound.js";

export interface PlayableSound { url: string; title: string }

export function dayPeriod(date: Date): DayPeriod {
  const hour = date.getHours();
  if (hour >= 6 && hour < 11) return "morning";
  if (hour >= 11 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

// Kennelled dogs rested more with classical music (Kogan 2012), and soft rock and reggae brought the largest calming
// changes in Bowman 2017. Varying what plays keeps dogs from getting used to it; nights stay slow and quiet.
const plans: Record<DayPeriod, { label: string; queries: string[] }> = {
  morning: { label: "Morning · gentle classical", queries: ["gentle classical guitar music", "calm harp music"] },
  afternoon: { label: "Afternoon · soft rock and reggae", queries: ["soft rock instrumental music", "reggae instrumental music"] },
  evening: { label: "Evening · calm classical", queries: ["calm classical piano music", "slow string quartet music"] },
  night: { label: "Night · slow and quiet", queries: ["slow quiet piano music", "soft ambient music"] }
};
// Suggested music runs at least a minute; a search for a sound such as birdsong or a bark also finds shorter recordings.
const minimumSeconds = 60;
const minimumSearchSeconds = 10;
const maximumSeconds = 3 * 60 * 60;
const searchText = /^[\p{L}\p{N}][\p{L}\p{N} ,.'&-]{1,59}$/u;
const shown = 5;

class FinderError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// Nimble returns web pages; only Commons file and category pages lead to recordings.
export function commonsTitle(address: string): string | null {
  try {
    const url = new URL(address);
    if (url.protocol !== "https:" || !["commons.wikimedia.org", "commons.m.wikimedia.org"].includes(url.hostname)) return null;
    const title = decodeURIComponent(url.pathname.startsWith("/wiki/") ? url.pathname.slice(6) : url.searchParams.get("title") ?? "").replaceAll("_", " ");
    return /^(File|Category):\S/.test(title) ? title : null;
  } catch {
    return null;
  }
}

// Commons metadata is HTML; only its text is shown.
function plain(html: string) {
  return html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&quot;/g, "\"").replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}
// Only the artist's name is shown: Commons often lists a postal address on the following lines, and link footnotes such as [2].
export function artistName(html: string) {
  const lines = html.replace(/<br\s*\/?>|<\/(dd|dt|li|p|div|tr|td)>/gi, "\n").split("\n").map(line => plain(line).replace(/\[\d+\]/g, "").trim());
  return lines.find(Boolean) ?? "";
}
// The same recording is often uploaded more than once, with details in parentheses.
const sameTitle = (title: string) => title.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
// Public domain, CC0, CC BY and CC BY-SA allow playing a recording with attribution.
export function isFreeLicense(license: string, shortName: string) {
  return /^(cc0|pd|cc-by-(sa-)?\d)/i.test(license) || /^(cc0|public domain|cc by(-sa)? \d)/i.test(shortName);
}

const metadata = z.record(z.string(), z.object({ value: z.unknown() }).passthrough());
const fileInfo = z.object({
  url: z.string(),
  descriptionurl: z.string(),
  mediatype: z.string().optional(),
  duration: z.number().optional(),
  extmetadata: metadata.optional(),
  derivatives: z.array(z.object({ src: z.string(), type: z.string() }).passthrough()).optional()
}).passthrough();
const filePages = z.object({ query: z.object({ pages: z.array(z.object({ title: z.string(), videoinfo: z.array(fileInfo).optional() }).passthrough()) }) });
const categoryMembers = z.object({ query: z.object({ categorymembers: z.array(z.object({ title: z.string() }).passthrough()) }) });
const searchResults = z.object({ query: z.object({ search: z.array(z.object({ title: z.string() }).passthrough()) }) });
// Catch-all categories hold mostly pronunciations and short samples rather than music.
const catchAll = /^Category:(Audio files|Music|Sounds?)$|\bby (genre|source|type|country|decade|year|instrument|format)$/i;

export function createSoundFinder(nimbleKey: () => string | null, fetcher: typeof fetch = fetch, now = () => new Date(), random = Math.random) {
  // Only recordings from recent searches can be played, so the camera never plays an address a page supplied.
  const playable = new Map<string, PlayableSound>();
  let busy = false;

  async function commons(params: Record<string, string>) {
    const url = new URL("https://commons.wikimedia.org/w/api.php");
    for (const [key, value] of Object.entries({ action: "query", format: "json", formatversion: "2", ...params })) url.searchParams.set(key, value);
    const response = await fetcher(url, { headers: { "User-Agent": wikimediaUserAgent }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); throw new FinderError(502, "Wikimedia Commons did not answer. Try again in a moment."); }
    return await response.json() as unknown;
  }

  async function describe(titles: string[], minimum: number) {
    const parsed = filePages.safeParse(await commons({
      // Commons reports a recording's duration only when its size is requested.
      titles: titles.join("|"), prop: "videoinfo", viprop: "url|size|mediatype|extmetadata|derivatives",
      viextmetadatafilter: "ObjectName|Artist|LicenseShortName|LicenseUrl|License|Restrictions"
    }));
    if (!parsed.success) throw new FinderError(502, "Wikimedia Commons returned an unexpected answer.");
    const order = (title: string) => { const index = titles.indexOf(title); return index < 0 ? titles.length : index; };
    const sounds: FoundSound[] = [];
    const seen = new Set<string>();
    for (const page of [...parsed.data.query.pages].sort((left, right) => order(left.title) - order(right.title))) {
      const info = page.videoinfo?.[0];
      if (!info || info.mediatype !== "AUDIO") continue;
      const text = (key: string) => { const value = info.extmetadata?.[key]?.value; return typeof value === "string" ? plain(value) : ""; };
      const duration = info.duration ?? 0;
      const license = text("LicenseShortName");
      if (duration < minimum || duration > maximumSeconds || !isFreeLicense(text("License"), license) || text("Restrictions")) continue;
      // Commons also offers an MP3 of most recordings, which every browser and the camera can play.
      const mp3 = info.derivatives?.find(item => item.type.startsWith("audio/mpeg"))?.src;
      const address = (mp3 ?? info.url).split("?")[0];
      if (!isCommonsUpload(address)) continue;
      const title = (text("ObjectName") || page.title.replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "")).slice(0, 120);
      if (seen.has(sameTitle(title))) continue;
      seen.add(sameTitle(title));
      const id = randomBytes(9).toString("base64url");
      const licenseUrl = text("LicenseUrl");
      playable.set(id, { url: address, title });
      sounds.push({
        id, title, artist: artistName(typeof info.extmetadata?.Artist?.value === "string" ? info.extmetadata.Artist.value : "").slice(0, 80) || "Unknown artist", license: license || "Public domain",
        license_url: /^https?:\/\//.test(licenseUrl) ? licenseUrl : null, page: info.descriptionurl,
        duration_seconds: Math.round(duration), preview_url: address
      });
      if (sounds.length === shown) break;
    }
    while (playable.size > 30) playable.delete(playable.keys().next().value!);
    return sounds;
  }

  // Without a search, a suggestion for the time of day; with one, recordings matching the words, such as "birdsong".
  async function search(words = ""): Promise<SoundSearch> {
    const apiKey = nimbleKey();
    if (!apiKey) throw new FinderError(409, "Add NIMBLE_API_KEY to .env to find new sounds.");
    const period = dayPeriod(now());
    const plan = plans[period];
    const query = words || plan.queries[Math.floor(random() * plan.queries.length)];
    const minimum = words ? minimumSearchSeconds : minimumSeconds;
    const client = new Nimble({ apiKey, fetch: fetcher, maxRetries: 0, timeout: 25_000 });
    let pages: { url: string }[];
    try {
      pages = (await client.search({ query: `${query} audio`, include_domains: ["commons.wikimedia.org"], search_depth: "lite", max_results: 10, country: "US", locale: "en" })).results;
    } catch (reason) {
      const status = (reason as { status?: number }).status;
      throw new FinderError(502, status === 401 || status === 403 ? "Nimble rejected the key. Check it in Settings." : "Nimble search did not complete. Try again in a moment.");
    }
    const titles = [...new Set(pages.map(page => commonsTitle(page.url)).filter((title): title is string => title !== null))];
    const files = titles.filter(title => title.startsWith("File:"));
    // A category page stands for the recordings in it; a random handful keeps repeated searches varied.
    for (const category of titles.filter(title => title.startsWith("Category:") && !catchAll.test(title)).slice(0, 3)) {
      const members = categoryMembers.safeParse(await commons({ list: "categorymembers", cmtitle: category, cmtype: "file", cmlimit: "50" }));
      const names = members.success ? members.data.query.categorymembers.map(member => member.title) : [];
      for (let index = names.length - 1; index > 0; index--) { const pick = Math.floor(random() * (index + 1)); [names[index], names[pick]] = [names[pick], names[index]]; }
      files.push(...names.slice(0, 20));
    }
    const candidates = [...new Set(files)].slice(0, 50);
    let sounds = candidates.length ? await describe(candidates, minimum) : [];
    // Nimble's web results vary between searches and sometimes lead to no playable recording; Commons' own search for the same words fills in.
    let fromCommons = false;
    if (!sounds.length) {
      const found = searchResults.safeParse(await commons({ list: "search", srsearch: `${query} filetype:audio`, srnamespace: "6", srlimit: "30" }));
      const names = found.success ? found.data.query.search.map(item => item.title) : [];
      if (names.length) { sounds = await describe(names, minimum); fromCommons = sounds.length > 0; }
    }
    const count = `${sounds.length} free-license recording${sounds.length === 1 ? "" : "s"}`;
    return {
      period, label: words ? `Search · ${words}` : plan.label, query, sounds,
      message: !sounds.length ? "No playable free-license recordings turned up this time. Search again for a different mix."
        : fromCommons ? `Nimble's pages had no playable recordings, so these ${count} come from a Wikimedia Commons search for the same words.`
        : `Nimble found ${count} on Wikimedia Commons.`
    };
  }

  const router = Router();
  router.use(requireLocalManager);
  router.post("/search", express.json({ limit: "1kb" }), async (request, response) => {
    const words = typeof request.body?.query === "string" ? request.body.query.trim().replace(/\s+/g, " ") : "";
    if (words && !searchText.test(words)) return response.status(400).json({ error: "Search for a sound in a few words, such as birdsong or rain." });
    if (busy) return response.status(429).json({ error: "A sound search is already running." });
    busy = true;
    try {
      return response.json(await search(words));
    } catch (reason) {
      return response.status(reason instanceof FinderError ? reason.status : 502).json({ error: reason instanceof FinderError ? reason.message : "The sound search did not complete. Try again in a moment." });
    } finally { busy = false; }
  });
  return { router, find: (id: string) => playable.get(id) ?? null };
}

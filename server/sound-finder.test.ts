import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { artistName, commonsTitle, createSoundFinder, dayPeriod, isFreeLicense } from "./sound-finder.js";

const upload = "https://upload.wikimedia.org/wikipedia/commons";
const info = (name: string, duration: number, license: [string, string], extra: Record<string, unknown> = {}) => ({
  url: `${upload}/a/ab/${name}?utm_source=commons.wikimedia.org`, descriptionurl: `https://commons.wikimedia.org/wiki/File:${name}`,
  mediatype: "AUDIO", duration, derivatives: [],
  extmetadata: { LicenseShortName: { value: license[0] }, License: { value: license[1] }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" }, Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Jane">Jane &amp; Co</a>' }, Restrictions: { value: "" } },
  ...extra
});
const pages = [
  { title: "File:Nocturne.mp3", videoinfo: [info("Nocturne.mp3", 300, ["Public domain", "pd"], { extmetadata: { LicenseShortName: { value: "Public domain" }, License: { value: "pd" }, ObjectName: { value: "Nocturne in E-flat" } } })] },
  { title: "File:Soft rock.ogg", videoinfo: [info("Soft_rock.ogg", 200, ["CC BY-SA 4.0", "cc-by-sa-4.0"], { derivatives: [{ src: `${upload}/transcoded/a/ab/Soft_rock.ogg/Soft_rock.ogg.mp3`, type: "audio/mpeg" }] })] },
  { title: "File:Chime.ogg", videoinfo: [info("Chime.ogg", 4, ["CC0", "cc0"])] },
  { title: "File:Band photo.jpg", videoinfo: [{ ...info("Band_photo.jpg", 0, ["CC0", "cc0"]), mediatype: "BITMAP" }] },
  { title: "File:Pop song.ogg", videoinfo: [info("Pop_song.ogg", 180, ["GFDL", "gfdl"])] },
  // A second upload of the same recording.
  { title: "File:Soft rock (remastered).mp3", videoinfo: [info("Soft_rock_(remastered).mp3", 200, ["CC BY 3.0", "cc-by-3.0"])] }
];

function fakeInternet(results: { url: string }[]) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "sdk.nimbleway.com") return Response.json({ results: results.map(item => ({ ...item, title: "", description: "" })) });
    if (url.searchParams.get("list") === "categorymembers") {
      if (url.searchParams.get("cmtitle") === "Category:Audio files") throw new Error("Catch-all categories should be skipped");
      return Response.json({ query: { categorymembers: [{ title: "File:Nocturne.mp3" }, { title: "File:Chime.ogg" }, { title: "File:Band photo.jpg" }] } });
    }
    if (url.searchParams.get("list") === "search") return Response.json({ query: { search: [{ title: "File:Chime.ogg" }, { title: "File:Nocturne.mp3" }] } });
    if (url.searchParams.get("prop") === "videoinfo") {
      // Like the real API, durations come back only when sizes are requested.
      const withSize = url.searchParams.get("viprop")!.split("|").includes("size");
      const found = pages.filter(page => url.searchParams.get("titles")!.split("|").includes(page.title));
      return Response.json({ query: { pages: found.map(page => ({ ...page, videoinfo: page.videoinfo.map(({ duration, ...rest }) => withSize ? { ...rest, duration } : rest) })) } });
    }
    throw new Error(`Unexpected request ${url} ${init?.method}`);
  });
}

let server: Server | undefined;
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });
async function search(finder: ReturnType<typeof createSoundFinder>, body?: unknown) {
  const app = express();
  app.use("/sounds", finder.router);
  server = await new Promise<Server>(resolve => { const instance = app.listen(0, "127.0.0.1", () => resolve(instance)); });
  const port = (server.address() as AddressInfo).port;
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request = httpRequest(`http://127.0.0.1:${port}/sounds/search`, { method: "POST", headers: { Host: "localhost:3001", "X-Nightwatch-Local": "1", "Content-Type": "application/json" } }, response => {
      let text = ""; response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(text) }));
    });
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

describe("finding new sounds", () => {
  it("matches the search to the time of day", () => {
    expect([5, 6, 10, 11, 16, 17, 20, 21, 0].map(hour => dayPeriod(new Date(2026, 8, 28, hour)))).toEqual(["night", "morning", "morning", "afternoon", "afternoon", "evening", "evening", "night", "night"]);
  });

  it("keeps only Commons file and category pages, and only free licenses", () => {
    expect(commonsTitle("https://commons.wikimedia.org/wiki/File:Soft_rock.ogg")).toBe("File:Soft rock.ogg");
    expect(commonsTitle("https://commons.wikimedia.org/wiki/Category:Audio_files_of_reggae")).toBe("Category:Audio files of reggae");
    for (const other of ["https://en.wikipedia.org/wiki/File:Soft_rock.ogg", "https://commons.wikimedia.org/wiki/Main_Page", "http://commons.wikimedia.org/wiki/File:A.ogg", "https://commons.wikimedia.org.evil.example/wiki/File:A.ogg"]) expect(commonsTitle(other)).toBeNull();
    expect([["cc-by-sa-4.0", ""], ["cc0", ""], ["pd", ""], ["", "CC BY 3.0"], ["", "Public domain"]].every(([license, name]) => isFreeLicense(license, name))).toBe(true);
    expect([["gfdl", "GFDL"], ["cc-by-nc-4.0", "CC BY-NC 4.0"], ["", ""]].some(([license, name]) => isFreeLicense(license, name))).toBe(false);
  });

  it("searches Commons through Nimble and returns playable recordings with their attribution", async () => {
    const internet = fakeInternet([
      { url: "https://commons.wikimedia.org/wiki/File:Soft_rock.ogg" },
      { url: "https://commons.wikimedia.org/wiki/Category:Audio_files_of_soft_rock" },
      { url: "https://commons.wikimedia.org/wiki/Category:Audio_files" },
      { url: "https://commons.wikimedia.org/wiki/File:Pop_song.ogg" },
      { url: "https://commons.wikimedia.org/wiki/File:Soft_rock_(remastered).mp3" },
      { url: "https://en.wikipedia.org/wiki/Soft_rock" }
    ]);
    const finder = createSoundFinder(() => "synthetic-nimble-key", internet, () => new Date(2026, 8, 28, 14), () => 0);
    const { status, body } = await search(finder);
    expect(status).toBe(200);
    const nimble = internet.mock.calls.find(([input]) => String(input).includes("sdk.nimbleway.com"))!;
    expect(JSON.parse(String(nimble[1]?.body))).toMatchObject({ query: "soft rock instrumental music audio", include_domains: ["commons.wikimedia.org"] });
    expect(body).toMatchObject({ period: "afternoon", label: "Afternoon · soft rock and reggae" });
    // Nimble's order is kept; the chime is too short, the photo is not audio, GFDL is not on the list and the second upload is a repeat.
    expect(body.sounds.map((sound: { title: string }) => sound.title)).toEqual(["Soft rock", "Nocturne in E-flat"]);
    expect(body.sounds[0]).toMatchObject({ artist: "Jane & Co", license: "CC BY-SA 4.0", duration_seconds: 200, preview_url: `${upload}/transcoded/a/ab/Soft_rock.ogg/Soft_rock.ogg.mp3`, page: "https://commons.wikimedia.org/wiki/File:Soft_rock.ogg" });
    expect(body.sounds[1]).toMatchObject({ license: "Public domain", preview_url: `${upload}/a/ab/Nocturne.mp3` });
    expect(finder.find(body.sounds[1].id)).toEqual({ url: `${upload}/a/ab/Nocturne.mp3`, title: "Nocturne in E-flat" });
    expect(finder.find("made-up")).toBeNull();
    for (const [input, init] of internet.mock.calls.filter(([input]) => String(input).includes("commons.wikimedia.org"))) {
      expect(new Headers(init?.headers).get("user-agent")).toContain("DogMaAI");
      expect(String(input)).not.toContain("synthetic-nimble-key");
    }
  });

  it("falls back to Commons' own search, and says so, when Nimble's pages lead to nothing playable", async () => {
    const internet = fakeInternet([{ url: "https://commons.wikimedia.org/wiki/File:Band_photo.jpg" }, { url: "https://en.wikipedia.org/wiki/Soft_rock" }]);
    const { status, body } = await search(createSoundFinder(() => "synthetic-nimble-key", internet, () => new Date(2026, 8, 28, 22), () => 0));
    expect(status).toBe(200);
    expect(body.period).toBe("night");
    const commonsSearch = internet.mock.calls.map(([input]) => new URL(String(input))).find(url => url.searchParams.get("list") === "search")!;
    expect(commonsSearch.searchParams.get("srsearch")).toBe("slow quiet piano music filetype:audio");
    expect(body.sounds.map((sound: { title: string }) => sound.title)).toEqual(["Nocturne in E-flat"]);
    expect(body.message).toContain("Wikimedia Commons search");
  });

  it("searches for the sound the owner types, and keeps short recordings such as birdsong", async () => {
    const internet = fakeInternet([{ url: "https://commons.wikimedia.org/wiki/File:Chime.ogg" }, { url: "https://commons.wikimedia.org/wiki/File:Soft_rock.ogg" }]);
    pages.push({ title: "File:Robin song.ogg", videoinfo: [info("Robin_song.ogg", 25, ["CC BY-SA 4.0", "cc-by-sa-4.0"])] });
    const finder = createSoundFinder(() => "synthetic-nimble-key", internet, () => new Date(2026, 8, 28, 14), () => 0);
    try {
      const { status, body } = await search(finder, { query: "  bird   chirping " });
      expect(status).toBe(200);
      const nimble = internet.mock.calls.find(([input]) => String(input).includes("sdk.nimbleway.com"))!;
      expect(JSON.parse(String(nimble[1]?.body)).query).toBe("bird chirping audio");
      expect(body.label).toBe("Search · bird chirping");
      // A 4-second chime is still too short; a 25-second recording is kept for a search.
      expect(body.sounds.map((sound: { title: string }) => sound.title)).toEqual(["Soft rock"]);
      const withSong = fakeInternet([{ url: "https://commons.wikimedia.org/wiki/File:Robin_song.ogg" }]);
      expect((await search(createSoundFinder(() => "synthetic-nimble-key", withSong, () => new Date(2026, 8, 28, 14), () => 0), { query: "birdsong" })).body.sounds.map((sound: { title: string }) => sound.title)).toEqual(["Robin song"]);
      // A suggestion for the time of day is music, so the 25-second recording is left out and the Commons search fills in.
      expect((await search(createSoundFinder(() => "synthetic-nimble-key", withSong, () => new Date(2026, 8, 28, 14), () => 0))).body.sounds.map((sound: { title: string }) => sound.title)).toEqual(["Nocturne in E-flat"]);
    } finally { pages.pop(); }
  });

  it("refuses searches that are not a few plain words, without contacting anyone", async () => {
    const internet = fakeInternet([]);
    for (const query of ["<script>", "x", "a".repeat(80), "site:example.com"]) {
      const { status, body } = await search(createSoundFinder(() => "synthetic-nimble-key", internet), { query });
      expect(status).toBe(400);
      expect(body.error).toContain("a few words");
    }
    expect(internet).not.toHaveBeenCalled();
  });

  it("shows only the artist's name, without the address lines or link footnotes Commons adds", () => {
    expect(artistName("<dl><dd>Kevin MacLeod</dd>\n<dd>1 Example Rd</dd>\n<dd>USA</dd></dl>")).toBe("Kevin MacLeod");
    expect(artistName('The Seed <a class="external autonumber" href="https://archive.org">[2]</a><a href="http://example.com">[3]</a>')).toBe("The Seed");
    expect(artistName('<a href="//commons.wikimedia.org/wiki/User:Jane">Jane &amp; Co</a>')).toBe("Jane & Co");
  });

  it("asks for Nimble when no key is set, without contacting anyone", async () => {
    const internet = fakeInternet([]);
    const { status, body } = await search(createSoundFinder(() => null, internet));
    expect(status).toBe(409);
    expect(body.error).toContain("NIMBLE_API_KEY");
    expect(internet).not.toHaveBeenCalled();
  });
});

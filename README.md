# DogMaAI

A home camera companion for dogs left alone. DogMaAI shows your camera live with Liquid AI descriptions of what the dog is doing, plays calming sounds through the camera's own speaker, keeps a diary of the dog's day in Tinybird, turns a week of what the camera saw into **PetAnalytics**, and uses Nimble to find new free-license sounds. A bundled clip of a dog in its kennel drives a stateful activity journal that confirms changes, tracks situations and alerts once.

This is a hackathon demonstration. It is not a veterinary, medical or safety device, and it does not treat separation anxiety.

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open <http://localhost:5443>. The API runs on <http://localhost:3001> and stores local data in `data/nightwatch.sqlite`.

The manager is at <http://localhost:5443/> (also `/manager.html`), with three pages in the sidebar: **Overview**, **Settings** and **PetAnalytics**. Services are set up in `.env` only; the Settings tab shows their status, camera setup and demo assets, and never asks for keys. Liquid AI is found automatically once `npm run vision` is running. See [Manager setup](./MANAGER_SETUP.md) for the supported behavior and remaining integration work.

| Feature | What it does | Needs |
|---|---|---|
| Live view | Shows a Tapo or other RTSP camera, or a paired phone | `CAMERA_RTSP_URL`, or a phone |
| Descriptions | Liquid AI describes what the dog is doing every 12 seconds | `npm run vision` |
| Comfort tools | Calm music and brown noise, on this computer or the camera's speaker, with a Soft / Normal / Loud camera volume | Camera speaker: go2rtc |
| Find new sounds | Nimble searches Wikimedia Commons for free-license sounds you name, such as birdsong, or music that suits the time of day | Nimble key |
| Dog diary | Saves Liquid AI's description whenever the dog's activity or place changes | Tinybird (`npm run tinybird:setup`) |
| Phone, anywhere | Every control from your own phone on any network, through Tailscale's private serve proxy; only this Mac's Tailscale login gets in | Tailscale on the Mac and the phone |
| Listen live | What the sound model hears through the home camera, second by second, and a crying cut-off tuned to the dog from moments you mark as crying or quiet (scores only, never sound) | Sound model (`npm run sound-model:setup`) |
| PetAnalytics | How the dog felt when alone, how long it cried, whether the music helped, and its activity, naps and favourite spots, with tips and ideas linked to ASPCA, AKC and VCA; a labelled sample week until 8 hours are watched | Tinybird (`npm run tinybird:setup`); crying needs the sound model (`npm run sound-model:setup`) |
| Sounds and whimsy | Soft clicks, whooshes and chimes made in the browser, a speaker switch, keycap buttons, flip tiles, wiggling icons and cloud edges, after joshwcomeau.com | Nothing |
| Sample journal | The kennel clip shows confirmed changes, a situation, a one-time alert, a linked recurrence and restart recovery | Nothing |

## Sample footage

`public/demo.mp4` is a [video by Nothing Ahead on Pexels](https://www.pexels.com/video/a-dog-is-in-a-cage-with-its-head-sticking-out-17747645/), listed there as “Cheerful dog inside kennel eagerly waiting for a treat indoors” and free to use under the [Pexels License](https://www.pexels.com/license/). It was converted to 960×540 MP4 at 30 fps without sound, and the app shows it in greyscale. `public/dog-poster.jpg` is a frame from the same clip. Attribution is not required by the license but is kept in the app and here.

The sample observations in `fixtures/mock-observations.json` describe this 32-second clip. To use a different clip, replace the file and review the observations, or connect a real camera.

Optional configuration:

- `DOG_NAME`: your dog's name on PetAnalytics, such as `Simba`; defaults to “your dog”.
- `CAMERA_RTSP_URL`: a Tapo or other RTSP camera on your network, shown live through **Camera → Use home camera**. See [Home Wi-Fi camera](./MANAGER_SETUP.md#home-wi-fi-camera-tapo-and-other-rtsp-cameras).
- `CAMERA_SPEAKER_STREAM`, `GO2RTC_BIN`, `GO2RTC_CONFIG`, `GO2RTC_API_PASSWORD`: play comfort sounds through a Tapo camera's own speaker. See [Camera speaker](./MANAGER_SETUP.md#camera-speaker-tapo-two-way-audio).
- `FFMPEG_PATH`: the ffmpeg used for the camera feed and for decoding found recordings; defaults to `ffmpeg` on `PATH`.
- `PORT`: API port, defaults to `3001`.
- `DATABASE_PATH`: SQLite file location, defaults to `data/nightwatch.sqlite`.
- `NIMBLE_API_KEY` (or `NIMBLE_API`): enables **Find new sounds**, the sound search in Comfort tools, and live, source-linked guidance when a confirmed alert fires.
- `TINYBIRD_TOKEN` and `TINYBIRD_API_URL`: keep the dog diary, the PetAnalytics log and the sample-journal telemetry in Tinybird. `npm run tinybird:setup` deploys the four tables to a workspace used only by DogMaAI and fills these in with a token that can only add to and read them. It also keeps the workspace admin token as `TINYBIRD_ADMIN_TOKEN`, so later runs need no typing; see [TINYBIRD_INTEGRATION.md](./TINYBIRD_INTEGRATION.md).

Keys are read only by the API, and `.env` is ignored by Git. The Nimble flows and their boundaries are documented in [NIMBLE_INTEGRATION.md](./NIMBLE_INTEGRATION.md).

## Demo API

Create a mock session with `POST /api/sessions`, then control it with:

- `POST /api/sessions/:id/start` with an optional JSON body such as `{ "speed": 4 }`
- `POST /api/sessions/:id/pause`
- `POST /api/sessions/:id/reset`
- `POST /api/sessions/:id/restart` to rebuild working state from SQLite
- `POST /api/sessions/:id/occlusion` with `{ "enabled": true }` for the demo override
- `GET /api/sessions/:id/events`
- `GET /api/sessions/:id/stream` for server-sent updates

## Other commands

```bash
npm run typecheck
npm run build
npm test
npm run verify:demo
npm run vision   # Liquid vision model for live camera descriptions; see MANAGER_SETUP.md
```

### Manager

Open `http://localhost:5443/` (or `/manager.html`) for the manager. It includes alert guidance, expandable room context, the dog diary, comfort tools, PetAnalytics, session recovery checks, and **Camera → Connect phone**. See [MANAGER_SETUP.md](MANAGER_SETUP.md) for pairing requirements and limitations.

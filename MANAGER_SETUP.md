# DogMaAI manager

Open **http://localhost:5173/** after `npm run dev`.

The manager is the page at `/`. Its activity lights follow actual fixture observations and engine updates. Clicking an event shows its evidence, a rule-based decision summary and its result. These summaries are not model chain-of-thought.

## What works now

- A continuous camera-style preview: the kennel clip starts automatically in greyscale (live cameras stay in colour), repeats, and updates session events and situation state. The manager has no playback controls. Each sample replay starts a fresh fixture cycle.
- Settings → Connections: the camera, and the status of each service set up in `.env`. No keys are entered in the browser.
- The sidebar has three pages: **Overview**, **Settings** and **PetAnalytics**. Service status lives in Settings → Connections.
- Sounds, after joshwcomeau.com: buttons make soft clicks, whooshes and chimes, generated in the browser with the Web Audio API, so nothing is downloaded, and there are no barks or squeaks that could excite a dog nearby. The speaker switch next to the connection status (in the top bar on a phone) turns them off, and this browser remembers it. Comfort buttons and quick searches are keycaps that press down, and PetAnalytics tiles flip to a second view when tapped. With reduced motion turned on in the system, the wiggles and flips stay still.
- Dog diary: Liquid AI's description of your dog is saved in Tinybird whenever the dog's activity or place changes, and read back under the camera.
- PetAnalytics: how the dog felt when alone, how long it cried, whether the music helped, and its activity, naps and spots over the week, from Tinybird, with tips and ideas to try. See [PetAnalytics](#petanalytics).
- Nimble: with `NIMBLE_API_KEY` in `.env`, Comfort tools can search for sounds (**Birdsong**, **Rain**, anything you type) or suggest music for the time of day, and confirmed sample-session alerts get guidance lookups. Requests may consume account credits.
- Liquid: local endpoint check and live phone or home-camera frame descriptions through the configured multimodal model. No barking or other sound is inferred from still images.
- Home Wi-Fi camera: a Tapo or other RTSP camera on your network replaces the sample footage with a live view. See [Home Wi-Fi camera](#home-wi-fi-camera-tapo-and-other-rtsp-cameras).
- Demo assets: the camera test screen, the sample clip's credit and a local video preview.

The backend persists sample-session observations, events and state in SQLite and supports simulated restart recovery. Live phone or home-camera footage does not run through the sample observations or trigger their alerts; its descriptions feed the dog diary instead.

## The dog diary

1. Set up Tinybird with `npm run tinybird:setup`, as described in [TINYBIRD_INTEGRATION.md](TINYBIRD_INTEGRATION.md), and restart DogMaAI.
2. Connect Liquid AI and your home camera or phone. The **Dog diary** under the camera fills in as your dog's day changes, and its header names where entries are saved.

Each Liquid AI description is followed by a short, text-only request that reads four things from it: whether a dog is visible, what it is doing (resting, moving, playing or eating; a drink of water counts as moving), where (bed, floor, furniture or door), and whether a person is in view. The diary uses the first three. An entry is written only when those change, and only after two readings agree, as in the monitoring rules, so new wording or one misread image never adds an entry. Readings that do not say both what the dog is doing and where are ignored, and do not cancel a change waiting for confirmation. Asking for these fields alongside the image made the small model misread the scene, so the description comes first. Entries are recorded while a manager page is analyzing the camera. With Tinybird set up, the newest saved entry is the starting point after a restart, so an unchanged dog is not logged again; without it, each session starts with the dog's current state.

Entries go to the Tinybird table `dog_diary`, deployed with the schema in `tinybird/datasources/dog_diary.datasource`. The columns are `entry_id`, `observed_at` (UTC), `description`, `dog_visible` (`yes`, `no` or `unknown`), `activity`, `location`, `model` and `camera` (`home` or `phone`). Writes run one at a time. An entry Tinybird did not confirm stays marked **Not saved yet** and is sent again with the next entry or diary refresh (every 30 seconds while the page is open), and reads drop repeated entry IDs. Unsaved entries are lost if DogMaAI restarts first. Without Tinybird, the diary keeps the last 50 entries for the current session only.

## PetAnalytics

The **PetAnalytics** page in the sidebar answers three questions about the last seven days: how the dog felt when alone, how long it cried, and whether the music helped. It also shows how active it was, its naps and its favourite spots. Set `DOG_NAME` in `.env` (for example `DOG_NAME=Simba`) to see the dog's name on it.

1. Set up Tinybird with `npm run tinybird:setup` (see [TINYBIRD_INTEGRATION.md](TINYBIRD_INTEGRATION.md)); it creates the `dog_readings`, `dog_sounds` and `dog_events` tables.
2. Download the sound model once with `npm run sound-model:setup`: Google's YAMNet (TensorFlow.js version, Apache-2.0, 16 MB) is saved to `models/yamnet`, which Git ignores, and each file is checked against a recorded checksum. Settings → Connections shows **Sound recognition** as Ready.
3. Use the home camera with Liquid AI running. Every reading of the picture (whether the dog is visible, what it is doing, where, and whether a person is in view) goes to `dog_readings`, about one every 12 seconds. The same camera connection carries the Tapo's microphone: every second is checked by YAMNet on this computer, and each minute's count of seconds spent crying (a whimper or a howl) or barking goes to `dog_sounds`. The sound itself is never stored or sent anywhere.

Until DogMaAI has watched for eight hours, the page shows a sample week: a **Sample week** banner at the top, and a **Sample** tag on the heading, every figure, chart and tip. **Show {your dog}'s data so far** switches to the real data early. The four tiles at the top flip to a second view when tapped, every chart has a **Table** view and a tooltip on hover or keyboard focus, and if Tinybird cannot be read for a moment the page keeps showing the last data it read and says so.

| Section | How it is worked out |
|---|---|
| How it felt when alone | Each stretch with nobody in view for 15 minutes or more (a break in watching of over 5 minutes ends it) is read from signs the ASPCA lists for separation distress. **Calm**: settled into a rest of 10 minutes or more within 20 minutes, with under a minute of crying and under 10% of the time at the door. **Upset**: 5 minutes of crying or more, not settling within 45 minutes, or 30% of the time at the door. Anything between is **unsettled**. A dog already resting when you leave counts as settled at once, if the rest lasts 10 more minutes. A stretch where the dog was in view for under half the time is shown as **not seen enough** and left out of the counts and the music comparison, unless it cried for 5 minutes or more, which is upset. It is a reading of behaviour, not a diagnosis |
| How long it cried | Seconds of whimpering or howling that YAMNet heard while the dog was alone, per day, with the longest run of crying minutes and barking for the week. A second counts as crying when YAMNet's dog-whimper, howl or whimper score reaches the crying cut-off: 0.20 by default, or the dog's own cut-off once it is tuned (see below). Through the Tapo's 8 kHz microphone a soft whimper often scores low, so the default can miss quiet whining. The Tapo mutes its microphone while DogMaAI plays sound through it, so those minutes are left out rather than counted as quiet |
| Did the music help? | Stretches alone with a comfort sound (starting during the stretch or up to 5 minutes before) are compared with those without, once there are two of each (stretches not seen enough are left out): the middle time to settle (a stretch that never settled counts its whole length) and the minutes of crying per hour heard. Music **helped** if the dog settled 5 minutes sooner or cried 30% less, without the other getting worse. Activity in the 15 minutes before and after each sound is shown too |
| How active | Share of the watched time spent moving or playing, by hour (hours watched under 20 minutes are left blank) and by day, and how the time splits between resting, moving, playing and eating |
| Nap time | Resting for 10 minutes or more without a break of over 90 seconds in watching; naps per day count complete days once there is one |
| Favourite spots | Share of the time on the bed, the floor, sofa and chairs, or by the door |

### Listen live, and tune crying to your dog

Settings → Connections → **Sound recognition** shows what YAMNet hears through the home camera, second by second: the last 30 seconds as crying, barking, other sound or not heard, the three most likely sounds, and the crying score against the cut-off. It works while the home camera is open on Overview, and nothing on it is saved.

To tune the crying cut-off to your dog, press **Crying now** straight away when it whimpers or cries, and **Quiet now** when it is quiet or there are everyday sounds such as talking or the TV. The camera's sound reaches DogMaAI a moment late, so each mark is taken 3 seconds after the press: a crying mark keeps the seconds from 5 before the press to 3 after, and a quiet mark the 10 before. No second is marked twice; a second marked quiet moves over if you then mark crying, and crying presses under 5 seconds apart count as one moment. Stepping out of sight with the laptop is often enough to hear a few whimpers. If Tinybird's sound table is missing, the live view still works while it is open, though minutes are not saved. After 3 crying moments and 30 quiet seconds, DogMaAI suggests the highest cut-off that still catches 4 in 5 of the crying moments, never above the 0.20 default and never below 0.03, and says how many quiet seconds would also count. **Use** applies it to the next seconds heard (minutes already saved keep their counts); **Back to the default** undoes it. Only the scores of marked seconds are kept, in `data/sound-calibration.json` on this computer, which Git ignores (a damaged file is set aside as `sound-calibration.json.damaged`); sound is never kept. PetAnalytics links here from its crying card, and once a cut-off is tuned it says from when, since minutes before then were counted with the default.

Sounds played through the camera speaker are logged by the server, and sounds played on a paired phone by the manager. Sound played on this computer, including previews, is not logged, since the dog may not hear it.

**Pawrent tips** appear only when the data calls for them (for example crying most days, being upset more than once, much time by the door, or music that seemed to help), and each links the ASPCA, AKC or published source it repeats. **Things to try** picks four enrichment ideas from AKC, ASPCA and VCA pages to match the week, and says why only when the week's data supports the reason. Everything is based only on what the camera can see and hear, so it is not a health assessment; ask a vet about any sudden change.

## Nimble: new sounds and alert guidance

1. Open [Nimble](https://online.nimbleway.com), then Settings → API Keys.
2. Set `NIMBLE_API_KEY` in `.env` and restart DogMaAI. Settings → Connections shows Nimble as **Ready**. Household information and video frames are never sent to Nimble.

The sound search in Comfort tools runs only when you use it. Type a sound, such as birdsong or rain, or pick one of the quick searches, and Nimble looks for free-license recordings of it on Wikimedia Commons; searches keep recordings from 10 seconds long. Barking and birdsong can make some dogs more alert rather than calmer, so preview a sound first and watch the camera the first time it plays. **Music for now** instead suggests music that suits the time of day on this computer:

| Time | Search | Why |
|---|---|---|
| 6:00–11:00 | Gentle classical guitar or harp | Classical music led kennelled dogs to rest more ([Kogan et al., 2012](https://www.researchgate.net/publication/257626092_Behavioral_effects_of_auditory_stimulation_on_kenneled_dogs)) |
| 11:00–17:00 | Soft rock or reggae instrumentals | These genres brought the largest calming changes in kennelled dogs, and variety may slow habituation ([Bowman et al., 2017](https://pubmed.ncbi.nlm.nih.gov/28093218/)) |
| 17:00–21:00 | Calm classical piano or strings | As in the morning |
| 21:00–6:00 | Slow, quiet piano or soft ambient music | Quiet for the night |

Nimble mostly returns Commons category pages, such as *Audio files of reggae*; up to three of them, skipping catch-alls such as *Audio files*, are expanded into up to 20 files each. Nimble's web results vary between searches; if none of its pages leads to a playable recording, a Wikimedia Commons search for the same words fills in, and the message says so. The Commons API then checks each result: only audio between one minute and three hours, licensed public domain, CC0, CC BY or CC BY-SA, and without extra restrictions, is shown, with its title, the artist's name, its license and a link to its Commons page for full attribution. Repeat uploads of the same recording are listed once. **Preview** plays on this computer. **Play on camera** sends the camera a private link on this API; the API itself downloads the recording, from `upload.wikimedia.org` only, and ffmpeg decodes it at the level of the built-in sounds, with a 3-second fade-in and a 30-minute limit. A download that sends nothing for 20 seconds ends playback. Only recordings from recent searches can be played, looked up by ID, so a page cannot make the camera play any other address. The search was tried live on 28 September 2026 (a reggae search returned five recordings, with MP3 previews). Playing a found recording through the real camera has not been tried yet; that path is tested with a local recording, real ffmpeg decoding and a simulated go2rtc.

The same key powers the alert guidance workflow, which searches only ASPCA, VCA, AKC and Humane Society pages; without a key, alerts carry saved guidance links. Reference: [official quickstart](https://docs.nimbleway.com/nimble-sdk/getting-started/quickstart).

## Liquid AI

1. Install llama.cpp using [Liquid's instructions](https://docs.liquid.ai/deployment/on-device/llama-cpp).
2. Obtain the [LFM2.5-VL-3B GGUF model](https://huggingface.co/LiquidAI/LFM2.5-VL-3B-GGUF) and matching vision projector, then start them with `npm run vision`.
3. DogMaAI finds the model by itself at `http://localhost:<LIQUID_PORT>/v1`: it checks at start and every 15 seconds, so the order in which you start the two does not matter. Settings → Connections shows Liquid AI as **Ready** with the model's name.

DogMaAI uses only an advertised Liquid vision model: its name must contain both `LFM` (or `Liquid`) and `VL`. Text-only LFM models, such as `LFM2.5-1.2B-Instruct`, are rejected because they cannot read camera images. When a phone or home camera is connected, the manager sends a fresh frame to the local multimodal chat endpoint about every 12 seconds and displays the returned visual description. Sample footage still uses its reviewed fixture observations. No large model download or installation is performed by this manager.

`npm run vision` starts `llama-server` for you with these optional `.env` settings:

| Setting | Default | Purpose |
|---|---|---|
| `LLAMA_SERVER` | `llama-server` on PATH | Path to the llama.cpp server binary |
| `LIQUID_MODEL` / `LIQUID_MMPROJ` | Download `LiquidAI/LFM2.5-VL-3B-GGUF:Q4_K_M` | Local model and vision projector GGUF files; set both or neither |
| `LIQUID_PORT` | `8080` | Port for `npm run vision`; DogMaAI looks for the model at `http://localhost:<port>/v1` by itself |

Ollama 0.12.2 lists LFM2.5-VL with vision capability but fails to load its vision projector ("Failed to load CLIP model"); use llama.cpp. Its GGUF files are byte-identical to Hugging Face's, so `LIQUID_MODEL` and `LIQUID_MMPROJ` can point at the blobs Ollama already downloaded. On Apple silicon with an Intel Homebrew, use the official `llama-*-bin-macos-arm64` release instead of `brew install llama.cpp`.

## Where to get footage

- The bundled clip is a [video by Nothing Ahead on Pexels](https://www.pexels.com/video/a-dog-is-in-a-cage-with-its-head-sticking-out-17747645/) of a dog in its kennel waiting for a treat, free to use under the [Pexels License](https://www.pexels.com/license/), converted to MP4 without sound. Its credit appears on the video and in Demo assets.
- [Pexels](https://www.pexels.com/search/videos/dog%20crate/) and [Wikimedia Commons](https://commons.wikimedia.org/wiki/Category:Videos_of_dogs) have more dog footage. Commons files carry licenses that require attribution, and often share-alike.

Each clip should be watched before assigning events. Stock footage is good for illustrating a scene; a continuous recording of your own dog from a fixed camera is better for a reproducible sequence. New videos must have their own annotations or use real vision inference. Selecting a local video only previews it; it is not silently paired with the bundled clip's annotations.

## Credentials and deployment

Keys live only in `.env` on this computer, where the API reads them; none is typed into or sent to the browser. No browser storage, logs or API responses contain the keys. The API binds to loopback. Manager routes restrict local origins/hosts and require a custom request header. This is a localhost setup, not a deployable multi-user service. Tests use fake responses; real connections need your own keys and local model.

## Phone camera

1. In **Settings → Connections**, open **Camera** and choose **Connect phone**.
2. Scan the QR code, tap **Start camera**, and grant camera access on your phone.
3. Keep the phone browser visible. Return to Overview on the computer to see the live view.
4. Use **Stop camera** on the phone or **Disconnect** in Settings to revoke the session. **Use sample footage** restores the annotated demo.

Requires a built phone page (`npm run build`) and `cloudflared` on PATH, or a configured HTTPS `CAMERA_PUBLIC_ORIGIN` pointing to the dedicated gateway on port 3002. A quick tunnel starts on demand for local testing. Only the camera gateway is exposed; manager and database routes stay local. Camera frames transit Cloudflare; this is an HTTPS relay, not end-to-end WebRTC encryption.

The phone sends sequential JPEG frames at up to roughly 4 fps; slow networks reduce the rate. The microphone is disabled. A separate Enable sound button on the phone unlocks the speaker for manager-initiated comfort actions. Only the latest frame is retained in RAM, with stale frames withheld after 5 seconds and discarded after 10 seconds. A 10-minute, single-use QR secret issues separate upload and viewing capabilities. Sessions last at most 8 hours and can be revoked by either device. Refreshing either page requires pairing again. No recording is implemented. Liquid AI describes selected phone frames when connected, but still images cannot verify barking or other sounds. This is a development pairing flow, not a production camera service.

## Home Wi-Fi camera (Tapo and other RTSP cameras)

1. In the Tapo app, tap the camera on the Home page, then the settings icon at the top right of its live view → Advanced Settings → Camera Account → Understand and Agree to Use. Create a username and password of 6–32 letters and numbers, different from your TP-Link login ([TP-Link guide](https://www.tp-link.com/us/support/faq/2680/)). Tapo opens its RTSP stream (port 554) only once the account exists; no router or port-forwarding change is needed.
2. Note the camera's IP address under Settings → Device Info. A DHCP reservation in your router keeps it from changing.
3. Run `npm run camera:setup -- CAMERA_IP` and enter the Camera Account username and password. The password is hidden while you type and is percent-encoded into `CAMERA_RTSP_URL` in `.env`, using `stream2`, the camera's lower-resolution stream (640×360 or 1280×720, depending on the model; the manager scales it to 640 px). Add `stream1` after the IP for full resolution. You can also edit `.env` directly: `CAMERA_RTSP_URL=rtsp://USERNAME:PASSWORD@CAMERA_IP:554/stream2`, percent-encoding symbols in the username and password (`@` → `%40`, `:` → `%3A`, `/` → `%2F`, `#` → `%23`, `%` → `%25`, space → `%20`).
4. Restart `npm run dev`, then open **Settings → Connections → Camera → Use home camera**.

Other cameras work with their own RTSP address (Reolink, Amcrest, Hikvision, Eufy with RTSP enabled). Battery-powered Tapo models do not offer RTSP. `ffmpeg` must be on PATH, or set `FFMPEG_PATH`. For a test without a camera, set `CAMERA_RTSP_URL` to a local video file such as `public/demo.mp4`; it loops in real time.

The API reads the camera directly with ffmpeg, samples 4 frames per second at up to 640 px wide and keeps only the latest JPEG in memory, with the same 5- and 10-second freshness limits as the phone. No tunnel or relay is used, nothing is recorded, and frames are served only to manager pages that selected **Use home camera**. Several windows can watch at once through one camera connection. The camera is read only while at least one of them requests frames: after 90 seconds without a request, such as when every tab is closed, ffmpeg stops and releases the camera, and it reconnects on the next request. A page that stops requesting frames for 10 minutes, such as on a sleeping laptop, loses its view and reconnects when it wakes. The camera address stays in the server environment; the browser learns only whether one is configured. ffmpeg errors are replaced with fixed messages and logged lines have the username and password removed, but the address is visible to other local users in the process list while ffmpeg runs. A stalled stream restarts within about 20 seconds, and dropouts retry with backoff up to 30 seconds. A rejected login, a missing stream path or an unreadable address is not retried: fix `.env` and restart DogMaAI. A view lasts up to 24 hours. The choice of **Use home camera** is remembered in this browser, so after a page reload or a DogMaAI restart the page reconnects by itself, up to three times in five minutes (after that, select it again). Choosing sample footage, a phone or **Disconnect** forgets it. Liquid AI reconnects by itself too. Without a [camera speaker](#camera-speaker-tapo-two-way-audio), comfort sounds play on this computer.

| Message | Check |
|---|---|
| The camera rejected the login | Camera Account username and password in `.env`, percent-encoded |
| The camera has no stream at that address | The path ends in `/stream1` or `/stream2` |
| The camera refused the connection | The IP address and that the Camera Account exists. If your app has Me → Tapo Lab → Third-Party Compatibility, turn it on |
| This computer cannot reach the camera | The IP address. On macOS, allow the app running DogMaAI (Terminal, VS Code, Claude) under System Settings → Privacy & Security → Local Network; until then, connections fail with "No route to host" |
| The camera did not answer | The camera is on, not in Privacy Mode, and on the same Wi-Fi as this computer. Tapo runs only two of Tapo Care, SD-card recording and third-party streaming at once ([Tapo FAQ](https://www.tapo.com/us/faq/724/)) |

## Camera speaker (Tapo two-way audio)

With a home camera connected, Comfort tools can play through the camera's own speaker, so the sound reaches the room the camera watches. RTSP carries no audio to Tapo cameras; [go2rtc](https://github.com/AlexxIT/go2rtc) speaks Tapo's two-way audio protocol instead.

1. Download `go2rtc_mac_arm64.zip` (or your platform's build) from the [go2rtc releases](https://github.com/AlexxIT/go2rtc/releases) and unzip it, e.g. to `~/go2rtc/go2rtc`.
2. In the Tapo app, turn on **Me → Tapo Lab → Third-Party Compatibility** (in newer versions it may be under **Third-Party Services**). Without it the camera answers `401 Unauthorized`.
3. Run `npm run camera:speaker:setup` and enter the password you use to sign in to the Tapo app; the Tapo protocol does not accept the RTSP Camera Account. The script writes `~/go2rtc/go2rtc.yaml` (owner-only) with only SHA-256 and MD5 hashes of the password, binds go2rtc to `127.0.0.1:1984` behind a random API password, turns off its RTSP and WebRTC servers and prefers a Homebrew ffmpeg, because go2rtc refuses ffmpeg 4.x. It also adds `GO2RTC_CONFIG`, `GO2RTC_API_PASSWORD`, `CAMERA_SPEAKER_STREAM=camera_sha256` and, when found at `~/go2rtc/go2rtc`, `GO2RTC_BIN` to `.env`. For older firmware, set `CAMERA_SPEAKER_STREAM=camera_md5`.
4. Restart DogMaAI.

**Camera volume** in Comfort tools sets how loud the camera plays: **Loud** (the default) lifts quieter passages by about 5 dB and rounds the peaks off smoothly so the small speaker does not clip, **Normal** is the original level, and **Soft** is quieter. A change applies to the sound already playing, and this browser remembers the choice. Watch the dog the first time you try Loud.

DogMaAI starts go2rtc when the first sound is played, with its output discarded and no `.env` secrets in its environment, because go2rtc logs the camera address with the password hash. Without its API password, go2rtc would accept commands from any web page open in a browser on this computer, including sources that run programs; do not remove the `username`, `password` and `local_auth` lines. Each sound gets a private link on this API, `/api/camera-sound/…`, valid until the sound ends or stops, which go2rtc's ffmpeg reads as a live stream, converts to the camera's 8 kHz telephone audio and plays. Sound keeps playing after the page closes, until **Stop** or a restart of DogMaAI; Comfort tools show what is playing on the camera. go2rtc replies repeat the camera address with the hash, so they are never shown or logged. The hashes open the camera like a password: keep `go2rtc.yaml` private, do not open go2rtc's web page at `http://127.0.0.1:1984`, and do not add streams there, because go2rtc writes them into that file. Talk-back mutes the camera's microphone while sound plays.

| Problem in DogMaAI | Check |
|---|---|
| The camera speaker did not start | The camera is online; Third-Party Compatibility is on in the Tapo app; the setup used the Tapo app password; `CAMERA_SPEAKER_STREAM` names `camera_sha256`, or `camera_md5` for older firmware |
| go2rtc did not start | `GO2RTC_BIN`, `GO2RTC_CONFIG` and `GO2RTC_API_PASSWORD` in `.env`; `ffmpeg: bin:` in `go2rtc.yaml` points at ffmpeg 5 or newer (set `GO2RTC_FFMPEG` and re-run the setup to change it) |

## Use DogMaAI from your phone, anywhere (Tailscale)

DogMaAI keeps running on this Mac, which reads the camera on the home Wi-Fi and runs the AI models. Tailscale makes a private network between your own devices, so your phone can open DogMaAI from any network, with every control, including comfort sounds through the camera.

1. Install Tailscale on this Mac and on your phone, and sign in to the same Tailscale account on both.
2. With DogMaAI running, give it a private HTTPS address on your tailnet (once; Tailscale remembers it):
   `tailscale serve --bg --https=5443 http://localhost:5173`
3. On your phone, open `https://<this Mac's name>.<your tailnet>.ts.net:5443`. `tailscale serve status` prints the exact address.

Who gets in: someone on this Mac, or **the Tailscale login this Mac is signed in with**, on their own devices. Both the web server and the API check every request: a request that came through Tailscale's serve proxy must carry that login, at this Mac's private name on port 5443, and DogMaAI's controls also need the DogMaAI page's own origin. Tailscale sets the login itself (it deletes any login a device sends, and adds none for tagged machines), so other people, shared and tagged machines are refused, and a request that came through Tailscale is never taken for this Mac. DogMaAI reads the login from `tailscale status`; set `TAILSCALE_CLI` in `.env` if the `tailscale` command is not on DogMaAI's PATH, and `DOGMAAI_TAILNET_PORT` if you serve it on another port. Do not turn on Funnel for this port: Funnel publishes to the public internet. To stop sharing, run `tailscale serve --https=5443 off`.

| On the phone you see | Why | What to do |
|---|---|---|
| "DogMaAI opens on this Mac, or on your own devices through Tailscale" | Tailscale is off or signed out on the Mac, or the phone is signed in to another account | Sign both in to the same account; DogMaAI rechecks within 5 minutes, or restart it |
| The page does not load at all | The Mac is asleep, offline, or DogMaAI is not running | Keep the Mac awake and DogMaAI running |

Pages watching the home camera together (this Mac and a phone, say) share readings: a page is given another page's Liquid AI reading from the last 10 seconds instead of taking its own, so PetAnalytics does not count the same moment twice, while a page on its own still takes one every 12 seconds. Connecting a *phone as the camera* still makes a temporary public Cloudflare link for that phone, as before.

## Integrated backend demo

Confirmed sample alerts appear in Activity with expandable messages and source links; saved sources are labeled separately. **Room context** reveals current confirmed state without adding a permanent dashboard panel. **Settings → Demo assets → Session checks** exposes blocked-view and saved-state recovery controls. The manager resumes sample playback after restoring state so fresh observations can reconfirm it. These notifications are in-app only.

## Comfort tools and camera test

On Overview, open **Comfort tools** in Activity and choose **Calm music**, **Brown noise** or **Stop**. These are manually triggered actions. They play through the camera itself when a [camera speaker](#camera-speaker-tapo-two-way-audio) is set up, on a paired phone after you tap **Enable sound for comfort tools** there, and otherwise on this computer. Each runs until **Stop**. No microphone capture, barking classifier or automatic trigger is included. **Find new sounds** adds free-license recordings found by [Nimble](#nimble-new-sounds-and-alert-guidance).

| Sound | What plays | Why |
|---|---|---|
| **Calm music** | Generated music at 56 beats per minute: a melody between G3 and A4 over soft held chords from F2, notes held 2–3 beats with soft onsets, mostly stepping down, composed afresh as it plays | Recorded classical music led kennelled dogs to sleep more and bark less ([Kogan et al., 2012](https://www.researchgate.net/publication/257626092_Behavioral_effects_of_auditory_stimulation_on_kenneled_dogs)), and Mozart helped dogs separated from their owners lie down sooner, although the overall effect was modest ([Queen's University Belfast, 2022](https://pure.qub.ac.uk/en/publications/the-effect-of-auditory-stimulation-on-pet-dogs-reactions-to-owner/)). Dogs have habituated to classical music within days, and varying the music may reduce this ([Bowman et al., 2017](https://pubmed.ncbi.nlm.nih.gov/28093218/)). This generated music follows those findings but has not itself been tested |
| **Brown noise** | Low, steady noise that fades in over 3 seconds | May soften doorbells, footsteps and barking outside. Masking noise has not been studied in dogs, and at this soft level it will not cover loud sounds |

There is no voice option. Audiobooks calmed shelter dogs ([Brayley & Montrose, 2016](https://www.sciencedirect.com/science/article/abs/pii/S0168159115003123)), but during owner separation a voice drew dogs' attention to the speaker without calming them (Queen's University Belfast, 2022). Both sounds are levelled to a similar soft loudness. Sound may help a dog settle but does not treat separation anxiety; gradual alone-time training, and a vet or certified behaviourist for persistent distress, address the cause.

Without a camera speaker, leave the DogMaAI tab open on a computer near your dog to play sound while you are out, with its lid open and sleep prevented; a sleeping computer stops the sound. A paired phone must stay unlocked with its page visible. If the pairing ends or the camera stops, the phone stops the sound too.

Open **Settings → Demo assets → Test your phone camera → Open camera test screen**, or go directly to `/test-screen.html`. Click **Play full screen**, aim the phone’s rear camera at the computer screen, and watch the feed and optional Liquid description in Overview. The kennel clip loops, with its credit below it. The phone page must remain visible.

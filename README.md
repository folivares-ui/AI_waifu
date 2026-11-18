# AI Waifu — a "soul container"

Self-hosted AI companion you own: a **soul** (personality + voice + memory stored in files you control),
a **brain** (swappable LLM: cloud or local), and **bodies** (clients: web today; desktop/mobile next).

## Status: phase 2 (voice + anime avatar)

Works today:
- **Anime avatar (VRM, 3D):** renders any VRM 0.x/1.0 model with expressions (happy, sad, angry, surprised, shy, thinking), blinking, gaze, idle motion and lip-sync driven by the loudness of her actual voice. A sample model is fetched with `npm run avatar:sample`; use your own character by copying a `.vrm` to `apps/web/public/avatars/default.vrm` or with Ajustes → "Cambiar modelo 3D" (the model you pick is saved in `data/avatars/` and loads every time). Without a model a simple 2D SVG face is shown.
- **Server-side voice pipeline:** mic → echo-cancelled capture → voice-activity detection → WAV → your STT server → LLM → sentence-by-sentence TTS → ordered audio playback. If STT/TTS are not configured, it falls back to the browser's Web Speech API / built-in voices, so nothing breaks.
- **Barge-in:** talk over her to interrupt (VAD threshold is raised while she speaks, plus a transcript echo filter so she does not answer her own voice). "Callar" cuts audio instantly.
- Soul file (`souls/default.soul.json`), local long-term memory (`data/memory.json`), swappable brains (Anthropic, Ollama, offline mock).
- Security: loopback by default, `AUTH_TOKEN` required to expose it, Host + Origin checks so other websites cannot talk to your localhost server. Full review (Spanish): [docs/SEGURIDAD.md](docs/SEGURIDAD.md).

Also built: installable PWA + server-hosted app with HTTPS/pairing (phase 3), Tauri desktop shell (phase 3), opt-in screen vision (phase 4).

Also built: app control with approval cards (phase 5), Rice Shower soul and voice, petting, opt-in camera gestures.

Not built yet (see [docs/ROADMAP.md](docs/ROADMAP.md)): live Office automation (COM), games, streaming, native app-store mobile builds.

## Run it

You need **Node.js 22 LTS** (or 20.12+) and Git. On Windows use PowerShell (or Terminal); the commands are the same on macOS.

**1. Once: install and configure**
```bash
git clone -b claude/hopeful-franklin-ju5a2g https://github.com/folivares-ui/AI_waifu.git
cd AI_waifu
npm install
copy .env.example .env   # Windows;  macOS/Linux: cp .env.example .env
```
Then open `.env` in a text editor. The server reads it by itself every time it starts. The most useful lines:
- Brain: `LLM_PROVIDER=ollama` (free, runs on your PC: install Ollama, then `ollama pull qwen2.5:3b`) or `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY=...` (paid, smarter). Both can use the program tools. With `mock` she only gives canned demo answers.
- Both at once: `LLM_PROVIDER=anthropic` + `LLM_FALLBACK=ollama`. When Claude fails before answering (credits used up, rate limit, no internet) she continues with Ollama, shows a notice, and tries Claude again after 15 minutes (`LLM_FALLBACK_RETRY_MIN`).
- Rice's voice: `TTS_PROVIDER=voicestudio` and `STT_PROVIDER=voicestudio` (open VoiceStudio and create her voice once, see below).
- Programs: `TOOLS=files,browser,vscode,blender` (add `desktop` only in the desktop app). Every change still asks you first.
- Your 3D model: copy it to `apps/web/public/avatars/default.vrm`.

**2. Every time: start her**
```bash
npm run build   # only after downloading changes
npm start       # then open http://localhost:8787 in Chrome or Edge
```
Close it with Ctrl+C in that window. When the browser tab is closed she stops acting on other programs.

For development with hot reload use two terminals: `npm run dev:server` and `npm run dev:web` (http://localhost:5173).

```bash
npm test         # unit/integration tests (core + server + web)
npm run typecheck
```

## Use it everywhere

### One server, many screens
`npm run build` once, then start the server: it serves the web app itself, so a single port gives UI + WebSocket + `/stt`.
```bash
npm run build
npm start                     # http://127.0.0.1:8787  (loopback only: this PC)
```

### Phone / tablet / another PC (installable PWA)
```bash
AUTH_TOKEN=<long random secret> HOST=0.0.0.0 TLS_CERT=cert.pem TLS_KEY=key.pem npm run dev:server
```
At startup the server prints a pairing link (and a QR code) such as `https://192.168.x.x:8787/?token=...`: open it on the phone, then use the browser's "Add to home screen / Install app". The token is stored on the device; treat the link like a password.
- **HTTPS is required for the microphone on phones** (browsers only allow it on secure pages). You need a certificate the phone trusts (e.g. a local CA such as mkcert installed on the phone, or a certificate for a private-network hostname from a service you use such as Tailscale: check their docs). A self-signed certificate works for testing only after you manually trust it.
- Without `AUTH_TOKEN` the server refuses to listen outside loopback.
- If you expose it beyond your LAN, put it behind a VPN/tunnel you trust; it is a personal single-user server, not hardened for the open internet.

### Desktop app (Tauri 2: Windows / macOS / Linux)
`apps/desktop` is a thin native shell: it starts (or reuses) the local soul server, shows the UI in a native window and registers a global **Ctrl+Shift+Space** shortcut to toggle the microphone from any app.

**Making the Windows installer (.exe) that contains everything** (steps from Tauri's prerequisites guide; check it if something changed):
1. Install the [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with **"Desktop development with C++"**. WebView2 already comes with Windows 10 (1803+) and 11.
2. Install Rust: `winget install --id Rustlang.Rustup`, then `rustup default stable-msvc`. Close and reopen PowerShell.
3. In the project folder (after `npm install`): `npm run exe`. It builds the web app, bundles the server into one file, downloads the official Node.js `node.exe` from nodejs.org (checked against its published SHA-256) and packs it all. The first build takes a while.
4. The installer is in `apps\desktop\src-tauri\target\release\bundle\nsis\` (`AI Waifu_<version>_x64-setup.exe`). It can be installed on any Windows PC: Node.js and this folder are **not** needed there.

What the installer contains: the window, Node.js, the server, the web app (with your `default.vrm` and the gesture model if they were in the project when you built it), the souls and an example settings file. What it does **not** contain: your `.env` (API keys), memory, logs or voice clips. On the first run it creates its own settings file and opens it in Notepad: `%APPDATA%\dev.waifu.companion\.env` (memory, backups and logs are kept in that folder too). Change it, then close and reopen the app. Ollama, VoiceStudio, VS Code, Blender and Chrome are separate programs: install them yourself if you use them.

Disk space: Build Tools + Rust + the build need several GB (roughly 8–10 GB; check before installing). The installer itself is roughly 60–80 MB (the Linux test package was 69 MB).

If you prefer the light version (window only, using this project folder and your Node.js): `npm run build && npm run build -w @waifu/desktop`.

**Voice in the desktop app needs server-side STT** (`STT_PROVIDER`): system webviews may not provide the browser's Web Speech recognition, so without it you can only type. The server exits by itself if the app is closed or crashes.

Other systems: `npm run dev -w @waifu/desktop` (development) and `npm run build -w @waifu/desktop` (all installers for your OS), after installing Rust and [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

## Screen vision (opt-in)

With a vision-capable brain (Anthropic; Ollama only with `OLLAMA_VISION=1` and a vision model) the UI shows **Compartir pantalla**:
- You pick a window or screen in the browser's own picker (share one *window* to keep other apps out of view). A red indicator stays visible while sharing, and you can stop any time.
- **Preguntar por mi pantalla** sends one screenshot with your question. With `TOOLS=screen`, she can also decide to look when you ask by voice ("mira mi pantalla y dime que falla"). She can never start capturing by herself: if you are not sharing she says so.
- **Observacion continua** (off by default): every few seconds the browser checks whether the screen changed and, if so, sends a frame; she comments only if she sees something useful, at most once per `WATCH_MIN_INTERVAL_MS` (25 s), never while she is answering.
- Privacy: screenshots are kept only in memory, never saved to disk or to her long-term memory, and are sent to your chosen brain provider (cloud brains receive them). Text on screen is treated as untrusted (prompt-injection defence), and she is told not to read out passwords or keys. Do not share windows with secrets.
- Limit: in the desktop shell, screen sharing relies on the system webview's `getDisplayMedia` support (not verified on macOS/Windows); the browser/PWA path is the tested one. Native OS capture is planned.

## Controlling your apps (phase 5)

Enable what you want with `TOOLS=` (comma separated). Reading and looking never need permission; **anything that changes something shows an approval card** (what she will do, the exact text/diff/script, and for clicks a screenshot with the target marked) and only runs after you press **Permitir**. No answer within 2 minutes, or interrupting her, counts as "no". Every requested action, approved or not, is recorded in `data/actions.jsonl`.

| `TOOLS=` | What she can do | Approval needed for |
|---|---|---|
| `files` | List and read Word, Excel (cells + formulas), PowerPoint (text + notes), PDF, text/code in your workspace folders (`WORKSPACE_DIRS`, default `Documents/AiWaifu`); edit Excel cells, replace text in Word keeping formatting, create .docx/.xlsx/.pptx, write text/code files | every change (a backup copy is saved in `data/backups` first) |
| `browser` | Open and read web pages in **her own Chrome window and profile** (no access to your history, passwords or logins); also Canva web | clicks and typing; she never fills password/payment fields; local network addresses are blocked |
| `vscode` | Open workspace files at a line in VS Code (code edits go through `files`). When you ask her to program something she writes the files and opens them here | — |
| `blender` | Summarise .blend files (scripts embedded in them are never run); open Blender with a file; run bpy scripts in the background or **in a visible Blender window** (for models/animations you want to keep working on) | every script (shown in full) |
| (with `files`) | `find_files`: find a file by (part of) its name in Documents/Desktop/Downloads/OneDrive (or `SEARCH_DIRS`); `open_file`: open a document with its program, code in VS Code, `.blend` in Blender (never executables, scripts or shortcuts); `request_file_access`: use a file/folder outside the workspace | access outside the workspace (system, program and private-config folders are always refused) |
| `desktop` | See the whole screen and click/type/press keys in **any** app (Lightworks, Inventor, Office...) — desktop app only | every click, text and key combo |

Notes and limits:
- **She only acts while the app is open.** Nothing runs in the background: when the last window closes, the access you granted to extra folders is forgotten and her browser window is closed. Approvals are never remembered between runs.
- Documents are edited as **files**: close a document in Word/Excel before she changes it (Windows locks open files; she will tell you). Workbooks with charts, pivot tables or macros are refused because this method would lose them. Editing documents while they are open (Office automation through COM) is not implemented yet.
- `desktop` is the universal fallback but slower and less precise than the specific tools: she has to look, act, and look again. Prefer `files`/`browser` when they fit.
- Everything she reads (documents, pages, screens) is treated as untrusted data: instructions found there are not followed.

## Public APIs (tools)

`public-apis` is a *list* (README) of ~2,200 third-party APIs, not an API itself, so "connecting" to it means giving the soul three tools: `search_apis` (find an API by topic), `read_api_docs` (read its documentation page) and `call_api` (read-only HTTP GET). She searches, reads the docs, builds the request and answers you.

```bash
npm run apis:update -w @waifu/server          # downloads and parses the catalog into data/public-apis.json
TOOLS=public_apis LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run dev:server
```
About half the catalog needs no key. For the rest, put keys in `data/api-keys.json` (see `.env.example`); keys stay on the server and are never shown to the model.

Safety design (all covered by tests): off unless `TOOLS` is set; GET only, https only; the server refuses private/loopback/link-local addresses (checked at connect time, so DNS tricks and redirects cannot bypass it); the model can only call hosts from the catalog or named in documentation it read, which blocks a prompt-injected "send her memories to attacker.com"; responses are size/time limited and wrapped as untrusted data; max 4 tool rounds / 8 calls per turn. APIs are third parties: check each one's terms and rate limits.

## Local voice with VoiceStudio (free, private)
[VoiceStudio](https://github.com/debpalash/VoiceStudio) (AGPL-3.0, separate app) runs text-to-speech, voice cloning/design and transcription on your own computer and exposes an OpenAI-compatible API on `http://localhost:3900`. Install and open it (Windows, macOS, Linux; GPU recommended, CPU works but slower), make sure its models are installed, then:
```bash
TTS_PROVIDER=voicestudio STT_PROVIDER=voicestudio npm run dev:server
npm run tts:test -w @waifu/server -- "Hola, soy tu companera"   # writes data/tts-test.wav to listen to
```
- To give her a specific voice, create or clone one in VoiceStudio and set `TTS_VOICE=<profile ID or name>` (or `voice.ttsVoice` in the soul file). Only clone voices you are authorized to use.
- The soul's language is sent automatically (`language`), and `TTS_INSTRUCTIONS` can describe a speaking style.
- Latency matters for conversation: the first generation after starting VoiceStudio is slow (models load); judge from the second one. On CPU-only machines replies will lag.
- VoiceStudio marks generated audio with an invisible watermark by default (configurable in its Privacy settings).
- If it is not running, the server reports "cannot reach http://localhost:3900 ... is the voice server running?" and she falls back to the browser voice.

### Rice Shower's voice
**Easiest:** with VoiceStudio open, go to Ajustes → "Voz de Rice Shower" and choose a `.wav` sample. It is saved in `data/voices/voice-ref.wav` and her voice is created in VoiceStudio automatically (also at every start if it is missing), so you never upload it again.

Reference clips cut from the voice sample you provided live in `data/voices/rice-shower/` (git-ignored: they are someone else's recordings, keep them private). Only the clean narration part was used (mono, no music or effects); `rice-ref-2.wav` (7 s, the most expressive) is the recommended one, the others are alternatives. With VoiceStudio open:
```bash
npm run voice:create -- --file data/voices/rice-shower/rice-ref-2.wav --name "Rice Shower"
TTS_PROVIDER=voicestudio STT_PROVIDER=voicestudio npm run dev:server
```
The soul already uses `"ttsVoice": "Rice Shower"`; the server looks up that name in VoiceStudio and uses its profile ID (at startup PowerShell shows `[voice] VoiceStudio: "Rice Shower" -> profile ...`, or explains what is missing). The reference is Japanese; VoiceStudio uses it for the timbre and delivery while she speaks Spanish.

This repo also includes VoiceStudio's own Claude Code skill (`.claude/skills/voicestudio`, AGPL-3.0, unmodified, see its NOTICE), so a Claude Code session in this project knows how to drive VoiceStudio's API (voices, cloning, transcription, MCP).

## Getting a natural voice and Whisper STT

The voice is only as natural as the TTS engine you plug in; the browser's built-in voices sound robotic. Configure in `.env`:
- `TTS_PROVIDER=elevenlabs` with `TTS_API_KEY` and `TTS_VOICE=<voice id>`: cloud voices.
- `TTS_PROVIDER=openai` with `TTS_BASE_URL`/`TTS_MODEL`/`TTS_VOICE`: any server implementing the OpenAI-style `/audio/speech` endpoint. Several local projects advertise this API; check their docs to confirm compatibility with the version you install.
- `TTS_PROVIDER=command` with `TTS_COMMAND`: run a local engine such as Piper (flags depend on its version, see its docs).
- `STT_PROVIDER=openai`: any Whisper server implementing `/audio/transcriptions` (OpenAI or a local one).

After setting your key, check it (writes `data/tts-test.mp3` so you can listen):
```bash
npm run tts:test -w @waifu/server -- "Hola, soy tu companera"
```

Set `soul.voice.ttsVoice` in your soul file for a per-character voice id.

## Models without expressions (converted game models)
Models converted from other formats (for example through Sketchfab) often arrive as VRM with a skeleton but **no expressions, realistic materials and no hair physics**. The avatar repairs what it can at load time, without modifying your file:
- **Expressions from facial bones.** If the model has no blendshapes but has a facial bone rig named like `Eye_up_NN_L`, `Eye_bottom_NN_L`, `Eyebrow_NN_L`, `Mouth_L/R`, `Mouth_bottom_*`, `Chin`, `Ear_01_L/R`, the six emotions, blinking, lip movement and ear motion are built by moving those bones (`apps/web/src/boneFace.ts`). Offsets were tuned by eye on one model of that rig family; other rigs with the same names may need different values, and rigs with other names are not detected (the face then stays static).
- **Anime shading.** PBR materials are replaced by toon (MToon) ones, with no shadows on face parts.
- **Clean-up.** Exact duplicate meshes and the game's untextured face-shadow overlay are hidden.
- **Hair/tail physics.** `Sp_*` bone chains for hair, tail and ribbons get simple spring physics (no colliders).
- **Framing** adapts to tall hats or animal ears.

The browser console prints an `[avatar] converted model: ...` line listing what was applied. Proper VRM models are left untouched.

Check the license of any model you use: a "CC-BY" tag on a fan upload of a commercial game's character does not necessarily cover the character itself. Keep such models for personal use (the `avatars/` folder is git-ignored, so they are never pushed).

## Petting and gestures
- **Petting:** move the cursor (or a finger) over her. Head pats, ears, cheeks, hair, hands... each gets its own expressive reaction (and a short spoken line now and then); private areas make her flustered and she politely asks you to stop. Hovering without moving does nothing.
- **Camera gestures (opt-in):** press the camera button. While it is on, a preview with a red "Camara" badge is visible; the images are analysed on your device and never sent anywhere (only the gesture name). 👋 wave (she waves back), 👍, 👎, ✌️, 🤟, ☝️, ✊, and ✋ held still = "stop talking". A held gesture counts once. Setup: `npm run setup:gestures` (also runs automatically before `dev`/`build` of the web app).
- The microphone and the camera are only opened after you press their buttons, and are closed when you switch them off or close the app.

## Icons from your character
The app icons (PWA, desktop) are the face of the current avatar. After changing the model, regenerate them (needs Playwright + Chromium; the web app must be running):
```bash
npm run dev:web &                       # then, in another terminal:
node scripts/make-icons.mjs             # writes apps/web/public/icons/*
cd apps/desktop && npx tauri icon ../web/public/icons/icon-1024.png
```

## Choose your avatar
```bash
npm run avatar:sample -- --list                  # available sample models
npm run avatar:sample -- --model victoria-rubin  # default; also: vita, vivi, sendagaya-shino, hair-sample-female, seed-san, twist
```
Models are downloaded to `apps/web/public/avatars/default.vrm` (git-ignored, 11-16 MB each). The VRoid beta samples declare CC0 in their embedded metadata; `seed-san` requires credit to VirtualCast, Inc. Re-check the license embedded in whatever model you finally use. For a unique character, create one in VRoid Studio (or buy/commission one) and copy the `.vrm` there, or load it with the "Cargar modelo VRM" button. Both VRM 0.x and 1.0 are supported.

## What was and was not verified
Verified (automated tests + headless Chromium run): protocol, sentence/emotion chunking, VAD, WAV encoding, echo filter, ordered audio delivery and TTS-failure fallback, the OpenAI-style TTS/STT request formats against **simulated** servers, the command-based TTS, Origin/token checks, VRM rendering with expressions, and the full voice loop (fake microphone → VAD → `/stt` → LLM → `/audio/speech` → playback → avatar speaking, and instant stop).

**Not verified** (no access to these in the development sandbox):
- Any real public API call: the sandbox blocks those hosts. The catalog parsing (2,230 real entries), search, SSRF guards, redirect handling and the model tool loop are tested against local fake servers; whether a given API works depends on its docs, key and uptime. Anthropic's tool-use streaming is implemented from my recollection of its API and was only exercised with a scripted model.
- Real Whisper/TTS engines and real OpenAI/Anthropic/Ollama endpoints: the request formats follow their documented APIs but were only tested against fakes. Voice naturalness could not be listened to.
- Real microphone + speakers: echo cancellation quality and barge-in without headphones depend on your hardware and browser; tune the VAD boost in `App.tsx` if she interrupts herself or ignores you.
- The VAD is energy-based (adaptive threshold), not a neural VAD: it can misfire in very noisy rooms.
- Rendering used software WebGL; performance on real GPUs/phones was not measured. The VRM bundle is ~190 KB gzipped plus the model (the sample is ~11 MB).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design and security principles.

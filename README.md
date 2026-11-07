# AI Waifu — a "soul container"

Self-hosted AI companion you own: a **soul** (personality + voice + memory stored in files you control),
a **brain** (swappable LLM: cloud or local), and **bodies** (clients: web today; desktop/mobile next).

## Status: phase 2 (voice + anime avatar)

Works today:
- **Anime avatar (VRM, 3D):** renders any VRM 0.x/1.0 model with expressions (happy, sad, angry, surprised, shy, thinking), blinking, gaze, idle motion and lip-sync driven by the loudness of her actual voice. A sample model is fetched with `npm run avatar:sample`; use your own character by copying a `.vrm` to `apps/web/public/avatars/default.vrm` or with the "Cargar modelo VRM" button. Without a model a simple 2D SVG face is shown.
- **Server-side voice pipeline:** mic → echo-cancelled capture → voice-activity detection → WAV → your STT server → LLM → sentence-by-sentence TTS → ordered audio playback. If STT/TTS are not configured, it falls back to the browser's Web Speech API / built-in voices, so nothing breaks.
- **Barge-in:** talk over her to interrupt (VAD threshold is raised while she speaks, plus a transcript echo filter so she does not answer her own voice). "Callar" cuts audio instantly.
- Soul file (`souls/default.soul.json`), local long-term memory (`data/memory.json`), swappable brains (Anthropic, Ollama, offline mock).
- Security: loopback by default, `AUTH_TOKEN` required to expose it, and an Origin allowlist so other websites cannot talk to your localhost server.

Also built: installable PWA + server-hosted app with HTTPS/pairing (phase 3), Tauri desktop shell (phase 3), opt-in screen vision (phase 4).

Not built yet (see [docs/ROADMAP.md](docs/ROADMAP.md)): desktop/app control (Word, Excel, Blender...), games, streaming, standalone installers that bundle the server, native app-store mobile builds.

## Run it

```bash
npm install
cp .env.example .env   # optional; without a key the offline mock brain is used
npm run dev:server     # http://127.0.0.1:8787/health
npm run dev:web        # http://localhost:5173  (Chrome or Edge for voice)
```

For a real brain, export the variables from `.env` before `dev:server` (e.g. `ANTHROPIC_API_KEY=... LLM_PROVIDER=anthropic npm run dev:server`),
or `LLM_PROVIDER=ollama OLLAMA_MODEL=<model you pulled>` for fully local.

```bash
npm test         # unit/integration tests (core + server)
npm run typecheck
```

## Use it everywhere

### One server, many screens
`npm run build` once, then start the server: it serves the web app itself, so a single port gives UI + WebSocket + `/stt`.
```bash
npm run build
npm run dev:server            # http://127.0.0.1:8787  (loopback only: this PC)
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
```bash
npm run build                      # builds core + server check + web
npm run dev -w @waifu/desktop      # needs Rust (https://rustup.rs) and your OS's Tauri prerequisites
npm run build -w @waifu/desktop    # produces an installer for your OS
```
**Voice in the desktop app needs server-side STT** (`STT_PROVIDER`): system webviews (e.g. WebKitGTK, tested) do not provide the browser's Web Speech recognition, so without it you can only type. The server exits by itself if the app is closed or crashes. It looks for the project folder (set `WAIFU_ROOT` if needed) and runs `node --import tsx` on the server, so **Node.js and this repository must stay installed** next to the app: bundling the server into a standalone installer is not done yet. Configure everything through `.env`/environment as before.

## Screen vision (opt-in)

With a vision-capable brain (Anthropic; Ollama only with `OLLAMA_VISION=1` and a vision model) the UI shows **Compartir pantalla**:
- You pick a window or screen in the browser's own picker (share one *window* to keep other apps out of view). A red indicator stays visible while sharing, and you can stop any time.
- **Preguntar por mi pantalla** sends one screenshot with your question. With `TOOLS=screen`, she can also decide to look when you ask by voice ("mira mi pantalla y dime que falla"). She can never start capturing by herself: if you are not sharing she says so.
- **Observacion continua** (off by default): every few seconds the browser checks whether the screen changed and, if so, sends a frame; she comments only if she sees something useful, at most once per `WATCH_MIN_INTERVAL_MS` (25 s), never while she is answering.
- Privacy: screenshots are kept only in memory, never saved to disk or to her long-term memory, and are sent to your chosen brain provider (cloud brains receive them). Text on screen is treated as untrusted (prompt-injection defence), and she is told not to read out passwords or keys. Do not share windows with secrets.
- Limit: in the desktop shell, screen sharing relies on the system webview's `getDisplayMedia` support (not verified on macOS/Windows); the browser/PWA path is the tested one. Native OS capture is planned.

## Public APIs (tools)

`public-apis` is a *list* (README) of ~2,200 third-party APIs, not an API itself, so "connecting" to it means giving the soul three tools: `search_apis` (find an API by topic), `read_api_docs` (read its documentation page) and `call_api` (read-only HTTP GET). She searches, reads the docs, builds the request and answers you.

```bash
npm run apis:update -w @waifu/server          # downloads and parses the catalog into data/public-apis.json
TOOLS=public_apis LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run dev:server
```
About half the catalog needs no key. For the rest, put keys in `data/api-keys.json` (see `.env.example`); keys stay on the server and are never shown to the model.

Safety design (all covered by tests): off unless `TOOLS` is set; GET only, https only; the server refuses private/loopback/link-local addresses (checked at connect time, so DNS tricks and redirects cannot bypass it); the model can only call hosts from the catalog or named in documentation it read, which blocks a prompt-injected "send her memories to attacker.com"; responses are size/time limited and wrapped as untrusted data; max 4 tool rounds / 8 calls per turn. APIs are third parties: check each one's terms and rate limits.

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

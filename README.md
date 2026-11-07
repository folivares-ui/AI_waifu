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

Not built yet (see [docs/ROADMAP.md](docs/ROADMAP.md)): screen vision, desktop/app control, games, streaming, desktop (Tauri) and mobile packaging.

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

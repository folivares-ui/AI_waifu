# AI Waifu — a "soul container"

Self-hosted AI companion you own: a **soul** (personality + voice + memory stored in files you control),
a **brain** (swappable LLM: cloud or local), and **bodies** (clients: web today; desktop/mobile next).

## Status: MVP (phase 1)

Works today:
- Real-time voice conversation in the browser (speech-to-text → LLM → text-to-speech), sentence-level streaming so she starts talking before the full answer is generated.
- Barge-in: interrupt her by talking (with headphones) or with the "Callar" button.
- Expressive 2D avatar (emotions + lip movement). The `Avatar` component is the contract a Live2D/VRM renderer will replace.
- Soul file (`souls/default.soul.json`) and long-term memory (`data/memory.json`, local, keyword recall).
- Swappable brains: Anthropic API, Ollama (local), or an offline mock.

Not built yet (see [docs/ROADMAP.md](docs/ROADMAP.md)): screen vision, desktop/app control, game playing, streaming, desktop (Tauri) and mobile packaging, Live2D/VRM avatar, server-side STT/TTS (Whisper, ElevenLabs, local TTS).

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

## Known limitations of the MVP
- Voice uses the browser's Web Speech API: Chrome/Edge only for recognition, and in Chrome the audio is processed by Google's cloud service. For privacy/quality it should move to server-side Whisper + a TTS engine (phase 2).
- Without headphones the mic can hear her own voice, so barge-in is disabled in that mode.
- The Anthropic and Ollama providers are implemented against their documented streaming APIs but were **not** exercised against the live services in development (no key/model available); only the mock brain, the WebSocket pipeline and the UI were run end to end.
- Browser microphone/TTS behaviour was not tested in a real audio environment.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design and security principles.

# Roadmap

Each phase is shippable on its own. Items marked (?) need a decision or verification of the current official docs before building.

## Phase 1 — Voice companion (DONE, this repo)
Voice chat, avatar, soul file, memory, swappable LLM.

## Phase 2 — Better senses and voice (DONE except where noted)
- [x] Server-side STT/TTS behind provider interfaces (OpenAI-style endpoints, local command). Verified against fakes only.
- [x] VAD + echo-aware barge-in (energy VAD; a neural Silero VAD is a possible upgrade).
- [x] VRM anime avatar with expressions and audio-driven lip-sync.
- [ ] Phoneme-accurate visemes (currently loudness-driven mouth shapes).
- [ ] Streaming TTS (play audio before the sentence finishes synthesizing) for lower latency.
- [ ] Memory v2: embeddings, summarisation of old conversations, forgetting/editing UI.
- [ ] Persist a user-loaded VRM across reloads (currently only `public/avatars/default.vrm` persists).

## Phase 2.5 — Public APIs (DONE, see README)
- [x] Catalog + read-only tools with SSRF/injection protections. [ ] Tool support for Ollama. [ ] Per-API usage hints/curated adapters for the most useful ones. [ ] Confirmation step before APIs that would need writes (none today: GET only).

## Phase 3 — Desktop app + remote access (DONE, with caveats)
- [x] Server serves the web app; HTTPS option, token auth, pairing link/QR; installable PWA (manifest, icons, offline shell).
- [x] Tauri 2 desktop shell: starts/reuses the server, native window, global push-to-talk shortcut, server never orphaned. Compiled and run on Linux (WebKitGTK); Windows/macOS builds not tried.
- [ ] Standalone installers that bundle Node + the server (today the repo and Node must be present).
- [ ] Native iOS/Android wrappers (Tauri mobile or Capacitor); today phones use the PWA.
- [ ] Transparent always-on-top "desktop pet" window mode.

## Phase 4 — Seeing the screen (DONE, browser path)
- [x] Opt-in sharing via getDisplayMedia, visible indicator, attach-to-question, `look_at_screen` tool, continuous observation with change detection + rate limit; screenshots never stored.
- [ ] Native OS capture in the desktop shell (system webviews may lack getDisplayMedia), with a monitor/window chooser.
- [ ] Redaction of sensitive regions before sending; per-app allowlist.

## Phase 5 — Acting on your computer
A tool layer with per-app adapters, all behind the security principles in ARCHITECTURE.md:
- Generic fallback: screenshot + mouse/keyboard ("computer use"). Slow and fragile; best for apps without an API.
- Microsoft Word/Excel/PowerPoint: COM automation on Windows, AppleScript/JXA on macOS (?), or editing the files directly with libraries.
- VS Code: an extension exposing editor/terminal actions. Blender: Python (`bpy`) add-on. Autodesk Inventor: its COM API (Windows). Canva: its official API/connector.
- PDF reader: read via PDF libraries; editing via a PDF library rather than driving the UI.
- Chrome: dedicated profile + DevTools protocol/extension. No history access, by design.
- **Needs clarification:** "Lingo", "Arena Simulator", Lightworks — I'm not certain which exact products/versions you mean or what automation interfaces they offer. Tell me which ones and I'll check before promising support.

## Phase 6 — Games and streaming
- Games: observe via screen capture, act via virtual input; start with turn-based/simple games, since LLM latency is too high for action games without a fast reflex layer.
- Streaming: drive OBS through its WebSocket remote-control API (?), read chat from the streaming platform's API (?), moderation filter before anything is spoken. Respect each platform's rules on AI-generated content.

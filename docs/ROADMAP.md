# Roadmap

Each phase is shippable on its own. Items marked (?) need a decision or verification of the current official docs before building.

## Phase 1 — Voice companion (DONE, this repo)
Voice chat, avatar, soul file, memory, swappable LLM.

## Phase 2 — Better senses and voice (DONE except where noted)
- [x] Server-side STT/TTS behind provider interfaces (OpenAI-style endpoints, local command). Verified against fakes only.
- [x] VAD + echo-aware barge-in (energy VAD; a neural Silero VAD is a possible upgrade).
- [x] VRM anime avatar with expressions and audio-driven lip-sync.
- [x] Bone-driven expressions, toon conversion and hair springs for converted models without blendshapes (one rig family).
- [ ] Phoneme-accurate visemes (currently loudness-driven mouth shapes).
- [ ] Streaming TTS (play audio before the sentence finishes synthesizing) for lower latency.
- [ ] Memory v2: embeddings, summarisation of old conversations, forgetting/editing UI.
- [x] A VRM chosen in the settings is saved and loads every time; the voice sample is saved and recreates her VoiceStudio voice when missing.

## Phase 2.5 — Public APIs (DONE, see README)
- [x] Catalog + read-only tools with SSRF/injection protections. [x] Tool support for Ollama (native tool calling; tested against a fake server only). [ ] Per-API usage hints/curated adapters for the most useful ones. [ ] Confirmation step before APIs that would need writes (none today: GET only).

## Phase 3 — Desktop app + remote access (DONE, with caveats)
- [x] Server serves the web app; HTTPS option, token auth, pairing link/QR; installable PWA (manifest, icons, offline shell).
- [x] Tauri 2 desktop shell: starts/reuses the server, native window, global push-to-talk shortcut, server never orphaned. Compiled and run on Linux (WebKitGTK); Windows/macOS builds not tried.
- [x] Standalone installer that bundles Node + the server + the web app (Windows NSIS; user data in the app data folder). Built and run on Linux only.
- [ ] Native iOS/Android wrappers (Tauri mobile or Capacitor); today phones use the PWA.
- [ ] Transparent always-on-top "desktop pet" window mode.

## Phase 4 — Seeing the screen (DONE, browser path)
- [x] Opt-in sharing via getDisplayMedia, visible indicator, attach-to-question, `look_at_screen` tool, continuous observation with change detection + rate limit; screenshots never stored.
- [ ] Native OS capture in the desktop shell (system webviews may lack getDisplayMedia), with a monitor/window chooser.
- [ ] Redaction of sensitive regions before sending; per-app allowlist.

## Phase 5 — Acting on your computer (DONE, first version)
- [x] Approval cards for every action + action log; read-only work needs no approval.
- [x] Documents as files: Word, Excel, PowerPoint, PDF, text/code (workspace sandbox, backups).
- [x] Chrome in a separate profile (Canva web included).
- [x] VS Code (open at line) and Blender (inspect, open, run scripts in the background or in a visible window).
- [x] Find files by name, open them with the right program, approved access outside the workspace; nothing acts once the app is closed.
- [x] Character interaction: cursor petting by body region, opt-in camera hand gestures (on-device MediaPipe).
- [x] General screen control from the desktop app (screenshot + mouse/keyboard), tested on Linux/X11.
- [ ] Live Office automation on Windows (COM) for documents that are open, and charts/pivots.
- [ ] Autodesk Inventor API (COM, Windows), Lightworks: currently only through general screen control.
- [ ] Verify the desktop control on Windows (DPI scaling, multi-monitor) — only tested on Linux.

## Phase 6 — Games and streaming
- Games: observe via screen capture, act via virtual input; start with turn-based/simple games, since LLM latency is too high for action games without a fast reflex layer.
- Streaming: drive OBS through its WebSocket remote-control API (?), read chat from the streaming platform's API (?), moderation filter before anything is spoken. Respect each platform's rules on AI-generated content.

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

## Phase 3 — Desktop app + remote access
- Tauri shell (Windows/macOS) around the web client; global hotkey / push-to-talk; tray; runs the server as a sidecar (?).
- Phone/tablet: installable PWA against the same server (secured with token + HTTPS), optional native wrapper later.

## Phase 4 — Seeing the screen
- Screen capture tool (user-selected window or monitor, visible indicator when active) → a vision-capable model. Suggestions/"review my work" mode. Opt-in per session.

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

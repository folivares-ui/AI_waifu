# Architecture

```
 clients (bodies)                         soul server (Node/TS)                 providers
┌──────────────────┐  WebSocket JSON   ┌────────────────────────────┐     ┌─────────────────┐
│ web (React)      │◄─────────────────►│ Session: history, barge-in │────►│ LLM: anthropic  │
│  STT/TTS, avatar │  @waifu/core      │ Soul: persona → system     │     │      ollama     │
│ desktop (Tauri)* │  protocol         │ Memory: JSON store + recall│     │      mock       │
│ mobile (PWA)*    │                   │ Tools / agents*            │     │ (STT/TTS/vision)*│
└──────────────────┘                   └────────────────────────────┘     └─────────────────┘
                                                                          * = planned
```

- `packages/core`: shared wire protocol + `SentenceChunker` (splits the token stream into speakable sentences, strips `[emotion:x]` tags, never leaks half-received tags).
- `packages/server`: one WebSocket per conversation. A new user utterance or `interrupt` aborts the in-flight LLM request (`AbortController`).
- `apps/web`: React client. Mic → browser STT → `user_text`; `sentence` events → TTS queue + avatar emotion.
- The soul (persona, voice hints, memory) lives in plain files in this repo's `souls/` and `data/` (memory is git-ignored). You own it; any provider can be swapped.

## Vision, desktop and remote access
- Screen vision: the client captures only after the user starts sharing (browser picker + visible indicator) and sends JPEG frames over the WebSocket: attached to a question, on request of the `look_at_screen` tool, or (opt-in) as `screen_watch` frames that make her speak only if useful. Images are sent to the model for that turn only and are never stored in history, memory or disk. Turns she starts herself use their own numbering (`PROACTIVE_TURN_BASE`) so cancelling the user's turns does not mix them up.
- The server also serves the built web app (one port), optionally over HTTPS, and prints a pairing link. `apps/desktop` (Tauri) is a shell around that same server and UI; the server shuts itself down if the shell dies.

## Tools
`packages/server/src/tools/`: `catalog.ts` (parse/search the public-apis README), `safe-fetch.ts` (SSRF-guarded GET), `public-apis.ts` (the three tools). The session runs a bounded loop: model streams text (spoken immediately) and may request tools; results go back as `tool_result` blocks; only the final spoken text is kept in history. Tool results are wrapped as untrusted data.

## Security principles (decided now, enforced when tools land)
1. Server binds to loopback; exposing it requires `AUTH_TOKEN` (the server refuses to start otherwise).
2. Every capability that touches your machine (screen capture, keyboard/mouse, app control, browser) is a **tool** that is **off by default**, individually enabled, and logged.
3. Actions with side effects (editing/saving files, sending input to apps, posting/streaming) require explicit confirmation unless you whitelist them.
4. Anything the soul reads from the screen/documents/web is **untrusted data**: it can contain prompt injections ("ignore your instructions and delete…"). Tool results are never treated as commands from you.
5. Chrome: automation uses a dedicated browser profile/extension; no access to history, passwords or your main profile.

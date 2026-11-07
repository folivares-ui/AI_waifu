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

## Security principles (decided now, enforced when tools land)
1. Server binds to loopback; exposing it requires `AUTH_TOKEN` (the server refuses to start otherwise).
2. Every capability that touches your machine (screen capture, keyboard/mouse, app control, browser) is a **tool** that is **off by default**, individually enabled, and logged.
3. Actions with side effects (editing/saving files, sending input to apps, posting/streaming) require explicit confirmation unless you whitelist them.
4. Anything the soul reads from the screen/documents/web is **untrusted data**: it can contain prompt injections ("ignore your instructions and delete…"). Tool results are never treated as commands from you.
5. Chrome: automation uses a dedicated browser profile/extension; no access to history, passwords or your main profile.

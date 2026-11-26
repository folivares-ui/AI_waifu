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
| `desktop` | See the whole screen and click/type/press keys in **any** app (Lightworks, Inventor, Office...) — desktop app only | every click, text and key combo (or **Darle el control**, below) |

Notes and limits:
- **She only acts while the app is open.** Nothing runs in the background: when the last window closes, the access you granted to extra folders is forgotten and her browser window is closed. Approvals are never remembered between runs.
- Documents are edited as **files**: close a document in Word/Excel before she changes it (Windows locks open files; she will tell you). Workbooks with charts, pivot tables or macros are refused because this method would lose them. Editing documents while they are open (Office automation through COM) is not implemented yet.
- **Darle el control** (like handing over control in a video call): her first click/text/key card has a button *Darle el control hasta que termine*. From then on her clicks, typing and keys run without asking until the activity you asked for in the chat is over (her answer ends, you interrupt her or start something else). An orange banner shows while she has it; **Quitar el control** in it, or **Ctrl+Shift+X** from any program (desktop app), takes it back. Shortcuts that delete, close, send or open system tools (Delete, Alt+F4, Ctrl+W, Ctrl+Enter, Win+R/X, Ctrl+Shift+Esc) and every other kind of change (files, documents, browser, programs) still ask each time. Everything she does is in the action log, marked "(con el control)". Clicks themselves cannot be judged: under control she could press a button that deletes something, so give it only for tasks you are watching.
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
**You do not need to open VoiceStudio yourself:** when it is the voice engine, Rice opens it at start (and closes it when she closes) and her first sentences wait until it is ready. If it is not found, set `VOICESTUDIO_PATH` in `.env`.

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

## Characters (Rice Shower, Agnes Tachyon, yours)
Ajustes → **Personaje**: switch between characters in every open window. Each one keeps **her own** 3D model, voice sample (and VoiceStudio voice) and memory; switching restarts the conversation. Rice Shower, Agnes Tachyon, Rebecca, Midnight, Caulifla, Nicole Demara, Ai Hoshino, Ronova, Castorice and Yangyang come with the app (`souls/*.soul.json`); **+ Nuevo personaje** creates one from a short form (name, personality, how she calls you, other names, Japanese voice). After choosing a character, load her `.vrm` and `.wav` in the same settings. Characters you created can be deleted (with their files); the shipped ones cannot. Files: `data/characters/<id>/` (Rice keeps `data/avatars`, `data/voices` and `data/memory.json`), your souls in `souls/` of the user folder.

## Personality growth
Characters are not static: each has a few traits with a level from 0 to 100 (Rice: confidence and closeness; Agnes: interest in others, self-care and closeness; your own characters: confidence and closeness) that change **slowly** with how you treat her. After each answer the brain judges the exchange: encouragement, trust, patience and kind company raise a trait; insults or coldness lower it; ordinary small talk and plain orders ("be more confident") change nothing. At most ±2 per exchange and ±6 per trait per day, so growth takes many conversations. Her instructions say who she is *now* (e.g. a more confident Rice hesitates and apologises less, also in her Japanese voice), and a notice appears when she passes a milestone. Ajustes → "Como ha cambiado" shows the levels, where she started and the latest reasons, and can start over. Saved per character (`data/growth.json` for Rice, `data/characters/<id>/growth.json`); define traits in a soul file with `"growth": [{ "id", "name", "start", "low", "high", "up", "down" }]`. It costs one extra short request to the brain per answer.

## Models converted from other formats
- **No humanoid bones:** some converted `.vrm` files (e.g. from Sketchfab exports) have an empty humanoid bone list, so no VRM viewer can load them. When you load one in Ajustes, the server recognises the bones by their names (hips, spine, arms, legs, fingers, eyes) and fills the list in; models saved earlier are repaired the first time they are shown. If the bones cannot be recognised, the app says which ones are missing. When the names say nothing (e.g. written in another alphabet and garbled by the converter), the bones are recognised from the skeleton's shape: the lowest joints are the feet, the joints furthest to each side the hands, the two longest downward segments thigh and shin, the elbow where upper arm and forearm are about equally long, the eyes a mirrored pair of single bones on the head. Models that come far too small or too big (a lost scale step: a 20 cm model, e.g. Nicole's) are resized to about 1.6 m. Bones named by body part ("leg left thigh", "arm right elbow", "arm left finger 2b", "spine lower", "head neck upper", e.g. Ronova's model) are recognised too, and so are rigs named "Root_M", "Spine1_M", "Hip_L", "Knee_L", "Scapula_L", "Shoulder_L", "Elbow_L", "Wrist_L", "IndexFinger1_L" (e.g. Castorice's model), whose face bones "eyeup/eyedn/eyeconner …", "eyebrow Inn/Mid/Out" and "lipconner" are animated (with no jaw bone, the lower lip bones open the mouth), and whose "Hair…/Skirt…/…Ribbon_NN_JNT" chains get spring physics. Faces rigged with descriptive names ("head eyelid upper left 1..3", "head eyebrow left 1..3", "head mouth corner left", "head jaw") are animated, including lid bones that all start at the eye's centre and turn about it. Chains named "hair …" or "Clothes Skirt/Veil/Tail/…" get spring physics with the body (torso, arms, legs) as obstacles; a baked "AO_Shadow" layer is hidden. Models with **no skeleton at all** (a statue, e.g. Ai Hoshino's, converted from an `.obj`) are rigged automatically (`packages/server/src/autorig.ts`): the joints are placed from the shape of the mesh (feet, legs below the hem, the arms as what sticks out sideways, shoulders/neck/head from the arms' height, eyes from the face's eye openings) and each piece of the mesh is skinned to its bones (hair and face follow the head, a skirt the hips, arms and legs blend at the joints). It also finds the fingers (four side by side plus the thumb, three joints each) and gives long hair chains of bones around the head, which the app swings with spring physics, with the head, chest, hips and arms as obstacles. It needs the model standing, facing +z, in a T- or A-pose; it is approximate. A model whose skeleton clearly does not fit its body (as some online auto-riggers leave it: the head joint down at the chest, the eyes far above it or an elbow far behind the shoulder, e.g. the "rigged" Yangyang file) has that skeleton taken off, keeping the shape the mesh was modelled in, and is rigged again the same way. Arms with wide sleeves or long hair beside them are found by the middle of the arm, and a big head turns from just below the chin.
- **Faces without expressions:** besides the game rig of Rice and Agnes, faces named "LT/LU eyelid A..D", "L/R browskin A..E", "LT/LU lip", "jaw A" (e.g. Midnight's model) and "F_L_EyelidTop", "F_L_EyeBrows1..3", "F_L_MouthCorners", "F_C_Jaw" (e.g. Caulifla's model) are animated too; their movements are computed from the model's own geometry (a blink brings each upper-lid bone down to the lower lid below it). Faces with "Facial_Elbow_A/B/C_01_L" (eyebrows), "Facial_Mouth_A_01_L/M/R" and "Facial_Cheek" bones but no eyelid or jaw bones (e.g. Rebecca's model) get those two built from the mesh when the model loads (`apps/web/src/synthFace.ts`): the eye openings and the mouth slit are found in the face mesh, and the eyelids and the lower jaw are added as morph targets (the lid slides over the eyeball and stays in front of it). Fingers of every model with finger bones curl with her mood (relaxed, fists when angry, open when happy or waving) and drift a little. Faces with no face bones at all (e.g. Nicole's model, whose expressions were blendshapes lost in the conversion) get eyelids, jaw, eyebrows (their own pieces above the eyes) and mouth shapes (corners) built the same way. Tuned on those two models; if a face looks wrong, the rest of the avatar is not affected.
- **Converted materials:** parts that are fully transparent in the file (effects the game drives itself) are hidden instead of showing as white or black patches, and a character can be drawn darker with `"look": { "brightness": 0.78 }` in her soul file (only Nicole has it: her pale model burned out to pure white under the ambient light). When a face's own eyebrows are separate meshes (e.g. Nicole's, hidden under the fringe without the game's shader), they keep their shape but are drawn over the hair, and move with the emotions (angry: inner end down and drawn together; sad: inner end up; surprised: up, arching).
- **Parts of the model:** Ajustes → "Partes del modelo" lists each part (hair, clothes, mask, a weapon...) with a checkbox. Parts that look like weapons are hidden by default; your choice is saved per character.

## Japanese voice with Spanish subtitles
Rice speaks **Japanese** (like in the anime) while her words are shown in **Spanish**; you keep talking to her in Spanish. Each sentence is translated in character (she calls herself 「ライス」 and you 「お兄さま」) by the same brain just before it is spoken, so it costs one extra short request per sentence and adds a little delay. Switch it in Ajustes → "Hablar en japones" (remembered on that device), with `SPEECH_LANG` in `.env`, or with `speechLang`/`speechStyle` in the soul file.
- Browser voice: needs a Japanese voice. Edge and Chrome usually include one (online natural voices); on Windows you can add one in Configuración → Hora e idioma → Voz → Agregar voces → Japonés. The app tells you if none is found.
- VoiceStudio: the sentence is synthesized in Japanese with her cloned voice (whose reference clip is Japanese).
- Her words appear in an anime-style dialog box (name tab, Spanish typed out as she speaks, the Japanese she says in small text below). The full conversation is in the history button at the top.
- She never falls back to speaking Spanish: a translation that is not Japanese is retried once, and if it still fails that line is only shown.
- Speech recognition stays Spanish. Use headphones if the microphone picks up her Japanese voice.

## Body language
Arms and legs are no longer fixed: she breathes and sways a little, shifts her weight from one leg to the other every few seconds, and gestures with her hands on the beat of her voice while she talks. Each mood has its own pose: open arms when happy, close to the body when sad, hands on the hips when angry, hands to the chest when surprised, a hand at the chin when thinking, hands together when shy. The poses that need the hands in a precise place are solved for each model when it loads (its own proportions), so they fit tall and short characters alike, VRM 0.x and 1.0.

Each character can have her own **motion style** in her soul file: `"motion": { "energy": 1.7, "tempo": 1.35, "bounce": 0.6, "fidget": 0.75 }` (Rebecca's). `energy` scales sways and gestures, `tempo` their speed, `bounce` keeps her rocking on her knees even when idle, and `fidget` adds small spontaneous moves every few seconds (a hand on the hip, a shrug, a torso twist, shaking out her arms, popping a hip). Without it a character moves calmly (Rice). `armRelax` (0..1) lets the elbows hang a little bent with the forearms swinging loosely, and `hipSway` (0..1, default 1) sets how much the hips sway and turn: low for a character in a long skirt or coat, which hangs from the hips and would swing around her legs (Yangyang: 0.25); her upper body still turns. Whatever the hips do, the thighs turn back by as much, so the feet stay planted.

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

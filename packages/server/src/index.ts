import "./env.js"; // must stay first: loads .env before other modules read process.env
import { isLoopbackHost, makeAuthorizer } from "./auth.js";
import { privacyProblems, privateMode } from "./privacy.js";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { basename, resolve } from "node:path";
import qrcode from "qrcode-terminal";
import { WebSocketServer } from "ws";
import type { Capabilities, ClientMessage } from "@waifu/core";
import { ActionLog } from "./actionLog.js";
import { createLLM } from "./llm/index.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import { sttHint } from "./soul.js";
import { Characters, DEFAULT_ID, type NewCharacter } from "./characters.js";
import { createStaticHandler } from "./static.js";
import { browserForShutdown, createToolFactory, onAllClientsGone } from "./tools/index.js";
import { createSTT } from "./stt/index.js";
import { createTTS, VoiceStudioTTS } from "./tts/index.js";
import { closeLaunched, ensureVoiceStudio, findVoiceStudio } from "./tts/launcher.js";
import { isGlb, isWav, MAX_AVATAR_BYTES, MAX_VOICE_BYTES, removeIfExists, saveAtomic } from "./personal.js";

import { appPath, userPath } from "./paths.js";
const port = Number(process.env.PORT ?? 8787);
// Loopback only by default. To use from phone/another PC set HOST=0.0.0.0 AND AUTH_TOKEN.
const host = process.env.HOST ?? "127.0.0.1";
// PRIVACY=local: refuse to start with anything that would send your data outside this computer.
const privacy = privacyProblems();
if (privacy.length) {
  console.error(`\n[!] PRIVACY=local, pero la configuracion enviaria datos fuera de este equipo:\n${privacy.map((p) => `    - ${p}`).join("\n")}\n    Corrige el .env (o quita PRIVACY=local) y vuelve a arrancar.\n`);
  process.exit(1);
}
const token = process.env.AUTH_TOKEN;
if (host !== "127.0.0.1" && host !== "localhost" && !token) {
  throw new Error("Refusing to listen on a non-loopback address without AUTH_TOKEN set.");
}
// Browsers allowed to talk to us when no token is set. Without this check any website you visit
// could open a WebSocket to localhost and chat with (and read the memories of) your companion.
const allowedOrigins = new Set([
  ...(process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(",").map((s) => s.trim()).filter(Boolean),
  // The server's own origin, so the app it serves (same origin) can talk to it.
  ...["http", "https"].flatMap((p) => [`${p}://localhost:${port}`, `${p}://127.0.0.1:${port}`]),
]);

// Characters (Rice Shower, Agnes Tachyon, yours...): each with her own 3D model, voice and memory.
const characters = new Characters(
  appPath("souls"),
  userPath("souls"),
  userPath("data"),
  basename(process.env.SOUL_FILE ?? "default.soul.json").replace(/\.soul\.json$/, ""),
  process.env.MEMORY_FILE ? resolve(process.env.MEMORY_FILE) : undefined,
);
/** Changes who she is in every open window (each character keeps her own memory, model and voice). */
function switchCharacter(id: string) {
  if (!characters.exists(id)) throw new Error(`No existe el personaje "${id}".`);
  characters.setActive(id);
  if (id === active.id) return;
  active = loadCharacter(id);
  for (const s of sessions) s.setCharacter(active.soul, active.memory);
  console.log(`[characters] now: ${active.soul.name}`);
  // Her VoiceStudio voice is created from her saved sample if needed.
  if (tts instanceof VoiceStudioTTS) void ensureVoice(id).then((m) => console.log(`[voice] ${m}`), (e) => console.warn(`[voice] ${e instanceof Error ? e.message : e}`));
}
const loadCharacter = (id: string) => ({ id, soul: characters.load(id), memory: new MemoryStore(characters.paths(id).memory) });
let active = loadCharacter(characters.activeId());
/** Every open window's conversation, so a character change reaches all of them. */
const sessions = new Set<Session>();
// Open windows, so everyone sees when she changes brain.
const sockets = new Set<import("ws").WebSocket>();
const notify = (message: string) => {
  for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "notice", message }));
};
const brainName = (n: string) => ({ anthropic: "Claude", ollama: "Ollama", mock: "el cerebro de prueba" })[n] ?? n;
const llm = createLLM(process.env, (s) => {
  const [from, target] = [brainName(s.from), brainName(s.target)];
  const message =
    s.to === "fallback"
      ? `${from} no responde (${s.reason}). ${active.soul.name} sigue con ${target} en este equipo.`
      : `${active.soul.name} vuelve a usar ${target}.`;
  console.log(`[brain] ${message}`);
  notify(message);
});
const tts = createTTS();
const stt = createSTT();
const voiceNameOf = (id: string) => characters.load(id).voice.ttsVoice ?? process.env.TTS_VOICE ?? "default";
/** Creates a character's voice in VoiceStudio from her saved sample if it is not there yet (no need to upload it again). */
async function ensureVoice(id = active.id, sample = characters.voiceSample(id)): Promise<string> {
  const voiceName = voiceNameOf(id);
  if (!(tts instanceof VoiceStudioTTS)) return "VoiceStudio no esta configurado (TTS_PROVIDER=voicestudio)";
  if (!sample || voiceName === "default") return `no hay muestra de voz guardada para ${characters.load(id).name}`;
  const r = await tts.ensureProfile(voiceName, readFileSync(sample));
  if (r.status === "unreachable") return "VoiceStudio no esta abierto: la voz se creara la proxima vez que arranques con VoiceStudio abierto";
  return r.status === "created" ? `voz "${voiceName}" creada en VoiceStudio` : `VoiceStudio ya tiene la voz "${voiceName}"`;
}
// VoiceStudio makes her cloned voice. If it is not running, Rice opens it herself (and closes it when she closes).
const usesVoiceStudio = tts instanceof VoiceStudioTTS || stt?.name === "voicestudio";
const voiceStudioRoot = (process.env.TTS_BASE_URL ?? process.env.STT_BASE_URL ?? "http://localhost:3900/v1").replace(/\/+$/, "").replace(/\/v1$/, "");
let launchedVoiceStudio: import("node:child_process").ChildProcess | undefined;
const voiceStudioReady: Promise<void> =
  usesVoiceStudio && process.env.VOICESTUDIO_AUTOSTART !== "0"
    ? ensureVoiceStudio(voiceStudioRoot, { exe: findVoiceStudio(), log: (m) => console.log(`[voice] ${m}`) }).then((r) => {
        if (r.status === "started") {
          launchedVoiceStudio = r.child;
          console.log("[voice] VoiceStudio was closed: the app opened it and it is ready");
        } else if (r.status === "timeout") {
          launchedVoiceStudio = r.child;
          console.warn("[voice] VoiceStudio was opened but did not answer within 2 minutes (is it still loading?)");
        } else if (r.status === "not-found") {
          console.warn("[voice] VoiceStudio is not open and was not found. Open it, or set VOICESTUDIO_PATH in .env so the app can open it itself.");
        }
      })
    : Promise.resolve();
if (tts instanceof VoiceStudioTTS) tts.starting = voiceStudioReady.finally(() => (tts.starting = undefined));
process.on("exit", () => {
  if (process.env.VOICESTUDIO_AUTOCLOSE !== "0") closeLaunched(launchedVoiceStudio);
});
if (tts instanceof VoiceStudioTTS) {
  voiceStudioReady
    .then(() => ensureVoice())
    .then((m) => console.log(`[voice] ${m}`))
    .then(() => tts.resolveVoice(voiceNameOf(active.id)))
    .then((id) => console.log(`[voice] VoiceStudio: "${voiceNameOf(active.id)}" -> ${id === voiceNameOf(active.id) ? "sent as given (could not list its voices: is VoiceStudio open?)" : `profile ${id}`}`))
    .catch((e) => console.warn(`[voice] ${e instanceof Error ? e.message : e}`));
}
const makeTools = createToolFactory();
const caps: Capabilities = { tts: !!tts, stt: !!stt, vision: !!llm.vision, ...(privateMode() ? { privateMode: true } : {}) };
const actionLog = new ActionLog(process.env.ACTIONS_LOG ?? userPath("data/actions.jsonl"));
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

const authorized = makeAuthorizer({ token, allowedOrigins });
function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (origin && (token || allowedOrigins.has(origin))) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const webDir = process.env.WEB_DIR ?? appPath("apps/web/dist");
const serveWeb = process.env.SERVE_WEB !== "0" && existsSync(resolve(webDir, "index.html"));
// The avatar model is a personal asset: when a token is set, it needs the token like the API does.
const serveStatic = serveWeb ? createStaticHandler(webDir, (p) => p.startsWith("/avatars/"), authorized) : undefined;

const tlsCert = process.env.TLS_CERT;
const tlsKey = process.env.TLS_KEY;
const secure = !!(tlsCert && tlsKey);
const handler = async (req: IncomingMessage, res: ServerResponse) => {
  // This-PC-only mode: refuse every request (page, API, files) that does not name this computer as its host.
  if (!token && !isLoopbackHost(req.headers.host)) return json(res, 403, { error: "forbidden host" });
  cors(req, res);
  const path = new URL(req.url ?? "", "http://x").pathname;
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  const isApi = path === "/health" || path === "/stt" || path === "/avatar" || path === "/voice" || path === "/characters" || path.startsWith("/characters/");
  if (isApi && !authorized(req)) return json(res, 403, { error: "forbidden" });

  if (path === "/health") return json(res, 200, { ok: true, soul: active.soul.name, character: active.id, llm: llm.name, tts: tts?.name ?? null, stt: stt?.name ?? null, memories: active.memory.size });

  if (path === "/stt" && req.method === "POST") {
    if (!stt) return json(res, 501, { error: "STT not configured" });
    try {
      const audio = await readBody(req, MAX_AUDIO_BYTES);
      if (audio.length < 100) return json(res, 400, { error: "empty audio" });
      const text = await stt.transcribe(audio, req.headers["content-type"] ?? "audio/wav", { lang: active.soul.voice.lang, prompt: sttHint(active.soul) });
      return json(res, 200, { text });
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === "too large";
      return json(res, tooLarge ? 413 : 502, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  // Your own 3D model: saved once, loaded every time (overrides the one built into the app).
  // The active character's model. The model built into the app belongs to the default character only.
  if (path === "/avatars/default.vrm" && (req.method === "GET" || req.method === "HEAD")) {
    const file = characters.paths(active.id).avatar;
    if (existsSync(file)) {
      if (!authorized(req)) return json(res, 403, { error: "forbidden" });
      res.writeHead(200, { "content-type": "model/gltf-binary", "cache-control": "no-store" });
      if (req.method === "HEAD") return void res.end();
      return void createReadStream(file).pipe(res);
    }
    if (active.id !== DEFAULT_ID) return json(res, 404, { error: "no model for this character yet" });
  }
  // Characters: list, create, switch, delete.
  if (path === "/characters" && req.method === "GET") return json(res, 200, characters.list());
  if (path === "/characters" && req.method === "POST") {
    try {
      const id = characters.create(JSON.parse((await readBody(req, 64 * 1024)).toString("utf8")) as NewCharacter);
      console.log(`[characters] created "${id}"`);
      return json(res, 200, { id });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (path === "/characters/active" && req.method === "POST") {
    try {
      const { id } = JSON.parse((await readBody(req, 4096)).toString("utf8")) as { id?: string };
      switchCharacter(String(id ?? ""));
      return json(res, 200, { id: active.id, name: active.soul.name });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (path.startsWith("/characters/") && req.method === "DELETE") {
    try {
      const id = decodeURIComponent(path.slice("/characters/".length));
      characters.remove(id);
      if (active.id === id) switchCharacter(characters.activeId());
      return json(res, 200, { removed: id });
    } catch (err) {
      return json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (path === "/avatar" && req.method === "POST") {
    try {
      const body = await readBody(req, MAX_AVATAR_BYTES);
      if (!isGlb(body)) return json(res, 400, { error: "Ese archivo no es un modelo VRM/GLB valido." });
      saveAtomic(characters.paths(active.id).avatar, body);
      console.log(`[avatar] saved your model (${(body.length / 1e6).toFixed(1)} MB)`);
      return json(res, 200, { saved: true });
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === "too large";
      return json(res, tooLarge ? 413 : 500, { error: tooLarge ? "El modelo es demasiado grande (max. 150 MB)." : String(err) });
    }
  }
  if (path === "/avatar" && req.method === "DELETE") return json(res, 200, { removed: removeIfExists(characters.paths(active.id).avatar) });
  if (path === "/voice" && req.method === "POST") {
    try {
      const body = await readBody(req, MAX_VOICE_BYTES);
      if (!isWav(body)) return json(res, 400, { error: "La muestra de voz debe ser un archivo .wav." });
      const file = characters.paths(active.id).voice;
      saveAtomic(file, body);
      let status = await ensureVoice(active.id, file).catch((e) => (e instanceof Error ? e.message : String(e)));
      if (status.startsWith("VoiceStudio ya tiene")) status += ". Para usar la nueva muestra, borra esa voz en VoiceStudio y vuelve a cargarla aqui";
      console.log(`[voice] sample saved; ${status}`);
      return json(res, 200, { saved: true, status });
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === "too large";
      return json(res, tooLarge ? 413 : 500, { error: tooLarge ? "La muestra es demasiado grande (max. 20 MB)." : String(err) });
    }
  }
  if (serveStatic?.(req, res, path)) return;
  res.writeHead(404).end();
};
const http = secure
  ? createHttpsServer({ cert: readFileSync(tlsCert!), key: readFileSync(tlsKey!) }, handler)
  : createHttpServer(handler);

const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 3 * 1024 * 1024 /* screenshots */, verifyClient: ({ req }: { req: IncomingMessage }) => authorized(req) });
let clients = 0;
let goneTimer: NodeJS.Timeout | undefined;
wss.on("connection", (ws) => {
  clients++;
  sockets.add(ws);
  clearTimeout(goneTimer);
  const session = new Session(active.soul, llm, active.memory, (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)), { tts, caps, tools: makeTools, watchMinIntervalMs: Number(process.env.WATCH_MIN_INTERVAL_MS ?? 25000), actionLog, approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS ?? 120000) });
  sessions.add(session);
  session.hello();
  ws.on("message", (data) => {
    try {
      session.handle(JSON.parse(data.toString()) as ClientMessage);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "bad message" }));
    }
  });
  ws.on("close", () => {
    session.close();
    sessions.delete(session);
    sockets.delete(ws);
    clients--;
    // A few seconds of grace so a page reload does not close her browser.
    if (clients === 0) goneTimer = setTimeout(() => void onAllClientsGone().then(() => console.log("[app] no window open: her browser closed, file permissions withdrawn")), 5000);
  });
});

// When launched by the desktop shell, die with it even if it crashes or is killed (no orphan servers).
const parentPid = Number(process.env.WAIFU_PARENT_PID);
if (parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0); // signal 0 = existence check only
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") {
        console.log("[server] parent process is gone, shutting down");
        process.exit(0);
      }
    }
  }, 2000).unref();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void (browserForShutdown?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  });
}

// A second copy (another PowerShell window, or the desktop app) already holds the port: explain it plainly.
const portBusy = (e: NodeJS.ErrnoException) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(
    `\n[!] El puerto ${port} ya esta en uso: la app ya esta abierta en otra ventana de PowerShell o en la app de escritorio.\n` +
      `    Cierra la otra (Ctrl+C o cierra la app) y vuelve a intentarlo, o usa otro puerto: pon PORT=8788 en el .env.\n`,
  );
  process.exit(1);
};
http.on("error", portBusy);
wss.on("error", portBusy);
http.listen(port, host, () => {
  const scheme = secure ? "https" : "http";
  console.log(`[${active.soul.name}] soul server on ${scheme}://${host}:${port} | brain=${llm.name} tts=${tts?.name ?? "browser"} stt=${stt?.name ?? "browser"} | memories=${active.memory.size} | web=${serveWeb ? "served" : "not served (run npm run build)"}`);
  if (serveWeb && token && host !== "127.0.0.1" && host !== "localhost") {
    // Pairing links for phones/tablets/other PCs on your network. Treat them like a password.
    const ips = Object.values(networkInterfaces()).flat().filter((n) => n && n.family === "IPv4" && !n.internal).map((n) => n!.address);
    for (const ip of host === "0.0.0.0" ? ips : [host]) {
      const url = `${scheme}://${ip}:${port}/?token=${encodeURIComponent(token)}`;
      console.log(`[pair] ${url}`);
      if (process.env.PAIR_QR !== "0") qrcode.generate(url, { small: true });
    }
    if (!secure) console.log("[pair] NOTE: phones only allow the microphone on HTTPS pages. Set TLS_CERT and TLS_KEY (see README).");
  }
});

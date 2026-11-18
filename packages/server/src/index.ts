import "./env.js"; // must stay first: loads .env before other modules read process.env
import { isLoopbackHost, makeAuthorizer } from "./auth.js";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import qrcode from "qrcode-terminal";
import { WebSocketServer } from "ws";
import type { Capabilities, ClientMessage } from "@waifu/core";
import { ActionLog } from "./actionLog.js";
import { createLLM } from "./llm/index.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import { loadSoul, sttHint } from "./soul.js";
import { createStaticHandler } from "./static.js";
import { browserForShutdown, createToolFactory, onAllClientsGone } from "./tools/index.js";
import { createSTT } from "./stt/index.js";
import { createTTS, VoiceStudioTTS } from "./tts/index.js";

import { appPath, userOrApp, userPath } from "./paths.js";
const port = Number(process.env.PORT ?? 8787);
// Loopback only by default. To use from phone/another PC set HOST=0.0.0.0 AND AUTH_TOKEN.
const host = process.env.HOST ?? "127.0.0.1";
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

const soul = loadSoul(userOrApp(process.env.SOUL_FILE ?? "souls/default.soul.json"));
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
      ? `${from} no responde (${s.reason}). Rice sigue con ${target} en este equipo.`
      : `Rice vuelve a usar ${target}.`;
  console.log(`[brain] ${message}`);
  notify(message);
});
const tts = createTTS();
const stt = createSTT();
if (tts instanceof VoiceStudioTTS) {
  const wanted = soul.voice.ttsVoice ?? process.env.TTS_VOICE ?? "default";
  tts
    .resolveVoice(wanted)
    .then((id) => console.log(`[voice] VoiceStudio: "${wanted}" -> ${id === wanted ? "sent as given (could not list its voices: is VoiceStudio open?)" : `profile ${id}`}`))
    .catch((e) => console.warn(`[voice] ${e instanceof Error ? e.message : e}`));
}
const makeTools = createToolFactory();
const caps: Capabilities = { tts: !!tts, stt: !!stt, vision: !!llm.vision };
const memory = new MemoryStore(process.env.MEMORY_FILE ?? userPath("data/memory.json"));
const actionLog = new ActionLog(process.env.ACTIONS_LOG ?? userPath("data/actions.jsonl"));
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

const authorized = makeAuthorizer({ token, allowedOrigins });
function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (origin && (token || allowedOrigins.has(origin))) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
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
  const isApi = path === "/health" || path === "/stt";
  if (isApi && !authorized(req)) return json(res, 403, { error: "forbidden" });

  if (path === "/health") return json(res, 200, { ok: true, soul: soul.name, llm: llm.name, tts: tts?.name ?? null, stt: stt?.name ?? null, memories: memory.size });

  if (path === "/stt" && req.method === "POST") {
    if (!stt) return json(res, 501, { error: "STT not configured" });
    try {
      const audio = await readBody(req, MAX_AUDIO_BYTES);
      if (audio.length < 100) return json(res, 400, { error: "empty audio" });
      const text = await stt.transcribe(audio, req.headers["content-type"] ?? "audio/wav", { lang: soul.voice.lang, prompt: sttHint(soul) });
      return json(res, 200, { text });
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === "too large";
      return json(res, tooLarge ? 413 : 502, { error: err instanceof Error ? err.message : String(err) });
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
  const session = new Session(soul, llm, memory, (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)), { tts, caps, tools: makeTools, watchMinIntervalMs: Number(process.env.WATCH_MIN_INTERVAL_MS ?? 25000), actionLog, approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS ?? 120000) });
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

http.listen(port, host, () => {
  const scheme = secure ? "https" : "http";
  console.log(`[${soul.name}] soul server on ${scheme}://${host}:${port} | brain=${llm.name} tts=${tts?.name ?? "browser"} stt=${stt?.name ?? "browser"} | memories=${memory.size} | web=${serveWeb ? "served" : "not served (run npm run build)"}`);
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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { Capabilities, ClientMessage } from "@waifu/core";
import { createLLM } from "./llm/index.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import { loadSoul } from "./soul.js";
import { createToolFactory } from "./tools/index.js";
import { createSTT } from "./stt/index.js";
import { createTTS } from "./tts/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const port = Number(process.env.PORT ?? 8787);
// Loopback only by default. To use from phone/another PC set HOST=0.0.0.0 AND AUTH_TOKEN.
const host = process.env.HOST ?? "127.0.0.1";
const token = process.env.AUTH_TOKEN;
if (host !== "127.0.0.1" && host !== "localhost" && !token) {
  throw new Error("Refusing to listen on a non-loopback address without AUTH_TOKEN set.");
}
// Browsers allowed to talk to us when no token is set. Without this check any website you visit
// could open a WebSocket to localhost and chat with (and read the memories of) your companion.
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173").split(",").map((s) => s.trim()),
);

const soul = loadSoul(process.env.SOUL_FILE ?? resolve(root, "souls/default.soul.json"));
const llm = createLLM();
const tts = createTTS();
const stt = createSTT();
const makeTools = createToolFactory();
const caps: Capabilities = { tts: !!tts, stt: !!stt };
const memory = new MemoryStore(process.env.MEMORY_FILE ?? resolve(root, "data/memory.json"));
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

function authorized(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? "", "http://x");
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (token) return url.searchParams.get("token") === token || bearer === token;
  const origin = req.headers.origin;
  return !origin || allowedOrigins.has(origin); // non-browser clients send no Origin
}

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

const http = createServer(async (req, res) => {
  cors(req, res);
  const path = new URL(req.url ?? "", "http://x").pathname;
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  if (!authorized(req)) return json(res, 403, { error: "forbidden" });

  if (path === "/health") return json(res, 200, { ok: true, soul: soul.name, llm: llm.name, tts: tts?.name ?? null, stt: stt?.name ?? null, memories: memory.size });

  if (path === "/stt" && req.method === "POST") {
    if (!stt) return json(res, 501, { error: "STT not configured" });
    try {
      const audio = await readBody(req, MAX_AUDIO_BYTES);
      if (audio.length < 100) return json(res, 400, { error: "empty audio" });
      const text = await stt.transcribe(audio, req.headers["content-type"] ?? "audio/wav", { lang: soul.voice.lang });
      return json(res, 200, { text });
    } catch (err) {
      const tooLarge = err instanceof Error && err.message === "too large";
      return json(res, tooLarge ? 413 : 502, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 64 * 1024, verifyClient: ({ req }: { req: IncomingMessage }) => authorized(req) });
wss.on("connection", (ws) => {
  const session = new Session(soul, llm, memory, (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)), tts, caps, makeTools?.());
  session.hello();
  ws.on("message", (data) => {
    try {
      session.handle(JSON.parse(data.toString()) as ClientMessage);
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "bad message" }));
    }
  });
  ws.on("close", () => session.close());
});

http.listen(port, host, () => {
  console.log(`[${soul.name}] soul server on ${host}:${port} | brain=${llm.name} tts=${tts?.name ?? "browser"} stt=${stt?.name ?? "browser"} | memories=${memory.size}`);
});

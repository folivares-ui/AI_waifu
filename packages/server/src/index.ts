import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { ClientMessage } from "@waifu/core";
import { createLLM } from "./llm/index.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import { loadSoul } from "./soul.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const port = Number(process.env.PORT ?? 8787);
// Loopback only by default. To use from phone/another PC set HOST=0.0.0.0 AND AUTH_TOKEN.
const host = process.env.HOST ?? "127.0.0.1";
const token = process.env.AUTH_TOKEN;
if (host !== "127.0.0.1" && host !== "localhost" && !token) {
  throw new Error("Refusing to listen on a non-loopback address without AUTH_TOKEN set.");
}

const soul = loadSoul(process.env.SOUL_FILE ?? resolve(root, "souls/default.soul.json"));
const llm = createLLM();
const memory = new MemoryStore(process.env.MEMORY_FILE ?? resolve(root, "data/memory.json"));

const http = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, soul: soul.name, llm: llm.name, memories: memory.size }));
  } else {
    res.writeHead(404).end();
  }
});

const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 64 * 1024 });
wss.on("connection", (ws, req) => {
  if (token && new URL(req.url ?? "", "http://x").searchParams.get("token") !== token) {
    ws.close(1008, "unauthorized");
    return;
  }
  const session = new Session(soul, llm, memory, (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)));
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
  console.log(`[${soul.name}] soul server on ${host}:${port} | brain=${llm.name} | memories=${memory.size}`);
});

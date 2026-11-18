import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@waifu/core";
import { ActionLog } from "../actionLog.js";
import { MemoryStore } from "../memory.js";
import { Session } from "../session.js";
import type { Soul } from "../soul.js";
import type { Tool } from "../tools/types.js";
import { OllamaProvider, toOllamaMessages } from "./ollama.js";
import type { LLMEvent } from "./types.js";

/**
 * A fake Ollama /api/chat that answers like the examples in Ollama's docs/api.md:
 * a streamed line with message.tool_calls, then a final {done:true}.
 */
function fakeOllama(reply: (body: any) => object[] | { status: number; text: string }) {
  const bodies: any[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      const r = reply(body);
      if (!Array.isArray(r)) {
        res.writeHead(r.status).end(r.text);
        return;
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      for (const line of r) res.write(JSON.stringify(line) + "\n");
      res.end();
    });
  });
  return new Promise<{ url: string; bodies: any[]; close: () => void }>((ok) =>
    server.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, bodies, close: () => server.close() })),
  );
}
const msg = (content: string, extra: object = {}, done = false) => ({ model: "m", message: { role: "assistant", content, ...extra }, done });
let closers: (() => void)[] = [];
afterEach(() => { closers.forEach((c) => c()); closers = []; });
const collect = async (it: AsyncIterable<LLMEvent>) => { const out: LLMEvent[] = []; for await (const e of it) out.push(e); return out; };

describe("Ollama history conversion", () => {
  it("turns tool_use into tool_calls and tool_result into named role:tool messages", () => {
    const out = toOllamaMessages("SYS", [
      { role: "user", content: "abre main.py" },
      { role: "assistant", content: [{ type: "text", text: "Rice lo abre." }, { type: "tool_use", id: "x1", name: "open_file", input: { path: "main.py" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: "Opened" }, { type: "tool_result", tool_use_id: "zz", content: "fallo", is_error: true }] },
      { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }, { type: "text", text: "mira" }] },
    ], true);
    expect(out).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "abre main.py" },
      { role: "assistant", content: "Rice lo abre.", tool_calls: [{ function: { name: "open_file", arguments: { path: "main.py" } } }] },
      { role: "tool", content: "Opened", tool_name: "open_file" },
      { role: "tool", content: "ERROR: fallo", tool_name: "tool" },
      { role: "user", content: "mira", images: ["AAA"] },
    ]);
    // images are dropped for models without vision
    expect(toOllamaMessages("S", [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A" } }, { type: "text", text: "t" }] }], false)[1]).toEqual({ role: "user", content: "t" });
  });
});

describe("OllamaProvider", () => {
  it("sends tools in Ollama's function format with a bigger context, and yields text + tool calls", async () => {
    const f = await fakeOllama(() => [msg("Rice "), msg("busca.", { tool_calls: [{ function: { name: "find_files", arguments: { query: "tesis" } } }, { function: { name: "list_files", arguments: '{"dir":"."}' } }] }), msg("", {}, true)]);
    closers.push(f.close);
    const p = new OllamaProvider("qwen2.5:3b", f.url);
    const ev = await collect(p.streamWithTools({ system: "S", messages: [{ role: "user", content: "hola" }], tools: [{ name: "find_files", description: "d", input_schema: { type: "object", properties: {} } }] }));
    expect(ev).toEqual([
      { type: "text", text: "Rice " },
      { type: "text", text: "busca." },
      { type: "tool_use", id: "ollama_1", name: "find_files", input: { query: "tesis" } },
      { type: "tool_use", id: "ollama_2", name: "list_files", input: { dir: "." } },
    ]);
    expect(f.bodies[0]).toMatchObject({ model: "qwen2.5:3b", stream: true, options: { num_ctx: 8192 }, tools: [{ type: "function", function: { name: "find_files", description: "d", parameters: { type: "object", properties: {} } } }] });
  });

  it("explains the usual problems in plain words", async () => {
    const f = await fakeOllama((b) => (b.tools ? { status: 400, text: '{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}' } : { status: 404, text: '{"error":"model not found"}' }));
    closers.push(f.close);
    const p = new OllamaProvider("gemma:2b", f.url);
    await expect(collect(p.streamWithTools({ system: "S", messages: [], tools: [{ name: "t", description: "d", input_schema: {} }] }))).rejects.toThrow(/cannot use tools.*OLLAMA_TOOLS=0/);
    await expect(collect(p.stream({ system: "S", messages: [] }) as never)).rejects.toThrow(/ollama pull gemma:2b/);
    await expect(collect(new OllamaProvider("m", "http://127.0.0.1:1").stream({ system: "S", messages: [] }) as never)).rejects.toThrow(/is Ollama running/);
  });

  it("OLLAMA_TOOLS=0 hides tool support from the session", () => {
    expect(new OllamaProvider("m", undefined, false, 8192, false).streamWithTools).toBeUndefined();
    expect(typeof new OllamaProvider("m").streamWithTools).toBe("function");
  });

  it("drives a real session: asks for a tool, the approval card appears, the result goes back as role:tool", async () => {
    const f = await fakeOllama((b) => {
      const last = b.messages.at(-1);
      if (b.system || !b.tools) return [msg("[]", {}, true)]; // memory extraction etc.
      if (last.role === "tool") return [msg(`Rice ya lo guardo, Onii-sama. (${last.content})`), msg("", {}, true)];
      return [msg("", { tool_calls: [{ function: { name: "save_file", arguments: { path: "a.txt" } } }] }), msg("", {}, true)];
    });
    closers.push(f.close);
    const dir = mkdtempSync(join(tmpdir(), "oll-"));
    let ran = 0;
    const tool: Tool = { def: { name: "save_file", description: "d", input_schema: { type: "object" } }, kind: "write", describe: () => ({ summary: "Guardar a.txt" }), run: async () => { ran++; return "saved"; } };
    const out: ServerMessage[] = [];
    const soul: Soul = { name: "Rice Shower", language: "es-ES", voice: { lang: "es-ES", pitch: 1, rate: 1 }, persona: "p", boundaries: "" };
    let s!: Session;
    s = new Session(soul, new OllamaProvider("qwen2.5:3b", f.url), new MemoryStore(join(dir, "m.json")), (m) => {
      out.push(m);
      if (m.type === "approval_request") s.handle({ type: "approval_response", id: m.id, approved: true });
    }, { tools: [tool], actionLog: new ActionLog(join(dir, "a.jsonl")) });
    s.handle({ type: "user_text", text: "guarda el archivo" });
    for (let i = 0; i < 300 && !out.some((m) => m.type === "done"); i++) await new Promise((r) => setTimeout(r, 10));
    expect(out.some((m) => m.type === "approval_request")).toBe(true);
    expect(ran).toBe(1);
    const second = f.bodies.find((b) => b.tools && b.messages.at(-1).role === "tool");
    expect(second.messages.slice(-2)).toEqual([
      { role: "assistant", content: "", tool_calls: [{ function: { name: "save_file", arguments: { path: "a.txt" } } }] },
      { role: "tool", content: "saved", tool_name: "save_file" },
    ]);
    expect(out.filter((m) => m.type === "token").map((m) => (m as { text: string }).text).join("")).toContain("Rice ya lo guardo, Onii-sama. (saved)");
  });
});

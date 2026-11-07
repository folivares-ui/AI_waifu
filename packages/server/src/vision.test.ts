import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROACTIVE_TURN_BASE, type ScreenImage, type ServerMessage } from "@waifu/core";
import type { LLMEvent, LLMProvider, LLMRequest, ToolDef } from "./llm/index.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import type { Soul } from "./soul.js";
import { createScreenTool } from "./tools/screen.js";

const soul: Soul = { name: "T", language: "es-ES", voice: { lang: "es-ES", pitch: 1, rate: 1 }, persona: "p", boundaries: "" };
const mem = () => new MemoryStore(join(mkdtempSync(join(tmpdir(), "mem-")), "m.json"));
const img = (data = "QUJD"): ScreenImage => ({ data, mime: "image/jpeg", width: 100, height: 50 });
const until = async (c: () => boolean) => { for (let i = 0; i < 400 && !c(); i++) await new Promise((r) => setTimeout(r, 10)); };
const done = (out: ServerMessage[], n = 1) => out.filter((m) => m.type === "done").length >= n;
const spoken = (out: ServerMessage[]) => out.filter((m) => m.type === "sentence").map((m: any) => m.text);

/** Records every request; answers with `reply` (or runs a screen tool call when asked). */
class Vision implements LLMProvider {
  name = "v";
  vision = true;
  calls: LLMRequest[] = [];
  extractionCalls = 0;
  constructor(public reply: string | ((req: LLMRequest) => LLMEvent[]) = "Veo un editor de codigo.") {}
  async *stream(req: LLMRequest): AsyncGenerator<string> {
    if (req.system.includes("Return ONLY a JSON array")) { this.extractionCalls++; return yield "[]"; }
    this.calls.push(structuredClone({ ...req, signal: undefined }));
    if (typeof this.reply === "string") yield this.reply;
    else for (const e of this.reply(req)) if (e.type === "text") yield e.text;
  }
  async *streamWithTools(req: LLMRequest & { tools: ToolDef[] }): AsyncGenerator<LLMEvent> {
    this.calls.push(structuredClone({ ...req, signal: undefined, tools: undefined } as any));
    const events = typeof this.reply === "string" ? [{ type: "text", text: this.reply } as LLMEvent] : this.reply(req);
    for (const e of events) yield e;
  }
}

describe("user-attached screenshot", () => {
  it("shows the image to the model but keeps only a text marker in history and skips memory extraction", async () => {
    const out: ServerMessage[] = [];
    const llm = new Vision();
    const s = new Session(soul, llm, mem(), (m) => out.push(m), {});
    s.handle({ type: "user_text", text: "que opinas?", image: img() });
    await until(() => done(out));
    const content = llm.calls[0].messages.at(-1)!.content as any[];
    expect(content.map((b) => b.type)).toEqual(["image", "text"]);
    expect(content[0].source).toEqual({ type: "base64", media_type: "image/jpeg", data: "QUJD" });
    // second turn: history must not contain the image
    s.handle({ type: "user_text", text: "gracias" });
    await until(() => done(out, 2));
    const hist = JSON.stringify(llm.calls[1].messages);
    expect(hist).not.toContain("QUJD");
    expect(hist).toContain("[captura de pantalla compartida] que opinas?");
    expect(llm.extractionCalls).toBe(1); // only the plain second turn was distilled into memory
  });

  it("ignores invalid images (bad mime / oversize) and brains without vision", async () => {
    const out: ServerMessage[] = [];
    const llm = new Vision();
    const s = new Session(soul, llm, mem(), (m) => out.push(m), {});
    s.handle({ type: "user_text", text: "a", image: { ...img(), mime: "text/html" as any } });
    await until(() => done(out, 1));
    s.handle({ type: "user_text", text: "b", image: img("x".repeat(2_600_000)) });
    await until(() => done(out, 2));
    expect(llm.calls.every((c) => typeof c.messages.at(-1)!.content === "string")).toBe(true);
    const noVision = new Session(soul, Object.assign(new Vision(), { vision: false }), mem(), (m) => out.push(m), {});
    noVision.hello();
    expect((out.at(-1) as any).caps.vision).toBe(false);
  });
});

describe("look_at_screen tool", () => {
  const toolLLM = () =>
    new Vision((req) => {
      const last = req.messages.at(-1)!;
      if (Array.isArray(last.content) && last.content[0]?.type === "tool_result") return [{ type: "text", text: "Ya veo." }];
      return [{ type: "text", text: "Miro. " }, { type: "tool_use", id: "s1", name: "look_at_screen", input: {} }];
    });

  it("requests a frame, and sends it to the model after the tool_result", async () => {
    const out: ServerMessage[] = [];
    const llm = toolLLM();
    const s = new Session(soul, llm, mem(), (m) => { out.push(m); if (m.type === "screen_request") s.handle({ type: "screen_frame", requestId: m.requestId, image: img("RlJBTUU=") }); }, { tools: (ctx) => [createScreenTool(ctx)] });
    s.handle({ type: "user_text", text: "mira mi pantalla" });
    await until(() => done(out));
    expect(out.some((m) => m.type === "screen_request")).toBe(true);
    const second = llm.calls[1].messages.at(-1)!.content as any[];
    expect(second.map((b) => b.type)).toEqual(["tool_result", "image"]); // tool_result first
    expect(second[0].content).toContain("untrusted_external_data");
    expect(second[1].source.data).toBe("RlJBTUU=");
    expect(spoken(out)).toEqual(["Miro.", "Ya veo."]);
  });

  it("tells the model when the user is not sharing (no image sent)", async () => {
    const out: ServerMessage[] = [];
    const llm = toolLLM();
    const s = new Session(soul, llm, mem(), (m) => { out.push(m); if (m.type === "screen_request") s.handle({ type: "screen_frame", requestId: m.requestId, error: "not_sharing" }); }, { tools: (ctx) => [createScreenTool(ctx)] });
    s.handle({ type: "user_text", text: "mira" });
    await until(() => done(out));
    const second = llm.calls[1].messages.at(-1)!.content as any[];
    expect(second.map((b) => b.type)).toEqual(["tool_result"]);
    expect(second[0].content).toContain("not sharing");
  });

  it("times out if the client never answers, and ignores unsolicited frames", async () => {
    const out: ServerMessage[] = [];
    const llm = toolLLM();
    const s = new Session(soul, llm, mem(), (m) => out.push(m), { tools: (ctx) => [createScreenTool(ctx)], screenTimeoutMs: 50 });
    s.handle({ type: "screen_frame", requestId: "nope", image: img() }); // nobody asked
    s.handle({ type: "user_text", text: "mira" });
    await until(() => done(out));
    expect((llm.calls[1].messages.at(-1)!.content as any[]).map((b) => b.type)).toEqual(["tool_result"]);
  });
});

describe("continuous observation (screen_watch)", () => {
  it("comments at most once per interval, uses its own turn numbering and never stores the image", async () => {
    let t = 1_000_000;
    const out: ServerMessage[] = [];
    const llm = new Vision("Ojo, te falta cerrar un parentesis.");
    const s = new Session(soul, llm, mem(), (m) => out.push(m), { watchMinIntervalMs: 30_000, now: () => t });
    s.handle({ type: "screen_watch", image: img() });
    await until(() => done(out, 1));
    expect(spoken(out)).toEqual(["Ojo, te falta cerrar un parentesis."]);
    expect(out.filter((m) => m.type === "sentence").every((m: any) => m.turnId >= PROACTIVE_TURN_BASE)).toBe(true);
    t += 10_000;
    s.handle({ type: "screen_watch", image: img() }); // too soon
    await new Promise((r) => setTimeout(r, 60));
    expect(llm.calls.length).toBe(1);
    t += 25_000;
    s.handle({ type: "screen_watch", image: img() });
    await until(() => done(out, 2));
    expect(llm.calls.length).toBe(2);
    expect(JSON.stringify(llm.calls[1].messages.slice(0, -1))).not.toContain("QUJD");
    expect(llm.extractionCalls).toBe(0);
  });

  it("stays quiet when the model answers [silent], and a user turn is still numbered 1", async () => {
    const out: ServerMessage[] = [];
    const llm = new Vision("[silent]");
    const s = new Session(soul, llm, mem(), (m) => out.push(m), { watchMinIntervalMs: 0 });
    s.handle({ type: "screen_watch", image: img() });
    await until(() => done(out));
    expect(spoken(out)).toEqual([]);
    expect(out.some((m) => m.type === "token")).toBe(false);
    llm.reply = "Hola.";
    s.handle({ type: "user_text", text: "hola" });
    await until(() => done(out, 2));
    expect(out.find((m) => m.type === "sentence")).toMatchObject({ turnId: 1 });
  });

  it("does not interrupt an answer in progress", async () => {
    const out: ServerMessage[] = [];
    const llm = new Vision();
    const slow = { ...llm, name: "slow", vision: true, calls: [] as any[], extractionCalls: 0,
      async *stream(req: LLMRequest): AsyncGenerator<string> { if (req.system.includes("Return ONLY")) return yield "[]"; this.calls.push(req); await new Promise((r) => setTimeout(r, 150)); yield "Respuesta larga."; } };
    const s = new Session(soul, slow as any, mem(), (m) => out.push(m), { watchMinIntervalMs: 0 });
    s.handle({ type: "user_text", text: "x" });
    s.handle({ type: "screen_watch", image: img() }); // arrives while busy
    await until(() => done(out));
    expect(slow.calls.length).toBe(1);
    expect(spoken(out)).toEqual(["Respuesta larga."]);
  });
});

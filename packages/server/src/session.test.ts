import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@waifu/core";
import type { LLMProvider, LLMRequest } from "./llm/index.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import type { Soul } from "./soul.js";

const soul: Soul = {
  name: "T",
  language: "en-US",
  voice: { lang: "en-US", pitch: 1, rate: 1 },
  persona: "p",
  boundaries: "",
};
const mem = () => new MemoryStore(join(mkdtempSync(join(tmpdir(), "mem-")), "m.json"));

class Scripted implements LLMProvider {
  name = "scripted";
  constructor(private chunks: string[], private delay = 0) {}
  async *stream(req: LLMRequest): AsyncGenerator<string> {
    if (req.system.includes("Return ONLY a JSON array")) return yield '["User likes tea"]';
    for (const c of this.chunks) {
      if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
      if (req.signal?.aborted) return;
      yield c;
    }
  }
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("Session", () => {
  it("streams sentences with emotions and stores extracted memories", async () => {
    const out: ServerMessage[] = [];
    const memory = mem();
    const s = new Session(soul, new Scripted(["[emotion:happy] Hi! ", "I like tea too."]), memory, (m) => out.push(m));
    s.handle({ type: "user_text", text: "I like tea" });
    await until(() => memory.size > 0);
    const sentences = out.filter((m) => m.type === "sentence");
    expect(sentences.map((m) => (m as any).text)).toEqual(["Hi!", "I like tea too."]);
    expect((sentences[0] as any).emotion).toBe("happy");
    expect(out.at(-1)).toMatchObject({ type: "done", interrupted: false });
    expect(memory.recall("tea")).toEqual(["User likes tea"]);
  });

  it("interrupt stops the turn and reports interrupted", async () => {
    const out: ServerMessage[] = [];
    const s = new Session(soul, new Scripted(["One. ", "Two. ", "Three. ", "Four."], 30), mem(), (m) => out.push(m));
    s.handle({ type: "user_text", text: "go" });
    await new Promise((r) => setTimeout(r, 50));
    s.handle({ type: "interrupt" });
    await until(() => out.some((m) => m.type === "done"));
    expect(out.find((m) => m.type === "done")).toMatchObject({ interrupted: true });
    expect(out.filter((m) => m.type === "sentence").length).toBeLessThan(4);
  });
});

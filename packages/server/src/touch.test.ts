import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROACTIVE_TURN_BASE, type ServerMessage } from "@waifu/core";
import type { LLMProvider, LLMRequest } from "./llm/index.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import type { Soul } from "./soul.js";

const soul: Soul = { name: "Rice Shower", language: "es-ES", voice: { lang: "es-ES", pitch: 1, rate: 1 }, persona: "p", boundaries: "" };
const until = async (c: () => boolean) => { for (let i = 0; i < 300 && !c(); i++) await new Promise((r) => setTimeout(r, 10)); };

class Rec implements LLMProvider {
  name = "rec";
  seen: LLMRequest[] = [];
  extraction = 0;
  async *stream(req: LLMRequest): AsyncGenerator<string> {
    if (req.system.includes("Return ONLY a JSON array")) { this.extraction++; return yield "[]"; }
    this.seen.push(structuredClone({ ...req, signal: undefined }));
    yield "[emotion:shy] E-eh... Onii-sama...";
  }
}

const setup = (now = () => 0) => {
  const out: ServerMessage[] = [];
  const llm = new Rec();
  const s = new Session(soul, llm, new MemoryStore(join(mkdtempSync(join(tmpdir(), "t-")), "m.json")), (m) => out.push(m), { reactionMinIntervalMs: 7000, now });
  const dones = () => out.filter((m) => m.type === "done").length;
  return { s, out, llm, dones };
};

describe("petting and gestures", () => {
  it("a head pat produces one short spoken reaction with its own turn numbering, no memory", async () => {
    const t = setup();
    t.s.handle({ type: "touch", region: "head" });
    await until(() => t.dones() === 1);
    const instr = t.llm.seen[0].messages.at(-1)!.content as string;
    expect(instr).toMatch(/^\[Caricia con el cursor: cabeza\] .*stroking your head.*ONE short spoken sentence/);
    expect(instr).not.toMatch(/private area/);
    const said = t.out.filter((m) => m.type === "sentence") as any[];
    expect(said.map((m) => m.text).join(" ")).toBe("E-eh... Onii-sama...");
    expect(said.every((m) => m.emotion === "shy" && m.turnId > PROACTIVE_TURN_BASE)).toBe(true);
    expect(t.llm.extraction).toBe(0);
  });

  it("private areas always get a flustered, wholesome refusal", async () => {
    const t = setup();
    t.s.handle({ type: "touch", region: "head" });
    await until(() => t.dones() === 1);
    t.s.handle({ type: "touch", region: "chest" }); // right after: still answered
    await until(() => t.dones() === 2);
    expect(t.llm.seen[1].messages.at(-1)!.content).toMatch(/\[Caricia con el cursor: pecho\].*private area.*politely ask them to stop.*never suggestive/);
  });

  it("pleasant touches and gestures are rate limited and never interrupt an answer", async () => {
    let clock = 0;
    const t = setup(() => clock);
    t.s.handle({ type: "touch", region: "ears" });
    await until(() => t.dones() === 1);
    clock = 3000;
    t.s.handle({ type: "gesture", gesture: "wave" }); // too soon
    await new Promise((r) => setTimeout(r, 40));
    expect(t.llm.seen).toHaveLength(1);
    clock = 9000;
    t.s.handle({ type: "gesture", gesture: "wave" });
    await until(() => t.dones() === 2);
    expect(t.llm.seen[1].messages.at(-1)!.content).toMatch(/^\[Gesto con la mano ante la camara: saludo con la mano\]/);
    // history keeps only the short marker, not the instructions
    expect(JSON.stringify(t.llm.seen[1].messages)).toContain('"[Caricia con el cursor: orejas]"');
  });

  it("ignores unknown regions and gestures", async () => {
    const t = setup();
    t.s.handle({ type: "touch", region: "x" as any });
    t.s.handle({ type: "gesture", gesture: "rm -rf" as any });
    await new Promise((r) => setTimeout(r, 40));
    expect(t.llm.seen).toHaveLength(0);
  });
});

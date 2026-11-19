import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@waifu/core";
import { DEFAULT_TRAITS, evaluateGrowth, Growth, MAX_PER_DAY, type Trait } from "./growth.js";
import type { LLMProvider, LLMRequest } from "./llm/index.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import type { Soul } from "./soul.js";

const conf: Trait = { id: "confianza", name: "Confianza", start: 20, low: "hesitates a lot", high: "calm and sure", up: "se siente mas segura", down: "esta insegura" };
const tmp = () => join(mkdtempSync(join(tmpdir(), "grow-")), "growth.json");

describe("personality growth", () => {
  it("starts where the character starts and moves slowly: at most 2 per exchange and 6 per day", () => {
    let day = new Date("2026-11-19T10:00:00Z");
    const g = new Growth(tmp(), [conf], () => day);
    expect(g.level("confianza")).toBe(20);
    g.apply([{ trait: "confianza", delta: 50, reason: "lo animo muchisimo" }]);
    expect(g.level("confianza")).toBe(22);
    for (let i = 0; i < 10; i++) g.apply([{ trait: "confianza", delta: 2, reason: "animo" }]);
    expect(g.level("confianza")).toBe(20 + MAX_PER_DAY);
    day = new Date("2026-11-20T10:00:00Z"); // another day, more growth
    g.apply([{ trait: "confianza", delta: 2, reason: "animo" }]);
    expect(g.level("confianza")).toBe(28);
  });

  it("is saved per character, can go down, ignores unknown traits, and can be reset", () => {
    const file = tmp();
    const g = new Growth(file, [conf]);
    g.apply([{ trait: "confianza", delta: -2, reason: "se burlo de ella" }, { trait: "magia", delta: 2, reason: "x" }]);
    expect(new Growth(file, [conf]).level("confianza")).toBe(18);
    expect(new Growth(file, [conf]).snapshot().recent[0]).toMatchObject({ trait: "confianza", delta: -2, reason: "se burlo de ella" });
    g.reset();
    expect(new Growth(file, [conf]).level("confianza")).toBe(20);
  });

  it("announces milestones (every 25 points)", () => {
    const g = new Growth(tmp(), [{ ...conf, start: 24 }]);
    expect(g.apply([{ trait: "confianza", delta: 2, reason: "" }]).map((m) => [m.trait.up, m.up, m.level])).toEqual([["se siente mas segura", true, 26]]);
  });

  it("tells the model who she is now, and the Japanese voice follows it", () => {
    const g = new Growth(tmp(), [conf]);
    expect(g.prompt()).toMatch(/Confianza: 20\/100\. At 0: hesitates a lot\. At 100: calm and sure/);
    expect(g.prompt()).toMatch(/current levels win/);
    expect(g.styleNote()).toBe("Confianza 20/100 (0 = hesitates a lot; 100 = calm and sure)");
  });

  it("the judge is told that orders are not growth; bad answers change nothing", async () => {
    let system = "";
    const judge: LLMProvider = { name: "j", async *stream(req: LLMRequest) { system = req.system; yield 'Claro: [{"trait":"confianza","delta":1,"reason":"confio en ella"}]'; } };
    expect(await evaluateGrowth(judge, "Rice Shower", [conf], "Confio en ti", "Rice... lo intentara")).toEqual([{ trait: "confianza", delta: 1, reason: "confio en ella" }]);
    expect(system).toMatch(/NOT growth by themselves/);
    const broken: LLMProvider = { name: "b", async *stream() { yield "no se"; } };
    expect(await evaluateGrowth(broken, "Rice", [conf], "a", "b")).toEqual([]);
    expect(DEFAULT_TRAITS.map((t) => t.id)).toEqual(["confianza", "cercania"]);
  });

  it("in a real conversation: encouragement raises her confidence, she says so, and her next prompt reflects it", async () => {
    const systems: string[] = [];
    const llm: LLMProvider = {
      name: "fake",
      async *stream(req: LLMRequest) {
        systems.push(req.system);
        if (req.system.includes("personality growth")) return void (yield '[{"trait":"confianza","delta":2,"reason":"la animo"}]');
        if (req.system.includes("Return ONLY a JSON array")) return void (yield "[]");
        yield "Rice... gracias, Onii-sama.";
      },
    };
    const soul: Soul = { name: "Rice Shower", language: "es-ES", voice: { lang: "es-ES", pitch: 1, rate: 1 }, persona: "p", boundaries: "", growth: [{ ...conf, start: 24 }] };
    const out: ServerMessage[] = [];
    const growth = new Growth(tmp(), soul.growth!);
    const s = new Session(soul, llm, new MemoryStore(join(mkdtempSync(join(tmpdir(), "g-")), "m.json")), (m) => out.push(m), { growth });
    for (const text of ["Lo hiciste genial, confio en ti", "hola"]) {
      const n = out.length;
      s.handle({ type: "user_text", text });
      for (let i = 0; i < 300 && !out.slice(n).some((m) => m.type === "done"); i++) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 30)); // growth is evaluated right after the answer
    }
    expect(growth.level("confianza")).toBe(28);
    expect(out.some((m) => m.type === "notice" && m.message === "Rice Shower se siente mas segura.")).toBe(true);
    const chat = systems.filter((x) => x.startsWith("p"));
    expect(chat[0]).toMatch(/Confianza: 24\/100/);
    expect(chat[1]).toMatch(/Confianza: 26\/100/);
  });
});

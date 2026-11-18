import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@waifu/core";
import type { LLMProvider, LLMRequest } from "./llm/index.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import { buildSystemPrompt, loadSoul, sttHint } from "./soul.js";

const rice = loadSoul(resolve(__dirname, "../../../souls/default.soul.json"));
const until = async (c: () => boolean) => { for (let i = 0; i < 300 && !c(); i++) await new Promise((r) => setTimeout(r, 10)); };

class Recorder implements LLMProvider {
  name = "rec";
  seen: LLMRequest[] = [];
  async *stream(req: LLMRequest): AsyncGenerator<string> {
    if (req.system.includes("Return ONLY a JSON array")) return yield "[]";
    if (req.system.startsWith("TRANSLATE_FOR_SPEECH")) return yield "ライス"; // spoken-language translation
    this.seen.push(structuredClone({ ...req, signal: undefined }));
    yield "Rice esta aqui.";
  }
}

describe("Rice Shower soul", () => {
  it("is the default soul, with her name, aliases and owner honorific", () => {
    expect(rice.name).toBe("Rice Shower");
    expect(rice.names?.aliases).toEqual(["Rice Shower", "Rice"]);
    expect(rice.owner?.honorific).toBe("Onii-sama");
    expect(rice.persona).toMatch(/tercera persona/);
    expect(sttHint(rice)).toBe("Rice Shower, Rice, Onii-sama.");
  });

  it("system prompt explains typed vs voice messages and other people", () => {
    const sys = buildSystemPrompt(rice, []);
    expect(sys).toContain("Your name is Rice Shower");
    expect(sys).toContain('call them "Onii-sama"');
    expect(sys).toContain("[texto] = typed by your owner");
    expect(sys).toMatch(/call that person by THEIR name \(never "Onii-sama"\)/);
    expect(sys).toMatch(/Never tell other people your owner's private things/);
    const named = buildSystemPrompt({ ...rice, owner: { name: "Felipe", honorific: "Onii-sama" } }, []);
    expect(named).toContain('call them "Onii-sama" or by their name, Felipe');
  });

  it("tags typed/voice messages, recognises her name in any spelling and announces it in ready", async () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-"));
    const out: ServerMessage[] = [];
    const llm = new Recorder();
    const s = new Session(rice, llm, new MemoryStore(join(dir, "m.json")), (m) => out.push(m), {});
    s.hello();
    expect(out[0]).toMatchObject({ type: "ready", soul: { name: "Rice Shower", names: { aliases: ["Rice Shower", "Rice"] } } });
    const turns = (n: number) => until(() => out.filter((m) => m.type === "done").length >= n);
    s.handle({ type: "user_text", text: "rice shower, ¿me ayudas?" });
    await turns(1);
    s.handle({ type: "user_text", text: "hola rais", source: "voice" });
    await turns(2);
    s.handle({ type: "user_text", text: "soy Ana, encantada", source: "voice" });
    await turns(3);
    const last = (i: number) => llm.seen[i].messages.at(-1)!.content;
    expect(last(0)).toBe("[texto · te llamaron por tu nombre] Rice Shower, ¿me ayudas?");
    expect(last(1)).toBe("[voz · te llamaron por tu nombre] hola Rice");
    expect(last(2)).toBe("[voz] soy Ana, encantada");
  });

  it("loads custom souls without names config (falls back to the name)", () => {
    const dir = mkdtempSync(join(tmpdir(), "soul-"));
    writeFileSync(join(dir, "s.json"), JSON.stringify({ name: "Luna", persona: "p" }));
    expect(loadSoul(join(dir, "s.json")).names).toEqual({ aliases: ["Luna"] });
  });
});

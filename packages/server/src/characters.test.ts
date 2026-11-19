import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@waifu/core";
import { Characters, DEFAULT_ID, slugify } from "./characters.js";
import { MockProvider } from "./llm/mock.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";

const shipped = resolve(dirname(fileURLToPath(import.meta.url)), "../../../souls");
const setup = () => {
  const base = mkdtempSync(join(tmpdir(), "chars-"));
  return { base, c: new Characters(shipped, join(base, "souls"), join(base, "data")) };
};

describe("characters", () => {
  it("ships Rice Shower (default) and Agnes Tachyon; old example souls are hidden", () => {
    const { c } = setup();
    const list = c.list();
    expect(list.map((x) => [x.id, x.name, x.builtIn])).toEqual([
      ["agnes-tachyon", "Agnes Tachyon", true],
      ["default", "Rice Shower", true],
    ]);
    expect(list.find((x) => x.active)?.id).toBe(DEFAULT_ID);
    const agnes = c.load("agnes-tachyon");
    expect(agnes.owner?.honorific).toBe("Morumotto-kun");
    expect(agnes.voice).toMatchObject({ ttsVoice: "Agnes Tachyon", speechLang: "ja-JP" });
    expect(agnes.names?.aliases).toContain("Tachyon");
  });

  it("each character has her own model, voice and memory; Rice keeps the files she always had", () => {
    const { c, base } = setup();
    expect(c.paths(DEFAULT_ID)).toMatchObject({ avatar: join(base, "data/avatars/default.vrm"), voice: join(base, "data/voices/voice-ref.wav"), memory: join(base, "data/memory.json") });
    expect(c.paths("agnes-tachyon")).toMatchObject({ avatar: join(base, "data/characters/agnes-tachyon/avatar.vrm"), memory: join(base, "data/characters/agnes-tachyon/memory.json") });
    mkdirSync(join(base, "data/voices/rice-shower"), { recursive: true });
    writeFileSync(join(base, "data/voices/rice-shower/rice-ref-2.wav"), "RIFF");
    expect(c.voiceSample(DEFAULT_ID)).toMatch(/rice-ref-2\.wav$/); // the clip prepared earlier still counts
    expect(c.voiceSample("agnes-tachyon")).toBeUndefined();
  });

  it("remembers the chosen character; refuses unknown ids and path tricks", () => {
    const { c, base } = setup();
    c.setActive("agnes-tachyon");
    expect(new Characters(shipped, join(base, "souls"), join(base, "data")).activeId()).toBe("agnes-tachyon");
    expect(() => c.setActive("../../etc/passwd")).toThrow(/Unknown/);
    expect(c.exists("..")).toBe(false);
  });

  it("creates characters from the app's form and deletes only those", () => {
    const { c, base } = setup();
    const id = c.create({ name: "Manhattan Café", persona: "Una chica callada y misteriosa a la que le encanta el cafe.", honorific: "Trainer-san", aliases: ["Cafe"], speechLang: "ja-JP", speechStyle: "habla bajito" });
    expect(id).toBe("manhattan-cafe");
    const soul = c.load(id);
    expect(soul).toMatchObject({ name: "Manhattan Café", owner: { honorific: "Trainer-san" }, voice: { ttsVoice: "Manhattan Café", speechLang: "ja-JP", speechStyle: "habla bajito" } });
    expect(soul.names?.aliases).toEqual(["Manhattan Café", "Cafe"]);
    expect(c.create({ name: "Manhattan Café", persona: "Otra version del mismo personaje con su cafe." })).toBe("manhattan-cafe-2");
    expect(() => c.create({ name: "", persona: "x".repeat(30) })).toThrow(/nombre/);
    expect(() => c.create({ name: "Ok", persona: "corta" })).toThrow(/personalidad/);
    c.setActive(id);
    c.remove(id);
    expect(existsSync(join(base, "souls", `${id}.soul.json`))).toBe(false);
    expect(c.activeId()).toBe(DEFAULT_ID);
    expect(() => c.remove("agnes-tachyon")).toThrow(/no se pueden borrar/);
    expect(slugify("¡Rice Shower!")).toBe("rice-shower");
  });

  it("switching character restarts the conversation in the open window with the new name", async () => {
    const { c, base } = setup();
    const out: ServerMessage[] = [];
    const s = new Session(c.load(DEFAULT_ID), new MockProvider(), new MemoryStore(join(base, "m1.json")), (m) => out.push(m));
    s.hello();
    s.setCharacter(c.load("agnes-tachyon"), new MemoryStore(join(base, "m2.json")));
    const readies = out.filter((m) => m.type === "ready") as Extract<ServerMessage, { type: "ready" }>[];
    expect(readies.map((r) => r.soul.name)).toEqual(["Rice Shower", "Agnes Tachyon"]);
  });
});

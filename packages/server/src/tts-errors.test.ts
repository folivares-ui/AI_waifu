import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ServerMessage } from "@waifu/core";
import { MockProvider } from "./llm/mock.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import type { Soul } from "./soul.js";
import { reachError } from "./tts/index.js";

it("when the voice engine is down, the user is told once (in Spanish) and every sentence is still shown", async () => {
  const soul: Soul = { name: "Rice Shower", language: "es-ES", voice: { lang: "es-ES", pitch: 1, rate: 1 }, persona: "p", boundaries: "" };
  const tts = { name: "voicestudio", synthesize: async () => { throw reachError("http://localhost:3900/v1/audio/speech", { cause: { code: "ECONNREFUSED" } }); } };
  const out: ServerMessage[] = [];
  const s = new Session(soul, new MockProvider(), new MemoryStore(join(mkdtempSync(join(tmpdir(), "tts-")), "m.json")), (m) => out.push(m), { tts: tts as never });
  for (const text of ["hola", "otra vez"]) {
    const before = out.length;
    s.handle({ type: "user_text", text });
    for (let i = 0; i < 300 && !out.slice(before).some((m) => m.type === "done"); i++) await new Promise((r) => setTimeout(r, 10));
  }
  const errors = out.filter((m) => m.type === "error") as { message: string }[];
  expect(errors).toHaveLength(1);
  expect(errors[0].message).toMatch(/^La voz de Rice Shower no esta disponible.*abre VoiceStudio/);
  expect(out.filter((m) => m.type === "sentence").length).toBeGreaterThanOrEqual(4);
});

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@waifu/core";
import type { LLMProvider, LLMRequest } from "./llm/index.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import type { Soul } from "./soul.js";
import { speechLangOf, translateForSpeech, validLang } from "./speech.js";

const soul: Soul = {
  name: "Rice Shower",
  language: "es-ES",
  voice: { lang: "es-ES", pitch: 1.3, rate: 1, speechLang: "ja-JP", speechStyle: "se llama a si misma ライス" },
  persona: "p",
  boundaries: "",
};

/** Answers the chat with two Spanish sentences, and "translates" by tagging the line. */
class Fake implements LLMProvider {
  name = "fake";
  systems: string[] = [];
  async *stream(req: LLMRequest): AsyncGenerator<string> {
    this.systems.push(req.system);
    const last = req.messages.at(-1)!.content as string;
    if (req.system.startsWith("TRANSLATE_FOR_SPEECH")) {
      yield `「JA:${last}」`;
      return;
    }
    if (req.system.includes("Return ONLY a JSON array")) return void (yield "[]");
    yield "[emotion:happy] Hola, Onii-sama. Rice esta feliz.";
  }
}

const run = async (setup?: (s: Session) => void) => {
  const llm = new Fake();
  const out: ServerMessage[] = [];
  const s = new Session(soul, llm, new MemoryStore(join(mkdtempSync(join(tmpdir(), "sp-")), "m.json")), (m) => out.push(m));
  setup?.(s);
  s.handle({ type: "user_text", text: "hola" });
  for (let i = 0; i < 300 && !out.some((m) => m.type === "done"); i++) await new Promise((r) => setTimeout(r, 10));
  return { out, llm, sentences: out.filter((m) => m.type === "sentence") as Extract<ServerMessage, { type: "sentence" }>[] };
};

describe("speaking Japanese with Spanish subtitles", () => {
  it("each sentence is shown in Spanish and spoken in Japanese, in order", async () => {
    const { sentences, llm } = await run();
    expect(sentences.map((s) => [s.text, s.speech, s.speechLang])).toEqual([
      ["Hola, Onii-sama.", "JA:Hola, Onii-sama.", "ja-JP"],
      ["Rice esta feliz.", "JA:Rice esta feliz.", "ja-JP"],
    ]);
    const t = llm.systems.find((x) => x.startsWith("TRANSLATE_FOR_SPEECH"))!;
    expect(t).toContain("spoken Japanese");
    expect(t).toContain("ライス");
  });
  it("the app can switch back to Spanish (and to Japanese again)", async () => {
    const { sentences } = await run((s) => s.handle({ type: "speech_lang", lang: "es-ES" }));
    expect(sentences.every((s) => s.speech === undefined)).toBe(true);
    const again = await run((s) => {
      s.handle({ type: "speech_lang", lang: "es-ES" });
      s.handle({ type: "speech_lang", lang: null }); // back to the soul's default (Japanese)
    });
    expect(again.sentences[0].speechLang).toBe("ja-JP");
  });
  it("rejects nonsense languages; SPEECH_LANG overrides the soul", () => {
    expect([validLang("ja"), validLang("ja-JP"), validLang("es-419")]).toEqual([true, true, true]);
    expect([validLang("ja; rm -rf"), validLang(""), validLang(5)]).toEqual([false, false, false]);
    expect(speechLangOf(soul, undefined, { SPEECH_LANG: "es-ES" })).toBe("es-ES");
    expect(speechLangOf(soul, "en-US", { SPEECH_LANG: "es-ES" })).toBe("en-US");
    expect(speechLangOf(soul, undefined, {})).toBe("ja-JP");
  });
  it("strips quotes the model may add", async () => {
    expect(await translateForSpeech(new Fake(), soul, "Hola", "ja-JP")).toBe("JA:Hola");
  });
});

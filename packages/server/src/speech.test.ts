import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@waifu/core";
import type { LLMProvider, LLMRequest } from "./llm/index.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import type { Soul } from "./soul.js";
import { cleanTranslation, looksLike, speechLangOf, translateForSpeech, validLang } from "./speech.js";

const soul: Soul = {
  name: "Rice Shower",
  language: "es-ES",
  voice: { lang: "es-ES", pitch: 1.3, rate: 1, speechLang: "ja-JP", speechStyle: "se llama a si misma ライス" },
  persona: "p",
  boundaries: "",
};

const JA: Record<string, string> = { "Hola, Onii-sama.": "こんにちは、お兄さま。", "Rice esta feliz.": "ライスはうれしいです。", Hola: "こんにちは" };

/** Answers the chat with two Spanish sentences, and "translates" them with a fixed table. */
class Fake implements LLMProvider {
  name = "fake";
  systems: string[] = [];
  async *stream(req: LLMRequest): AsyncGenerator<string> {
    this.systems.push(req.system);
    const last = req.messages.at(-1)!.content as string;
    if (req.system.startsWith("TRANSLATE_FOR_SPEECH")) {
      yield `「${JA[last] ?? "ライス…"}」`;
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
      ["Hola, Onii-sama.", "こんにちは、お兄さま。", "ja-JP"],
      ["Rice esta feliz.", "ライスはうれしいです。", "ja-JP"],
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
    expect(await translateForSpeech(new Fake(), soul, "Hola", "ja-JP")).toBe("こんにちは");
  });

  it("never speaks Spanish: a translation that comes back in Spanish is retried strictly, then the line is only shown", async () => {
    const replies = ["Hola, Onii-sama, arigatou.", "こんにちは、お兄さま。ありがとう。"];
    const flaky: LLMProvider = {
      name: "flaky",
      async *stream(req: LLMRequest) {
        if (req.system.startsWith("TRANSLATE_FOR_SPEECH")) yield req.system.includes("was not in Japanese") ? replies[1] : replies[0];
      },
    };
    expect(await translateForSpeech(flaky, soul, "Hola, Onii-sama, arigatou.", "ja-JP")).toBe("こんにちは、お兄さま。ありがとう。");
    const stubborn: LLMProvider = { name: "s", async *stream() { yield "Hola, Onii-sama."; } };
    await expect(translateForSpeech(stubborn, soul, "Hola", "ja-JP")).rejects.toThrow(/not in Japanese/);
    expect(looksLike("[emotion:happy] ライスはがんばります！", "ja")).toBe(true);
    expect(looksLike("Rice ganbaru!", "ja")).toBe(false);
    expect(cleanTranslation("[emotion:shy]「ライス…」")).toBe("ライス…");
  });

  it("a line that could not be translated is shown but not spoken (no Spanish voice)", async () => {
    class NoJa extends Fake {
      async *stream(req: LLMRequest): AsyncGenerator<string> {
        if (req.system.startsWith("TRANSLATE_FOR_SPEECH")) return void (yield "Hola, Onii-sama.");
        yield* super.stream(req);
      }
    }
    const llm = new NoJa();
    const out: ServerMessage[] = [];
    const s = new Session(soul, llm, new MemoryStore(join(mkdtempSync(join(tmpdir(), "sp-")), "m.json")), (m) => out.push(m));
    s.handle({ type: "user_text", text: "hola" });
    for (let i = 0; i < 300 && !out.some((m) => m.type === "done"); i++) await new Promise((r) => setTimeout(r, 10));
    const sentences = out.filter((m) => m.type === "sentence") as Extract<ServerMessage, { type: "sentence" }>[];
    expect(sentences.map((x) => [x.text, x.speech])).toEqual([["Hola, Onii-sama.", ""], ["Rice esta feliz.", ""]]);
  });
});

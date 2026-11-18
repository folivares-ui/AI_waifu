import { describe, expect, it } from "vitest";
import { pickVoice } from "./voice";

const v = (name: string, lang: string) => ({ name, lang }) as SpeechSynthesisVoice;

describe("pickVoice", () => {
  it("prefers a natural female voice of the right language, never a male one if avoidable", () => {
    const list = [v("Microsoft Ichiro - Japanese", "ja-JP"), v("Microsoft Sabina - Spanish (Mexico)", "es-MX"), v("Microsoft Nanami Online (Natural) - Japanese (Japan)", "ja-JP"), v("Microsoft Haruka - Japanese", "ja-JP")];
    expect(pickVoice(list, "ja-JP")?.name).toMatch(/Nanami/);
    expect(pickVoice(list.filter((x) => !/Nanami/.test(x.name)), "ja-JP")?.name).toMatch(/Haruka/);
    expect(pickVoice([v("Google 日本語", "ja-JP")], "ja-JP")?.name).toBe("Google 日本語");
    expect(pickVoice(list, "ko-KR")).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { SentenceChunker, extractEmotion } from "./text.js";

describe("extractEmotion", () => {
  it("strips tags and returns the emotion", () => {
    expect(extractEmotion("[emotion:happy] Hola!")).toEqual({ text: "Hola!", emotion: "happy" });
  });
  it("ignores unknown emotions but still strips the tag", () => {
    expect(extractEmotion("[emotion:bogus] Hi")).toEqual({ text: "Hi", emotion: undefined });
  });
});

describe("SentenceChunker", () => {
  it("emits sentences as they complete", () => {
    const c = new SentenceChunker();
    const out = [...c.push("Hola. Como "), ...c.push("estas? Bien"), ...c.flush()];
    expect(out.map((s) => s.text)).toEqual(["Hola.", "Como estas?", "Bien"]);
  });
  it("applies emotion to following sentences and never leaks split tags", () => {
    const c = new SentenceChunker();
    const out = [
      ...c.push("[emot"),
      ...c.push("ion:happy] Yay! Next"),
      ...c.push(" one. [emotion:sad] Oh no."),
      ...c.flush(),
    ];
    expect(out).toEqual([
      { text: "Yay!", emotion: "happy" },
      { text: "Next one.", emotion: "happy" },
      { text: "Oh no.", emotion: "sad" },
    ]);
  });
  it("does not split decimals mid-stream", () => {
    const c = new SentenceChunker();
    const out = [...c.push("Pi is 3."), ...c.push("14 roughly."), ...c.flush()];
    expect(out.map((s) => s.text)).toEqual(["Pi is 3.14 roughly."]);
  });
});

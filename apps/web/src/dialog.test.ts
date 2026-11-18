import { describe, expect, it } from "vitest";
import { addLine, cleanTags, markStarted, revealStale, type Dialog } from "./dialog";

describe("cleanTags", () => {
  it("removes emotion tags anywhere, even when they arrived split across tokens", () => {
    const tokens = ["[emotion:sh", "y]U-um... a Rice le da verguenza, Onii-sama... ", "[emotion:happy]", "Rice seguira esforzandose por ti, arigatou."];
    let raw = "";
    const seen = tokens.map((t) => cleanTags((raw += t)));
    expect(seen[0]).toBe(""); // half a tag is never shown
    expect(seen.at(-1)).toBe("U-um... a Rice le da verguenza, Onii-sama... Rice seguira esforzandose por ti, arigatou.");
    expect(seen.join("|")).not.toMatch(/emotion|y\]/);
  });
  it("keeps normal brackets and text", () => {
    expect(cleanTags("Mira [esto]")).toBe("Mira [esto]");
    expect(cleanTags("[silent]")).toBe("");
  });
});

describe("dialog box", () => {
  it("shows each sentence when she starts saying it, in order; a new turn starts a fresh box", () => {
    let d: Dialog = { turn: 0, lines: [] };
    const a = addLine(d, 1, "Hola, Onii-sama.", "こんにちは、お兄さま。", 0);
    d = a.dialog;
    const b = addLine(d, 1, "[emotion:happy] Rice esta feliz.", "ライスはうれしい。", 10);
    d = b.dialog;
    expect(d.lines.filter((l) => l.started)).toEqual([]);
    d = markStarted(d, b.key); // the second starting implies the first was said
    expect(d.lines.map((l) => [l.text, l.started])).toEqual([["Hola, Onii-sama.", true], ["Rice esta feliz.", true]]);
    d = addLine(d, 2, "Nueva respuesta.", undefined, 20).dialog;
    expect(d.lines.map((l) => l.text)).toEqual(["Nueva respuesta."]);
  });
  it("reveals sentences that are not being played (no voice, muted, error) after a short grace", () => {
    let d = addLine({ turn: 0, lines: [] }, 1, "Sin voz.", "", 0).dialog;
    expect(revealStale(d, 500, true).lines[0].started).toBe(false);
    expect(revealStale(d, 900, true).lines[0].started).toBe(true);
    // something is playing: wait for it... but never more than 15 s (a hung voice must not hide her words)
    expect(revealStale(d, 5000, false).lines[0].started).toBe(false);
    d = revealStale(d, 15_000, false);
    expect(d.lines[0].started).toBe(true);
  });
});

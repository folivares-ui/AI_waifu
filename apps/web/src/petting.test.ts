import { describe, expect, it } from "vitest";
import { REACTIONS, StrokeTracker, envelope, isSensitive } from "./petting";

describe("StrokeTracker", () => {
  it("needs real motion: hovering still never fires, a stroke does", () => {
    const s = new StrokeTracker(90, 2.5);
    for (let i = 0; i < 50; i++) expect(s.add("head", 0, i * 0.02)).toBeUndefined();
    let fired: string | undefined;
    for (let i = 0; i < 10 && !fired; i++) fired = s.add("head", 12, 1 + i * 0.02);
    expect(fired).toBe("head");
  });
  it("fades out if the motion is slow and spread out, and respects the cooldown", () => {
    const s = new StrokeTracker(90, 2.5);
    for (let i = 0; i < 20; i++) {
      s.decay(0.5);
      expect(s.add("cheeks", 10, i * 0.5)).toBeUndefined(); // 10 px every half second: never a stroke
    }
    expect(s.add("ears", 100, 1)).toBe("ears");
    expect(s.add("ears", 100, 2)).toBeUndefined(); // cooldown
    expect(s.active("ears")).toBe(true);
    expect(s.add("ears", 100, 3.6)).toBe("ears");
  });
});

describe("envelope", () => {
  it("rises, holds while stroking, then releases", () => {
    expect(envelope(0.09, 0, 0)).toBeCloseTo(0.5);
    expect(envelope(1, 0, 0)).toBe(1);
    expect(envelope(4, 0, 4)).toBe(1); // still being stroked
    expect(envelope(4.45, 0, 4)).toBeCloseTo(0.5);
    expect(envelope(6, 0, 4)).toBe(0);
  });
});

describe("reactions", () => {
  it("private areas are flustered (shrink back, no smile); head pats are blissful", () => {
    for (const r of ["chest", "belly", "hips", "legs", "tail"] as const) {
      expect(isSensitive(r)).toBe(true);
      expect(REACTIONS[r].shrink).toBe(true);
      expect(REACTIONS[r].rig.mouthSmile ?? 0).toBe(0);
      expect(REACTIONS[r].expr.happy ?? 0).toBe(0);
    }
    expect(isSensitive("head")).toBe(false);
    expect(REACTIONS.head.rig.eyeSmile).toBe(1);
    expect(REACTIONS.ears.earWiggle).toBe(true);
  });
});

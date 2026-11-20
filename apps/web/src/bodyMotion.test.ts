import { describe, expect, it } from "vitest";
import { bodyPose, EMOTION_POSES } from "./bodyMotion";

const at = (t: number, over: Partial<Parameters<typeof bodyPose>[0]> = {}) => bodyPose({ t, emotion: "neutral", speaking: false, level: 0, listening: false, ...over });

describe("body language", () => {
  it("is never frozen: arms sway and the weight shifts between the legs over time", () => {
    const a = at(1), b = at(4);
    expect(a.leftUpperArm).not.toEqual(b.leftUpperArm);
    const shifts = Array.from({ length: 40 }, (_, i) => at(i).hips![2]);
    expect(Math.max(...shifts)).toBeGreaterThan(0.015);
    expect(Math.min(...shifts)).toBeLessThan(-0.015);
  });
  it("symmetric poses mirror the right arm (same x, opposite y and z)", () => {
    const p = EMOTION_POSES.sad;
    expect(p.rightUpperArm).toEqual([p.leftUpperArm![0], -p.leftUpperArm![1], -p.leftUpperArm![2]]);
  });
  it("talking adds hand gestures that follow the loudness", () => {
    const quiet = at(2.1, { speaking: true, level: 0 });
    const loud = at(2.1, { speaking: true, level: 0.8 });
    const still = at(2.1);
    const bend = (p: ReturnType<typeof at>) => Math.abs(p.leftLowerArm![1]) + Math.abs(p.rightLowerArm![1]);
    expect(bend(quiet)).toBeGreaterThan(bend(still));
    expect(bend(loud)).toBeGreaterThan(bend(quiet));
  });
  it("uses the arm poses solved for the model when there are some", () => {
    const arms = { hips: { upper: [0.9, -0.6, -0.6] as [number, number, number], lower: -1.8 } };
    const p = at(0, { emotion: "angry", arms });
    expect(p.leftUpperArm![1]).toBeCloseTo(-0.6, 5);
    expect(p.rightLowerArm![1]).toBeGreaterThan(1.7); // mirrored elbow
    expect(at(0, { emotion: "angry" }).leftUpperArm![1]).toBeCloseTo(0, 5); // fixed table without a solution
  });
  it("angry = arms crossed when the model's crossing poses could be solved", () => {
    const arms = {
      crossFront: { upper: [-0.5, -1, -1.2] as [number, number, number], lower: -2.1 },
      crossBack: { upper: [-0.3, -0.9, -1.2] as [number, number, number], lower: -2.3 },
      hips: { upper: [0.9, -0.6, -0.6] as [number, number, number], lower: -1.8 },
    };
    const p = at(0, { emotion: "angry", arms });
    expect(p.leftLowerArm![1]).toBeLessThan(-1.9); // front forearm across the chest
    expect(p.rightUpperArm![1]).toBeCloseTo(0.9, 1); // the back arm, mirrored
    const noCross = at(0, { emotion: "angry", arms: { hips: arms.hips } });
    expect(noCross.leftUpperArm![1]).toBeCloseTo(-0.6, 1); // falls back to hands on the hips
  });
  it("a lively character (Rebecca's style) moves more, faster, bounces and fidgets", () => {
    const lively = { energy: 1.7, tempo: 1.35, bounce: 0.6, fidget: 0.75 };
    const range = (style: typeof lively | undefined, pick: (p: ReturnType<typeof at>) => number) => {
      const v = Array.from({ length: 300 }, (_, i) => pick(at(i * 0.1, { style })));
      return Math.max(...v) - Math.min(...v);
    };
    const arm = (p: ReturnType<typeof at>) => p.leftUpperArm![2];
    const knee = (p: ReturnType<typeof at>) => p.leftLowerLeg![0];
    const twist = (p: ReturnType<typeof at>) => p.spine![1];
    expect(range(lively, arm)).toBeGreaterThan(1.5 * range(undefined, arm));
    expect(range(lively, knee)).toBeGreaterThan(range(undefined, knee));
    expect(range(lively, twist)).toBeGreaterThan(0.05);
    expect(range(undefined, twist)).toBeLessThan(0.05);
    // fidgets: at some point a hand goes to the hip or the shoulders shrug, which the calm style never does
    const shrug = (p: ReturnType<typeof at>) => p.leftShoulder![2];
    expect(range(lively, shrug)).toBeGreaterThan(2 * range(undefined, shrug));
  });
});

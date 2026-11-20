import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import type { Euler3 } from "./bodyMotion";

/**
 * Arm poses that need the hands in a precise place (on the hips, at the chin, together in front...) depend on
 * each model's proportions, so they are solved per model when it loads: a small search moves the arm until the
 * hand reaches the target, measured with the model's own skeleton. Angles use the VRM 1.0 convention of
 * bodyMotion.ts (left arm; the right arm mirrors it).
 */
export interface ArmSolution {
  upper: Euler3;
  /** Elbow bend (lower arm y). */
  lower: number;
}
export type ArmTargets = "hips" | "together" | "chest" | "chin" | "across" | "crossFront" | "crossBack";
export type ArmSolutions = Partial<Record<ArmTargets, ArmSolution>>;

/** Starting points (found offline on two models of different proportions). */
const SEEDS: Record<ArmTargets, ArmSolution[]> = {
  hips: [{ upper: [1, -0.6, -0.5], lower: -2 }, { upper: [0.6, -0.8, -1], lower: -1.1 }],
  together: [{ upper: [0.6, -1, -0.5], lower: -1.55 }, { upper: [-0.3, -1, -1.4], lower: -0.5 }],
  chest: [{ upper: [-0.2, -0.4, -1.2], lower: -2.45 }, { upper: [0.2, -0.4, -0.6], lower: -2.15 }],
  chin: [{ upper: [-0.9, -1, -1], lower: -2.45 }, { upper: [-0.1, -1, -0.5], lower: -2.45 }],
  across: [{ upper: [0.2, -1, -1.2], lower: -1.7 }, { upper: [-0.1, -1, -1.4], lower: -0.95 }],
  crossFront: [{ upper: [-0.6, -1, -1.2], lower: -2.0 }, { upper: [-0.2, -0.9, -1.0], lower: -2.3 }],
  crossBack: [{ upper: [-0.4, -1, -1.25], lower: -2.2 }, { upper: [0, -0.9, -1.1], lower: -2.4 }],
};

/** Something that says how deep inside her body a point is (< 1 = inside), see torsoGuard.ts. */
export interface BodyShape {
  depth(world: THREE.Vector3): number;
  /** How far her body reaches forward (cm in front of the hips) at a height (cm above the hips). */
  frontAt?(heightCm: number): number | undefined;
}

export function solveArmPoses(vrm: VRM, body?: BodyShape, lift = 0): ArmSolutions {
  const H = vrm.humanoid;
  const k = vrm.meta.metaVersion === "0" ? -1 : 1;
  const N = (n: string) => H.getNormalizedBoneNode(n as never);
  const raw = (n: string) => H.getRawBoneNode(n as never);
  const need = ["hips", "head", "leftUpperArm", "leftLowerArm", "leftHand", "rightUpperArm"];
  if (need.some((n) => !raw(n)) || !N("leftUpperArm") || !N("leftLowerArm")) return {};
  const touched = ["leftUpperArm", "leftLowerArm", "rightUpperArm", "rightLowerArm", "leftShoulder", "rightShoulder", "spine", "chest", "hips"];
  const saved = touched.map((n) => [n, N(n)?.rotation.clone()] as const);
  for (const n of touched) N(n)?.rotation.set(0, 0, 0);

  const W = (n: string) => raw(n)!.getWorldPosition(new THREE.Vector3());
  const setArm = (u: Euler3, l: number) => {
    N("leftUpperArm")!.rotation.set(u[0] * k, u[1], u[2] * k + lift); // lift: A-pose models (restPose.ts)
    N("leftLowerArm")!.rotation.set(0, l, 0);
  };
  const measure = () => {
    H.update();
    vrm.scene.updateMatrixWorld(true);
    const hips = W("hips");
    // how far the arm goes into her body (0 = not at all), sampled along the upper arm and forearm
    let inside = 0;
    if (body) {
      const a = W("leftUpperArm"), e = W("leftLowerArm"), h = W("leftHand");
      for (const p of [a.clone().lerp(e, 0.6), e, e.clone().lerp(h, 0.33), e.clone().lerp(h, 0.66), h]) inside += Math.max(0, 1.05 - body.depth(p));
    }
    return { hand: W("leftHand").sub(hips).multiplyScalar(100), elbow: W("leftLowerArm").sub(hips).multiplyScalar(100), inside };
  };
  try {
    vrm.scene.updateMatrixWorld(true);
    const hips = W("hips");
    const headY = (W("head").y - hips.y) * 100;
    const headZ = (W("head").z - hips.z) * 100;
    const shoulderW = Math.abs(W("leftUpperArm").x - W("rightUpperArm").x) * 100;
    const hipW = shoulderW * 0.42;
    // Where the LEFT hand should be (cm from the hips; +x = her left, +z = in front of her).
    const goal: Record<ArmTargets, [number, number, number]> = {
      hips: [hipW, 4, 4],
      together: [4, headY * 0.05, 18],
      chest: [9, headY * 0.62, 14],
      chin: [0, headY - 9, headZ + 9],
      across: [-4, headY * 0.12, 14],
      // Arms crossed over the chest: one forearm in front, the other a little lower and closer to the body.
      // in front of her real chest/belly surface when it is known (bigger busts or bulky clothes need more room)
      crossFront: [-shoulderW * 0.36, headY * 0.58, Math.max(14, (body?.frontAt?.(headY * 0.58) ?? 0) + 8)],
      crossBack: [-shoulderW * 0.3, headY * 0.48, Math.max(8, (body?.frontAt?.(headY * 0.48) ?? 0) + 4)],
    };
    const out: ArmSolutions = {};
    for (const target of Object.keys(goal) as ArmTargets[]) {
      const g = goal[target];
      const cost = (s: ArmSolution) => {
        setArm(s.upper, s.lower);
        const m = measure();
        const elbowIn = Math.max(0, hipW * 0.7 - Math.abs(m.elbow.x)) + Math.max(0, -m.elbow.z - 6); // elbow never inside her
        const limits = Math.max(0, Math.abs(s.upper[0]) - 1.7) + Math.max(0, Math.abs(s.upper[1]) - 1.2) + Math.max(0, -s.lower - 2.6) + Math.max(0, s.lower);
        return Math.hypot(m.hand.x - g[0], m.hand.y - g[1], m.hand.z - g[2]) + 2 * elbowIn + 50 * limits + 40 * m.inside;
      };
      // Coordinate descent from each seed; keep the best.
      let best = { s: SEEDS[target][0], c: Infinity };
      for (const seed of SEEDS[target]) {
        let s: ArmSolution = { upper: [...seed.upper] as Euler3, lower: seed.lower };
        let c = cost(s);
        for (let step = 0.3; step > 0.02; step /= 2) {
          let improved = true;
          for (let it = 0; improved && it < 20; it++) {
            improved = false;
            for (let p = 0; p < 4; p++) {
              for (const dir of [1, -1]) {
                const t: ArmSolution = { upper: [...s.upper] as Euler3, lower: s.lower };
                if (p < 3) t.upper[p] += dir * step;
                else t.lower += dir * step;
                const tc = cost(t);
                if (tc < c - 0.05) {
                  s = t;
                  c = tc;
                  improved = true;
                }
              }
            }
          }
        }
        if (c < best.c) best = { s, c };
      }
      // Only use poses that really reach their target (within a few cm).
      if (best.c < 6) out[target] = { upper: best.s.upper.map((x) => +x.toFixed(3)) as Euler3, lower: +best.s.lower.toFixed(3) };
    }
    return out;
  } finally {
    for (const [n, r] of saved) if (r) N(n)!.rotation.copy(r);
    H.update();
    vrm.scene.updateMatrixWorld(true);
  }
}

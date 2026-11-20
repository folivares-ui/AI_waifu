import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

/**
 * Body poses are written for models whose rest pose is a T-pose (arms horizontal). Many models converted from
 * games rest in an A-pose (arms already ~45-60 degrees down); posing those as if they were in a T-pose sends
 * the arms down through the hips. This measures, per arm, the extra rotation of the normalized upper arm's z
 * that lifts it back to horizontal, so poses can add it (Euler XYZ: the z rotation is applied first, so adding
 * it to z is the same as "lift to T-pose, then pose").
 */
export function measureArmLift(vrm: VRM): { left: number; right: number } {
  const H = vrm.humanoid;
  const touched = ["leftShoulder", "rightShoulder", "leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm"];
  const saved = touched.map((n) => [n, H.getNormalizedBoneNode(n as never)?.rotation.clone()] as const);
  const out = { left: 0, right: 0 };
  try {
    for (const n of touched) H.getNormalizedBoneNode(n as never)?.rotation.set(0, 0, 0);
    for (const side of ["left", "right"] as const) {
      const up = H.getNormalizedBoneNode(`${side}UpperArm` as never);
      const a = H.getRawBoneNode(`${side}UpperArm` as never);
      const b = H.getRawBoneNode(`${side}LowerArm` as never);
      if (!up || !a || !b) continue;
      const down = (z: number) => {
        up.rotation.set(0, 0, z);
        H.update();
        vrm.scene.updateMatrixWorld(true);
        const d = b.getWorldPosition(new THREE.Vector3()).sub(a.getWorldPosition(new THREE.Vector3()));
        return Math.atan2(-d.y, Math.hypot(d.x, d.z)); // radians below horizontal
      };
      const rest = down(0);
      if (Math.abs(rest) < 0.12) continue; // already a T-pose (within ~7 degrees)
      // The sign that lifts this arm depends on the side and the VRM version: try both, keep the one that works.
      const plus = Math.abs(down(rest));
      const minus = Math.abs(down(-rest));
      out[side] = plus < minus ? rest : -rest;
      if (Math.abs(down(out[side])) > 0.12) out[side] = 0; // could not straighten it: leave the model as it is
    }
  } finally {
    for (const [n, r] of saved) if (r) H.getNormalizedBoneNode(n as never)!.rotation.copy(r);
    H.update();
    vrm.scene.updateMatrixWorld(true);
  }
  return out;
}

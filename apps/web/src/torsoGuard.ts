import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

/**
 * Keeps the arms out of the body. When the model loads, the real shape of her torso is measured from her own
 * mesh (for each height: how far it reaches to the left, right, front and back). Every frame, if an elbow,
 * forearm or hand would end up inside that shape, the arm is moved outwards just enough.
 */
interface Band {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

const STEP = 0.02; // 2 cm bands
const MARGIN = 1.08; // a little room for clothes and the arm's own thickness

export class TorsoGuard {
  private bands: (Band | undefined)[] = [];
  private y0 = 0;
  private hipsRestPos = new THREE.Vector3();
  private hipsRestQuatInv = new THREE.Quaternion();
  /** Current outward correction per arm (radians), eased so the arm never jumps. */
  private push = { left: 0, right: 0 };

  private constructor(private vrm: VRM) {}

  /** Must be called in the rest pose (before posing the arms). Returns undefined if the torso cannot be measured. */
  static measure(vrm: VRM): TorsoGuard | undefined {
    const H = vrm.humanoid;
    const raw = (n: string) => H.getRawBoneNode(n as never) ?? undefined;
    const hips = raw("hips");
    if (!hips) return undefined;
    vrm.scene.updateMatrixWorld(true);
    const g = new TorsoGuard(vrm);
    hips.getWorldPosition(g.hipsRestPos);
    g.hipsRestQuatInv.copy(hips.getWorldQuaternion(new THREE.Quaternion())).invert();

    // Skin that belongs to the torso: not arms, head (hair), or legs below the thigh.
    const excluded = new Set<THREE.Object3D>();
    for (const n of ["leftShoulder", "rightShoulder", "leftUpperArm", "rightUpperArm", "head", "leftLowerLeg", "rightLowerLeg"]) {
      raw(n)?.traverse((o) => excluded.add(o));
    }
    const top = (raw("neck") ?? raw("head"))?.getWorldPosition(new THREE.Vector3()).y ?? g.hipsRestPos.y + 0.5;
    g.y0 = g.hipsRestPos.y - 0.3;
    const count = Math.ceil((top - g.y0) / STEP);
    const bands: (Band | undefined)[] = Array.from({ length: count }, () => undefined);
    const v = new THREE.Vector3();
    let used = 0;
    vrm.scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isSkinnedMesh || !m.visible) return;
      m.skeleton.update();
      const pos = m.geometry.attributes.position;
      const si = m.geometry.attributes.skinIndex;
      const sw = m.geometry.attributes.skinWeight;
      for (let i = 0; i < pos.count; i++) {
        // dominant bone of this vertex
        let best = 0;
        for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
        const bone = m.skeleton.bones[si.getComponent(i, best)];
        if (!bone || excluded.has(bone)) continue;
        m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
        const b = Math.floor((v.y - g.y0) / STEP);
        if (b < 0 || b >= count) continue;
        v.sub(g.hipsRestPos);
        const band = (bands[b] ??= { minX: 0, maxX: 0, minZ: 0, maxZ: 0 });
        band.minX = Math.min(band.minX, v.x);
        band.maxX = Math.max(band.maxX, v.x);
        band.minZ = Math.min(band.minZ, v.z);
        band.maxZ = Math.max(band.maxZ, v.z);
        used++;
      }
    });
    if (used < 50) return undefined;
    g.bands = bands;
    return g;
  }

  private tmpQ = new THREE.Quaternion();

  /** Point in the body's own frame (follows the hips when she sways or turns). */
  private toBody(world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const hips = this.vrm.humanoid.getRawBoneNode("hips" as never)!;
    const now = hips.getWorldPosition(new THREE.Vector3());
    // rotation since the rest pose
    this.tmpQ.copy(hips.getWorldQuaternion(new THREE.Quaternion())).multiply(this.hipsRestQuatInv).invert();
    return out.copy(world).sub(now).applyQuaternion(this.tmpQ);
  }

  /** How deep inside the torso a point is: < 1 means inside (1 = on the surface). */
  depth(world: THREE.Vector3): number {
    const p = this.toBody(world, new THREE.Vector3());
    const b = this.bands[Math.floor((p.y + this.hipsRestPos.y - this.y0) / STEP)];
    if (!b) return Infinity;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const rx = (Math.max(0.01, (b.maxX - b.minX) / 2) * MARGIN);
    const rz = (Math.max(0.01, (b.maxZ - b.minZ) / 2) * MARGIN);
    return Math.hypot((p.x - cx) / rx, (p.z - cz) / rz);
  }

  /** Points along one arm that must stay outside the torso. */
  private armPoints(side: "left" | "right"): THREE.Vector3[] {
    const H = this.vrm.humanoid;
    const up = H.getRawBoneNode(`${side}UpperArm` as never);
    const low = H.getRawBoneNode(`${side}LowerArm` as never);
    const hand = H.getRawBoneNode(`${side}Hand` as never);
    if (!up || !low || !hand) return [];
    const a = up.getWorldPosition(new THREE.Vector3());
    const e = low.getWorldPosition(new THREE.Vector3());
    const h = hand.getWorldPosition(new THREE.Vector3());
    return [a.clone().lerp(e, 0.6), e, e.clone().lerp(h, 0.5), h];
  }

  /** How far her body reaches forward (cm in front of the hips) at a height (cm above the hips), or undefined. */
  frontAt(heightCm: number): number | undefined {
    const b = this.bands[Math.floor((heightCm / 100 + this.hipsRestPos.y - this.y0) / STEP)];
    return b ? b.maxZ * MARGIN * 100 : undefined;
  }

  /** Closest any arm point gets to the inside of the torso (< 1 = inside). For tests. */
  minDepth(): number {
    return Math.min(...(["left", "right"] as const).flatMap((s) => this.armPoints(s).map((p) => this.depth(p))));
  }

  /**
   * Moves the arms out of the body if needed. Call after the pose is applied (normalized bones set and
   * vrm.update run). `outward(side)` gives the sign that raises that arm sideways on the normalized bone's z.
   * Returns how many corrections were needed (for tests).
   */
  apply(dt: number, outward: { left: number; right: number }): number {
    const H = this.vrm.humanoid;
    let fixes = 0;
    for (const side of ["left", "right"] as const) {
      const bone = H.getNormalizedBoneNode(`${side}UpperArm` as never);
      if (!bone) continue;
      const base = bone.rotation.z;
      // Ease the previous correction back towards zero, then add what is needed now.
      this.push[side] = Math.max(0, this.push[side] - dt * 0.6);
      for (let i = 0; i < 8; i++) {
        bone.rotation.z = base + this.push[side] * outward[side];
        H.update();
        H.getRawBoneNode(`${side}Shoulder` as never)?.updateMatrixWorld(true);
        H.getRawBoneNode(`${side}UpperArm` as never)?.updateMatrixWorld(true);
        const inside = this.armPoints(side).some((p) => this.depth(p) < 1);
        if (!inside) break;
        this.push[side] = Math.min(0.9, this.push[side] + 0.05);
        fixes++;
      }
    }
    return fixes;
  }
}

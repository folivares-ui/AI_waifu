import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { VRM } from "@pixiv/three-vrm";
import { hideHelperMeshes } from "./avatarFixups";
import { BoneFaceRig } from "./boneFace";

/** A tiny fake model: head (optionally rotated) with a few facial bones named like a Sketchfab export. */
function fakeVrm(opts: { headRotY?: number; expressions?: Record<string, unknown>; bones?: string[] } = {}) {
  const scene = new THREE.Group();
  const head = new THREE.Bone();
  head.name = "Head_0106";
  head.rotation.y = opts.headRotY ?? 0;
  scene.add(head);
  const names = opts.bones ?? ["Eye_up_01_L_0146", "Eye_bottom_01_L_0112", "Eye_up_01_L_end_0511", "Mouth_L_0192", "Mouth_R_0199", "Ear_01_L_0224", "Eyebrow_01_L_0167", "Nose_0218"];
  const bones = Object.fromEntries(
    names.map((n, i) => {
      const b = new THREE.Bone();
      b.name = n;
      b.position.set(0.01 * i, 0.05, 0.08);
      head.add(b);
      return [n, b];
    }),
  );
  const vrm = {
    scene,
    humanoid: { getRawBoneNode: (n: string) => (n === "head" ? head : null) },
    expressionManager: { expressionMap: opts.expressions ?? {} },
  } as unknown as VRM;
  return { vrm, head, bones };
}

describe("BoneFaceRig", () => {
  it("is not used when the model has its own expressions", () => {
    expect(BoneFaceRig.detect(fakeVrm({ expressions: { blink: {}, aa: {} } }).vrm)).toBeUndefined();
  });
  it("is not used when no known facial bones exist", () => {
    expect(BoneFaceRig.detect(fakeVrm({ bones: ["Hat_0001", "Hair_0002"] }).vrm)).toBeUndefined();
  });
  it("detects channels from bone names with exporter suffixes and ignores *_end bones", () => {
    const { vrm, bones } = fakeVrm();
    const rig = BoneFaceRig.detect(vrm)!;
    expect(rig.channels.has("blink")).toBe(true);
    expect(rig.channels.has("mouthSmile")).toBe(true);
    expect(rig.channels.has("earsDroop")).toBe(true);
    const end = bones["Eye_up_01_L_end_0511"].position.clone();
    rig.apply({ blink: 1 });
    expect(bones["Eye_up_01_L_end_0511"].position.equals(end)).toBe(true);
    expect(bones["Nose_0218"].position.y).toBeCloseTo(0.05); // unrelated bones untouched
  });
  it("moves the upper lid down 26 mm in WORLD space even when the head is rotated, and restores at zero", () => {
    const { vrm, bones } = fakeVrm({ headRotY: 1.1 });
    const rig = BoneFaceRig.detect(vrm)!;
    const lid = bones["Eye_up_01_L_0146"];
    const rest = lid.getWorldPosition(new THREE.Vector3());
    rig.apply({ blink: 1 });
    vrm.scene.updateMatrixWorld(true);
    const closed = lid.getWorldPosition(new THREE.Vector3());
    expect(closed.y - rest.y).toBeCloseTo(-0.026, 5);
    expect(closed.x - rest.x).toBeCloseTo(0, 5);
    expect(closed.z - rest.z).toBeCloseTo(0, 5);
    rig.apply({ blink: 0.5 });
    vrm.scene.updateMatrixWorld(true);
    expect(lid.getWorldPosition(new THREE.Vector3()).y - rest.y).toBeCloseTo(-0.013, 5);
    rig.apply({});
    vrm.scene.updateMatrixWorld(true);
    expect(lid.getWorldPosition(new THREE.Vector3()).distanceTo(rest)).toBeLessThan(1e-9);
  });
  it("adds up channels that share a bone (smile + narrow on the mouth corner) and mirrors left/right", () => {
    const { vrm, bones } = fakeVrm();
    const rig = BoneFaceRig.detect(vrm)!;
    const l = bones["Mouth_L_0192"];
    const r = bones["Mouth_R_0199"];
    const l0 = l.position.clone();
    const r0 = r.position.clone();
    rig.apply({ mouthSmile: 1 });
    expect(l.position.x - l0.x).toBeCloseTo(0.003, 6);
    expect(r.position.x - r0.x).toBeCloseTo(-0.003, 6);
    expect(l.position.y - l0.y).toBeCloseTo(0.003, 6);
    rig.apply({ mouthSmile: 1, mouthNarrow: 1 });
    expect(l.position.x - l0.x).toBeCloseTo(0.0005, 6);
  });
  it("rotates ears and returns exactly to rest", () => {
    const { vrm, bones } = fakeVrm();
    const rig = BoneFaceRig.detect(vrm)!;
    const ear = bones["Ear_01_L_0224"];
    const rest = ear.quaternion.clone();
    rig.apply({ earsDroop: 1 });
    expect(ear.quaternion.angleTo(rest)).toBeCloseTo(0.6, 5);
    rig.apply({ earsDroop: 0.5 });
    expect(ear.quaternion.angleTo(rest)).toBeCloseTo(0.3, 5);
    rig.apply({});
    expect(ear.quaternion.angleTo(rest)).toBeLessThan(1e-9);
  });
});

describe("hideHelperMeshes", () => {
  const mesh = (name: string, verts: number, map: THREE.Texture | null) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
    const m = new THREE.MeshStandardMaterial({ map });
    m.name = name;
    return new THREE.Mesh(g, m);
  };
  it("hides exact duplicates and small untextured overlays, keeps everything else", () => {
    const body = new THREE.Texture();
    const face = new THREE.Texture();
    const scene = new THREE.Group();
    const a = mesh("body", 5000, body);
    const dup = mesh("body.001", 5000, body);
    const shadow = mesh("face_shadow", 44, null);
    const realFace = mesh("face", 1700, face);
    const brow = mesh("brow", 22, face); // tiny but textured: must stay
    scene.add(a, dup, shadow, realFace, brow);
    const hidden = hideHelperMeshes({ scene } as unknown as VRM);
    expect([a.visible, dup.visible, shadow.visible, realFace.visible, brow.visible]).toEqual([true, false, false, true, true]);
    expect(hidden).toHaveLength(2);
  });
  it("does not hide untextured meshes in a model that is mostly untextured", () => {
    const scene = new THREE.Group();
    const parts = [mesh("a", 100, null), mesh("b", 200, null), mesh("c", 300, null), mesh("d", 400, new THREE.Texture())];
    scene.add(...parts);
    hideHelperMeshes({ scene } as unknown as VRM);
    expect(parts.every((p) => p.visible)).toBe(true);
  });
});

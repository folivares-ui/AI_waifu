import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { geometryMovesF } from "./boneFace";

/** A tiny face with the "F_L_EyelidTop" family: upper lid hangs from the lower one, brows are a chain. */
function face() {
  const head = new THREE.Object3D();
  head.name = "Head_051";
  const node = (name: string, worldMm: [number, number, number], parent: THREE.Object3D, parentWorldMm: [number, number, number] = [0, 0, 0]) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set((worldMm[0] - parentWorldMm[0]) / 1000, (worldMm[1] - parentWorldMm[1]) / 1000, (worldMm[2] - parentWorldMm[2]) / 1000);
    parent.add(o);
    return o;
  };
  const bottom = node("F_L_EyelidBottom_063", [44, 27, 83], head);
  node("F_L_EyelidTop_064", [47, 50, 87], bottom, [44, 27, 83]);
  const b1 = node("F_L_EyeBrows1_071", [17, 43, 102], head);
  const b2 = node("F_L_EyeBrows2_072", [44, 61, 97], b1, [17, 43, 102]);
  node("F_L_EyeBrows3_073", [74, 77, 80], b2, [44, 61, 97]);
  node("F_L_MouthCorners_068", [40, -3, 91], head);
  const jaw = node("F_C_Jaw_078", [0, -14, 4], head);
  node("F_C_MouthBottom_085", [3, -18.5, 95.6], jaw, [0, -14, 4]);
  const nodes: THREE.Object3D[] = [];
  head.traverse((o) => nodes.push(o));
  return { head, nodes };
}

describe("face rig family 3 (F_L_EyelidTop...)", () => {
  it("closes the eye even though the upper lid hangs from the lower one", () => {
    const { head, nodes } = face();
    const moves = geometryMovesF(head, nodes);
    const own = (ch: string, name: string) => (moves.find((m) => m.channel === ch && m.node.name.startsWith(name)) as { mm: number[] }).mm;
    const gap = 23;
    // world: top -0.85*gap, bottom +0.1*gap -> top's own share removes the parent's
    expect(own("blink", "F_L_EyelidBottom")[1]).toBeCloseTo(0.1 * gap, 5);
    expect(own("blink", "F_L_EyelidTop")[1]).toBeCloseTo(-0.85 * gap - 0.1 * gap, 5);
  });
  it("brow chain: angry lowers the inner end and raises the outer end in world space", () => {
    const { head, nodes } = face();
    const moves = geometryMovesF(head, nodes);
    const own = (name: string) => (moves.find((m) => m.channel === "browAngry" && m.node.name.startsWith(name)) as { mm: number[] }).mm[1];
    const world1 = own("F_L_EyeBrows1");
    const world3 = world1 + own("F_L_EyeBrows2") + own("F_L_EyeBrows3");
    expect(world1).toBeLessThan(0);
    expect(world3).toBeGreaterThan(0);
  });
  it("opens the mouth by rotating the jaw", () => {
    const { head, nodes } = face();
    const jaw = geometryMovesF(head, nodes).find((m) => m.channel === "mouthOpen") as { rot: number[] };
    expect(jaw.rot[0]).toBeGreaterThan(0.08);
    expect(jaw.rot[0]).toBeLessThan(0.15);
  });
  it("annoyed look: inner brows pulled towards the nose and narrowed eyes", () => {
    const { head, nodes } = face();
    const moves = geometryMovesF(head, nodes);
    const own = (ch: string, name: string) => (moves.find((m) => m.channel === ch && m.node.name.startsWith(name)) as { mm: number[] } | undefined)?.mm;
    expect(own("browFurrow", "F_L_EyeBrows1")![0]).toBeLessThan(0); // left brow moves right, towards the nose
    expect(own("squint", "F_L_EyelidTop")![1]).toBeLessThan(0);
    expect(own("squint", "F_L_EyelidBottom")![1]).toBeGreaterThan(0);
  });
});

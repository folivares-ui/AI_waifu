import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { geometryMoves } from "./boneFace";

/** A tiny face with the "LT eyelid A" naming family (positions in metres, head at the origin). */
function face() {
  const head = new THREE.Object3D();
  head.name = "head_86";
  const add = (name: string, x: number, y: number, z: number, parent = head) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(x / 1000, y / 1000, z / 1000);
    parent.add(o);
    return o;
  };
  add("LI_eyelid_11", 22, 41, 98);
  add("LO_eyelid_16", 72, 51, 75);
  add("LT_eyelid_A_12", 26, 45, 100);
  add("LT_eyelid_C_14", 47, 50, 95);
  add("LU_eyelid_A_17", 29, 34.5, 95);
  add("LU_eyelid_C_19", 52, 35.4, 86);
  add("L_browskin_A_2", 13, 53, 111);
  add("L_browskin_E_10", 71, 84, 80);
  add("LT_lip_A_53", 10, -15, 112);
  add("LT_lip_D_56", 28, -16, 99);
  const jaw = add("jaw_A_72", 0, 0, 10);
  add("U_lip_62", 3.6, -20.6, 99.6, jaw);
  return { head, nodes: [] as THREE.Object3D[] };
}

describe("face rig computed from the model's geometry", () => {
  it("blink brings each upper-lid bone down to the lower lid below it; corners move most when smiling", () => {
    const { head } = face();
    const nodes: THREE.Object3D[] = [];
    head.traverse((o) => nodes.push(o));
    const moves = geometryMoves(head, nodes);
    const mm = (ch: string, name: string) => (moves.find((m) => m.channel === ch && m.node.name === name) as { mm: number[] } | undefined)?.mm;
    // LT_eyelid_C at y=50 over a lower lid at ~35 there: travels ~88% of the 15 mm gap.
    expect(mm("blink", "LT_eyelid_C_14")![1]).toBeCloseTo(-0.88 * (50 - (34.5 + ((47 - 29) / (52 - 29)) * (35.4 - 34.5))), 1);
    expect(mm("blink", "LU_eyelid_A_17")![1]).toBeGreaterThan(0);
    // Brows: inner and outer go opposite ways when angry/sad.
    expect(mm("browAngry", "L_browskin_A_2")![1]).toBeLessThan(0);
    expect(mm("browAngry", "L_browskin_E_10")![1]).toBeGreaterThan(0);
    expect(mm("browSad", "L_browskin_A_2")![1]).toBeGreaterThan(0);
    // Smile: the corner rises much more than the lip centre.
    expect(mm("mouthSmile", "LT_lip_D_56")![1]).toBeGreaterThan(5 * mm("mouthSmile", "LT_lip_A_53")![1]);
    // Mouth: the jaw rotates (opening, chin down).
    const jaw = moves.find((m) => m.channel === "mouthOpen") as { rot: number[]; node: THREE.Object3D };
    expect(jaw.node.name).toBe("jaw_A_72");
    expect(jaw.rot[0]).toBeGreaterThan(0.05);
    expect(jaw.rot[0]).toBeLessThan(0.2);
  });
  it("returns nothing for faces without these bones", () => {
    const head = new THREE.Object3D();
    expect(geometryMoves(head, [head])).toEqual([]);
  });
});

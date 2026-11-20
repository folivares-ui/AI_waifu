import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { geometryMovesFacial } from "./boneFace";
import { buildFaceMorphs, SynthFace, type FaceMeshIn, type V3 } from "./synthFace";

/** Bones of the "Facial_*" family (eyebrows A/B/C, mouth L/M/R, cheeks), positions in mm from the head. */
function rig() {
  const head = new THREE.Object3D();
  head.name = "Head_059";
  const node = (name: string, mm: V3) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(mm[0] / 1000, mm[1] / 1000, mm[2] / 1000);
    head.add(o);
  };
  node("Facial_Elbow_A_01_L_064", [14, 96, 0]);
  node("Facial_Elbow_B_01_L_066", [26, 99, -3]);
  node("Facial_Elbow_C_01_L_068", [39, 94, -6]);
  node("Facial_Mouth_A_01_L_079", [14, 49, 35]);
  node("Facial_Mouth_A_01_M_080", [0, 51, 39]);
  node("Facial_Mouth_A_01_R_081", [-14, 49, 35]);
  node("Facial_Cheek_A_01_L_062", [33, 61, 20]);
  const nodes: THREE.Object3D[] = [];
  head.traverse((o) => nodes.push(o));
  return { head, nodes };
}

describe("face rig family 4 (Facial_Elbow / Facial_Mouth bones)", () => {
  const { head, nodes } = rig();
  const moves = geometryMovesFacial(head, nodes);
  const mm = (ch: string, name: string) => (moves.find((m) => m.channel === ch && m.node.name.startsWith(name)) as { mm: number[] } | undefined)?.mm;

  it("angry brows: inner end down and towards the nose, outer end up", () => {
    expect(mm("browAngry", "Facial_Elbow_A_01_L")![1]).toBeLessThan(-2);
    expect(mm("browAngry", "Facial_Elbow_C_01_L")![1]).toBeGreaterThan(1);
    expect(mm("browFurrow", "Facial_Elbow_A_01_L")![0]).toBeLessThan(0); // left brow (+x) moves towards x = 0
  });
  it("smile lifts the corners outwards, whichever side they are on", () => {
    expect(mm("mouthSmile", "Facial_Mouth_A_01_L")![0]).toBeGreaterThan(0);
    expect(mm("mouthSmile", "Facial_Mouth_A_01_R")![0]).toBeLessThan(0);
    expect(mm("mouthSmile", "Facial_Mouth_A_01_L")![1]).toBeGreaterThan(0);
    expect(mm("mouthPout", "Facial_Mouth_A_01_M")![2]).toBeGreaterThan(0);
  });
});

// ---------- synthesized lids and jaw on a tiny flat face ----------

/** A flat face (z = 30 mm, 2 mm grid) with an eye hole and a mouth slit, an eyeball behind and a lash strip. */
function flatFace() {
  const S = 0.002;
  const face: number[] = [];
  const idx: number[] = [];
  const n = 41; // -40..40 mm
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) face.push(-0.04 + i * S, -0.04 + j * S, 0.03);
  const eyeHole = (x: number, y: number) => ((x - 0.02) / 0.012) ** 2 + ((y - 0.015) / 0.008) ** 2 < 1;
  const slit = (x: number, y: number) => Math.abs(y + 0.021) < 0.0005 && Math.abs(x) < 0.014;
  const at = (i: number, j: number) => [face[(j * n + i) * 3], face[(j * n + i) * 3 + 1]] as const;
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const quad = [j * n + i, j * n + i + 1, (j + 1) * n + i + 1, (j + 1) * n + i];
      const pts = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
      if (pts.some(([x, y]) => eyeHole(x, y))) continue;
      // the slit: one row of quads missing between the lips (y -22..-20 mm)
      if (slit((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[2][1]) / 2)) continue;
      idx.push(quad[0], quad[1], quad[2], quad[0], quad[2], quad[3]);
    }
  }
  // eyeball: a disc 3 mm behind the skin
  const ball: number[] = [];
  const bidx: number[] = [];
  for (let j = 0; j <= 12; j++) for (let i = 0; i <= 16; i++) ball.push(0.0045 + i * 0.002, 0.003 + j * 0.002, 0.027);
  for (let j = 0; j < 12; j++) for (let i = 0; i < 16; i++) {
    const a = j * 17 + i;
    bidx.push(a, a + 1, a + 18, a, a + 18, a + 17);
  }
  // lash strip over the top of the opening, just in front of the skin
  const lash: number[] = [];
  const lidx: number[] = [];
  for (let i = 0; i <= 10; i++) {
    const x = 0.01 + i * 0.002;
    const top = 0.015 + 0.008 * Math.sqrt(Math.max(0, 1 - ((x - 0.02) / 0.012) ** 2));
    lash.push(x, top - 0.001, 0.0305, x, top + 0.002, 0.0305);
  }
  for (let i = 0; i < 10; i++) lidx.push(i * 2, i * 2 + 2, i * 2 + 3, i * 2, i * 2 + 3, i * 2 + 1);
  const mesh = (p: number[], ix: number[]): FaceMeshIn => ({ pos: new Float32Array(p), index: ix, onHead: new Uint8Array(p.length / 3).fill(1) });
  return [mesh(face, idx), mesh(ball, bidx), mesh(lash, lidx)];
}

describe("synthesized lids and jaw (models without eyelid or jaw bones)", () => {
  const meshes = flatFace();
  const res = buildFaceMorphs(meshes, [[0.02, 0.015, 0.02]], [[-0.014, -0.02, 0.03], [0.014, -0.02, 0.03]])!;
  const vertex = (m: FaceMeshIn, x: number, y: number) => {
    let best = 0;
    for (let i = 1; i < m.pos.length / 3; i++) {
      const d = Math.hypot(m.pos[i * 3] - x, m.pos[i * 3 + 1] - y);
      if (d < Math.hypot(m.pos[best * 3] - x, m.pos[best * 3 + 1] - y)) best = i;
    }
    return best;
  };

  it("finds the eye opening and the mouth", () => {
    expect(res.info.eyes).toBe(1);
    expect(res.info.gap[0]).toBeGreaterThan(0.012);
    expect(res.info.gap[0]).toBeLessThan(0.02);
    expect(res.info.mouthWidth).toBeGreaterThan(0.02);
  });
  it("the upper lid closes down to the lower one and the eyeball itself never moves", () => {
    const rim = vertex(meshes[0], 0.02, 0.024); // first skin vertex above the opening, in the middle
    const dy = res.upper[0]![rim * 3 + 1];
    expect(dy).toBeLessThan(-0.012);
    expect(res.upper[1]?.some((v) => v !== 0) ?? false).toBe(false);
    // far above the eye nothing moves
    expect(res.upper[0]![vertex(meshes[0], 0.02, 0.038) * 3 + 1]).toBe(0);
  });
  it("lashes come down with the lid and stay in front of the eyeball", () => {
    const d = res.upper[2]!;
    const i = 10; // lower edge of the strip, middle
    expect(d[i * 3 + 1]).toBeLessThan(-0.01);
    expect(meshes[2].pos[i * 3 + 2] + d[i * 3 + 2]).toBeGreaterThan(0.027);
  });
  it("opening the mouth drops the lower lip, not the upper one", () => {
    const lower = vertex(meshes[0], 0, -0.022); // lower edge of the slit
    const upper = vertex(meshes[0], 0, -0.02); // upper edge
    expect(res.mouth[0]![lower * 3 + 1]).toBeLessThan(-0.005);
    expect(res.mouth[0]![upper * 3 + 1]).toBe(0);
    // the corners stay closed
    expect(Math.abs(res.mouth[0]![vertex(meshes[0], 0.016, -0.022) * 3 + 1])).toBeLessThan(0.003);
  });
  it("lid travel never goes past closed, whatever channels are combined", () => {
    const { upper, lower } = SynthFace.lids({ blink: 1, squint: 1, eyeSmile: 1 });
    expect(upper + lower).toBeLessThanOrEqual(1.06 + 1e-9);
    const open = SynthFace.lids({});
    expect(open.upper).toBe(0);
    expect(open.lower).toBe(0);
  });
});

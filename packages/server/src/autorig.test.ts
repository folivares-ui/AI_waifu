import { describe, expect, it } from "vitest";
import { autoRig, needsRig, type RigGltf } from "./autorig.js";
import { brokenRig, fixVrm, readGlb, worldMatrices, writeGlb } from "./vrmfix.js";

/** A statue made of boxes (1.6 m, facing +z, arms in an A-pose), with no skeleton, as a VRM 1.0 file. */
function statue() {
  const H = 1.6;
  const pos: number[] = [];
  const idx: number[] = [];
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    const b = pos.length / 3;
    for (const z of [z0, z1]) for (const y of [y0, y1]) for (const x of [x0, x1]) pos.push(x * H, y * H, z * H);
    for (const f of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) idx.push(b + f[0], b + f[1], b + f[2], b + f[0], b + f[2], b + f[3]);
  };
  // arms as a chain of small boxes sloping down from the shoulders (A-pose)
  const arm = (side: number) => {
    for (let k = 0; k < 14; k++) {
      const x = 0.1 + k * 0.025;
      const y = 0.79 - k * 0.012;
      box(side > 0 ? x : -x - 0.026, side > 0 ? x + 0.026 : -x, y - 0.02, y + 0.02, -0.02, 0.02);
    }
  };
  box(0.01, 0.07, 0, 0.47, -0.03, 0.03); // left leg (+x)
  box(-0.07, -0.01, 0, 0.47, -0.03, 0.03);
  box(0.01, 0.07, 0, 0.02, 0.03, 0.08); // feet (forward)
  box(-0.07, -0.01, 0, 0.02, 0.03, 0.08);
  box(-0.09, 0.09, 0.47, 0.82, -0.05, 0.05); // torso
  box(-0.06, 0.06, 0.84, 1.0, -0.06, 0.06); // head
  // long hair behind: strands of small boxes, down to mid-back
  for (let x = -0.07; x <= 0.071; x += 0.02) for (let y = 0.6; y < 0.99; y += 0.05) box(x, x + 0.015, y, y + 0.05, -0.09, -0.065);
  arm(1);
  arm(-1);
  const posBuf = Buffer.alloc(pos.length * 4);
  pos.forEach((v, i) => posBuf.writeFloatLE(v, i * 4));
  const idxBuf = Buffer.alloc(idx.length * 4);
  idx.forEach((v, i) => idxBuf.writeUInt32LE(v, i * 4));
  const data = Buffer.concat([posBuf, idxBuf]);
  const json = {
    asset: { version: "2.0" },
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "root", children: [1] }, { name: "statue", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: data.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBuf.length },
      { buffer: 0, byteOffset: posBuf.length, byteLength: idxBuf.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min: [-0.6, 0, -0.2], max: [0.6, 1.6, 0.2] },
      { bufferView: 1, componentType: 5125, count: idx.length, type: "SCALAR" },
    ],
    extensions: { VRMC_vrm: { specVersion: "1.0", humanoid: { humanBones: {} } } },
  };
  const header = Buffer.alloc(8);
  header.writeUInt32LE(data.length, 0);
  header.write("BIN\0", 4, "latin1");
  return { glb: writeGlb(json, Buffer.concat([header, data])), json, pos, H };
}

describe("rigging a model that has no skeleton", () => {
  it("is detected, rigged and given the humanoid bones when the file is repaired", () => {
    const { glb, json } = statue();
    expect(needsRig(json as unknown as RigGltf)).toBe(true);
    const r = fixVrm(glb)!;
    expect(r.rigged).toBe(true);
    const back = readGlb(r.fixed).json;
    const bones = back.extensions!.VRMC_vrm!.humanoid!.humanBones!;
    for (const b of ["hips", "spine", "head", "leftUpperArm", "leftLowerArm", "leftHand", "rightHand", "leftUpperLeg", "leftLowerLeg", "leftFoot", "rightFoot"]) expect(bones[b]).toBeDefined();
    expect(fixVrm(r.fixed)).toBeUndefined(); // nothing left to do
    // long hair gets chains of bones (for the app's hair physics), which are not humanoid bones
    const names = (back.nodes as { name?: string }[]).map((n) => n.name ?? "");
    expect(names.filter((n) => /^rig_hair_\d+_0$/.test(n)).length).toBeGreaterThan(0);
    expect(Object.keys(bones).some((b) => b.startsWith("rig_") || b.startsWith("hair"))).toBe(false);
  });

  it("places the joints where the body is and skins each part to its bones", () => {
    const { json, glb, pos, H } = statue();
    const { bin } = readGlb(glb);
    const r = autoRig(JSON.parse(JSON.stringify(json)) as RigGltf, bin!);
    const J = r.joints;
    expect(J.hips[1] / H).toBeGreaterThan(0.45);
    expect(J.hips[1] / H).toBeLessThan(0.58);
    expect(J.leftUpperArm[0]).toBeGreaterThan(0); // her left is +x (she faces +z)
    expect(J.leftHand[0] / H).toBeGreaterThan(0.35);
    expect(J.leftFoot[1] / H).toBeLessThan(0.08);
    expect(J.head[1]).toBeGreaterThan(J.neck[1]);
    // weights: read back JOINTS_0 / WEIGHTS_0 and check a few vertices
    const prim = r.json.meshes![0].primitives[0];
    const read = (acc: number, size: number, n: number, float: boolean) => {
      const a = r.json.accessors![acc];
      const bv = r.json.bufferViews![a.bufferView!];
      return (i: number, k: number) => (float ? r.bin.readFloatLE(8 + bv.byteOffset! + (i * n + k) * size) : r.bin.readUInt16LE(8 + bv.byteOffset! + (i * n + k) * size));
    };
    const jt = read(prim.attributes.JOINTS_0, 2, 4, false);
    const wt = read(prim.attributes.WEIGHTS_0, 4, 4, true);
    const joints = r.json.skins![0].joints;
    const main = (i: number) => {
      let best = 0;
      for (let k = 1; k < 4; k++) if (wt(i, k) > wt(i, best)) best = k;
      const node = joints[jt(i, best)];
      return Object.entries(r.humanBones).find(([, n]) => n === node)![0];
    };
    const near = (x: number, y: number, z: number) => {
      let best = 0;
      for (let i = 1; i < pos.length / 3; i++) if (Math.hypot(pos[i * 3] - x, pos[i * 3 + 1] - y, pos[i * 3 + 2] - z) < Math.hypot(pos[best * 3] - x, pos[best * 3 + 1] - y, pos[best * 3 + 2] - z)) best = i;
      return best;
    };
    expect(main(near(0.47 * H, 0.63 * H, 0))).toBe("leftHand");
    expect(main(near(-0.47 * H, 0.63 * H, 0))).toBe("rightHand");
    expect(main(near(0.07 * H, 0.0, 0.08 * H))).toBe("leftFoot");
    expect(main(near(0.0, 1.0 * H, 0.06 * H))).toBe("head");
    expect(main(near(0.08 * H, 0.99 * H, -0.09 * H))).toBe("head"); // hair follows the head
    expect(["chest", "upperChest", "neck", "leftShoulder"]).toContain(main(near(0.09 * H, 0.82 * H, 0.05 * H))); // torso (a box corner at the shoulders)
    // weights add up to 1
    for (let i = 0; i < pos.length / 3; i += 37) expect(wt(i, 0) + wt(i, 1) + wt(i, 2) + wt(i, 3)).toBeCloseTo(1, 5);
  });
  it("takes off a skeleton that does not fit the body and rigs the model again", () => {
    const { glb, H } = statue();
    const good = fixVrm(glb)!.fixed;
    const { json, bin } = readGlb(good);
    const hb = json.extensions!.VRMC_vrm!.humanoid!.humanBones!;
    expect(brokenRig(json, bin!)).toBe(false);
    const headY = worldMatrices(json)[hb.head.node][13];
    // as an online auto-rigger can leave it: the head joint down at the chest, an elbow far behind the shoulder
    const nodes = json.nodes as { translation?: number[] }[];
    nodes[hb.head.node].translation![1] -= 0.3 * H;
    nodes[hb.leftLowerArm.node].translation![2] -= 0.3 * H;
    const broken = writeGlb(json, bin!);
    expect(brokenRig(readGlb(broken).json, readGlb(broken).bin!)).toBe(true);
    const r = fixVrm(broken)!;
    expect(r.rigged).toBe(true);
    const back = readGlb(r.fixed).json;
    const hb2 = back.extensions!.VRMC_vrm!.humanoid!.humanBones!;
    const W = worldMatrices(back);
    expect(Math.abs(W[hb2.head.node][13] - headY)).toBeLessThan(0.02 * H); // the head joint is back where the head is
    expect(back.skins!.length).toBe(1); // only the new skeleton
    expect(fixVrm(r.fixed)).toBeUndefined();
  });
});

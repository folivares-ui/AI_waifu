import { describe, expect, it } from "vitest";
import { fixVrm, guessHumanoid, modelHeight, readGlb, writeGlb } from "./vrmfix.js";

/** A skeleton named like the converted model that failed to load (Sketchfab-style suffixes). */
function skeleton() {
  const names = ["root_1", "COG_177", "waist_156", "chest_155", "neck_87", "head_86", "L collar_112", "L arm_111", "L elbow_109", "L hand_105", "R collar_150", "R arm_149", "R elbow_147", "R hand_143", "L leg_163", "L knee_161", "L ankle_158", "R leg_170", "R knee_168", "R ankle_165", "L weapon_104", "L thumbfinger A_90", "L thumbfinger B_89", "L thumbfinger C_88"];
  const nodes: { name: string; children?: number[] }[] = names.map((name) => ({ name }));
  const link = (p: number, ...c: number[]) => (nodes[p].children = c);
  link(0, 1);
  link(1, 2, 14, 17); // COG -> waist, legs
  link(2, 3);
  link(3, 4, 6, 10);
  link(4, 5);
  link(6, 7);
  link(7, 8);
  link(8, 9);
  link(9, 20, 21);
  link(21, 22);
  link(22, 23);
  link(10, 11);
  link(11, 12);
  link(12, 13);
  link(14, 15);
  link(15, 16);
  link(17, 18);
  link(18, 19);
  return nodes;
}

describe("repairing VRM files without a humanoid bone list", () => {
  it("recognises the bones by name; hips = where spine and legs meet", () => {
    const nodes = skeleton();
    const map = guessHumanoid(nodes, new Set());
    const named = Object.fromEntries(Object.entries(map).map(([b, i]) => [b, nodes[i].name]));
    expect(named).toMatchObject({
      hips: "COG_177", spine: "waist_156", chest: "chest_155", neck: "neck_87", head: "head_86",
      leftShoulder: "L collar_112", leftUpperArm: "L arm_111", leftLowerArm: "L elbow_109", leftHand: "L hand_105",
      rightUpperArm: "R arm_149", rightHand: "R hand_143", leftUpperLeg: "L leg_163", leftLowerLeg: "L knee_161", leftFoot: "L ankle_158",
      rightFoot: "R ankle_165", leftThumbMetacarpal: "L thumbfinger A_90", leftThumbDistal: "L thumbfinger C_88",
    });
    expect(Object.values(named)).not.toContain("L weapon_104");
  });

  it("fills VRM 1.0 and 0.x files, keeps the binary data, and leaves good files alone", () => {
    const bin = Buffer.concat([Buffer.from([8, 0, 0, 0]), Buffer.from("BIN\0"), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])]);
    const v1 = writeGlb({ nodes: skeleton(), extensions: { VRMC_vrm: { specVersion: "1.0", humanoid: { humanBones: {} } } } }, bin);
    const r = fixVrm(v1)!;
    const back = readGlb(r.fixed);
    expect(back.json.extensions!.VRMC_vrm!.humanoid!.humanBones!.hips).toEqual({ node: 1 });
    expect(back.bin!.equals(bin)).toBe(true);
    expect(fixVrm(r.fixed)).toBeUndefined(); // already fine
    const v0 = writeGlb({ nodes: skeleton(), extensions: { VRM: { humanoid: { humanBones: [] } } } }, bin);
    const bones0 = readGlb(fixVrm(v0)!.fixed).json.extensions!.VRM!.humanoid!.humanBones!;
    expect(bones0).toContainEqual({ bone: "hips", node: 1 });
    expect(bones0).toContainEqual({ bone: "leftThumbProximal", node: 21 }); // VRM 0.x thumb naming
  });

  it("explains which bones are missing when it cannot repair", () => {
    const glb = writeGlb({ nodes: [{ name: "Cube" }], extensions: { VRMC_vrm: { humanoid: { humanBones: {} } } } }, undefined);
    expect(() => fixVrm(glb)).toThrow(/No se reconocen estos huesos del modelo: hips, spine, head/);
  });
  it("ignores Blender's duplicate suffixes (Chest.001_011 is the chest, Upper Chest stays upper chest)", () => {
    const names = ["Hips_01", "Spine_010", "Chest.001_011", "Upper Chest_012", "Neck1_050", "Head_051", "Left leg_02", "Left knee_03", "Left ankle_04", "Right leg_06", "Right knee_07", "Right ankle_08", "Left arm_014", "Left elbow_015", "Left wrist_016", "Right arm_033", "Right elbow_00", "Right wrist_034"];
    const nodes: { name: string; children?: number[] }[] = names.map((name) => ({ name }));
    nodes[0].children = [1, 6, 9];
    nodes[1].children = [2];
    nodes[2].children = [3];
    nodes[3].children = [4, 12, 15];
    nodes[4].children = [5];
    nodes[6].children = [7];
    nodes[7].children = [8];
    nodes[9].children = [10];
    nodes[10].children = [11];
    nodes[12].children = [13];
    nodes[13].children = [14];
    nodes[15].children = [16];
    nodes[16].children = [17];
    const map = guessHumanoid(nodes, new Set());
    const named = Object.fromEntries(Object.entries(map).map(([b, i]) => [b, nodes[i].name]));
    expect(named).toMatchObject({ hips: "Hips_01", spine: "Spine_010", chest: "Chest.001_011", upperChest: "Upper Chest_012", leftHand: "Left wrist_016", rightLowerArm: "Right elbow_00" });
  });
});


/** A tiny humanoid (20 cm) whose bone names are unreadable, with a skinned box so it has a mesh. */
function unnamedTiny() {
  const nodes: Record<string, unknown>[] = [];
  const add = (t: [number, number, number], parent?: number) => {
    nodes.push({ name: "��_" + nodes.length, translation: t });
    const i = nodes.length - 1;
    if (parent !== undefined) ((nodes[parent].children as number[] | undefined) ?? (nodes[parent].children = [])).push(i);
    return i;
  };
  // positions are relative to the parent, metres (a 20 cm figure facing +z)
  const root = add([0, 0, 0]);
  const hips = add([0, 0.1, 0], root);
  const legs = (x: number) => {
    const up = add([x, -0.005, 0], hips);
    const knee = add([0, -0.045, 0], up);
    const foot = add([0, -0.04, 0], knee);
    add([0, -0.008, 0.01], foot); // toes, in front
  };
  legs(0.012);
  legs(-0.012);
  const s1 = add([0, 0.015, 0], hips);
  const s2 = add([0, 0.015, 0], s1);
  const neck = add([0, 0.03, 0], s2);
  const head = add([0, 0.01, 0], neck);
  add([0.004, 0.012, 0.004], head); // eyes: single mirrored bones
  add([-0.004, 0.012, 0.004], head);
  const hair = add([0.002, 0.03, 0], head);
  add([0, 0.01, 0], hair);
  const arm = (x: number) => {
    const clav = add([x * 0.3, 0.02, 0], s2);
    const up = add([x, 0, 0], clav);
    const twist = add([x * 0.5, -0.012, 0], up); // a twist bone in the chain
    const elbow = add([x * 0.5, -0.012, 0], twist);
    const hand = add([x, -0.024, 0], elbow);
    add([x * 0.3, 0, 0], up); // helper on the arm (single bone)
    add([x * 0.3, 0, 0], elbow);
    add([x * 0.3, 0, 0], elbow);
    for (let f = 0; f < 4; f++) add([x * 0.2, 0, 0.002 * f], add([x * 0.3, 0, 0.002 * f], hand)); // fingers: chains
  };
  arm(0.02);
  arm(-0.02);
  const n = nodes.length;
  const joints = Array.from({ length: n }, (_, i) => i);
  // every joint moves a bit of the mesh: JOINTS_0 = joint i for vertex i, weight 1
  const count = n;
  const pos = Buffer.alloc(count * 12);
  const jnt = Buffer.alloc(count * 4);
  const wts = Buffer.alloc(count * 16);
  for (let i = 0; i < count; i++) {
    pos.writeFloatLE(0, i * 12);
    jnt.writeUInt8(i, i * 4);
    wts.writeFloatLE(1, i * 16);
  }
  const ibm = Buffer.alloc(16 * 4);
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1].forEach((v, i) => ibm.writeFloatLE(v, i * 4));
  const data = Buffer.concat([pos, jnt, wts, ibm]);
  nodes.push({ name: "body", mesh: 0, skin: 0 });
  const json = {
    scenes: [{ nodes: [0, n] }],
    nodes,
    skins: [{ joints, inverseBindMatrices: 3 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    bufferViews: [
      { byteOffset: 0, byteLength: pos.length },
      { byteOffset: pos.length, byteLength: jnt.length },
      { byteOffset: pos.length + jnt.length, byteLength: wts.length },
      { byteOffset: pos.length + jnt.length + wts.length, byteLength: ibm.length },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count, type: "VEC3", min: [0, 0, 0], max: [0, 0, 0] },
      { bufferView: 1, componentType: 5121, count, type: "VEC4" },
      { bufferView: 2, componentType: 5126, count, type: "VEC4" },
      { bufferView: 3, componentType: 5126, count: 1, type: "MAT4" },
    ],
    extensions: { VRMC_vrm: { specVersion: "1.0", humanoid: { humanBones: {} } } },
  };
  const header = Buffer.alloc(8);
  header.writeUInt32LE(data.length, 0);
  header.write("BIN\0", 4, "latin1");
  return { glb: writeGlb(json, Buffer.concat([header, data])), json };
}

describe("models with unreadable bone names and a lost scale", () => {
  it("recognises the bones from the skeleton's shape (twist bones and helpers are skipped)", () => {
    const { glb } = unnamedTiny();
    const r = fixVrm(glb)!;
    const bones = readGlb(r.fixed).json.extensions!.VRMC_vrm!.humanoid!.humanBones!;
    const node = (b: string) => bones[b]?.node;
    expect(node("hips")).toBe(1);
    expect(node("leftUpperLeg")).toBe(2); // +x side is her left (she faces +z)
    expect(node("leftLowerLeg")).toBe(3);
    expect(node("leftFoot")).toBe(4);
    expect(node("rightUpperLeg")).toBe(6);
    expect(node("spine")).toBe(10);
    expect(node("head")).toBe(13);
    expect(node("neck")).toBe(12);
    expect([node("leftEye"), node("rightEye")]).toEqual([14, 15]);
    // arm: clavicle, upper arm, (twist), elbow, hand
    expect(node("leftShoulder")).toBe(18);
    expect(node("leftUpperArm")).toBe(19);
    expect(node("leftLowerArm")).toBe(21);
    expect(node("leftHand")).toBe(22);
  });
  it("resizes a 20 cm model to a person's height and leaves normal ones alone", () => {
    const { glb } = unnamedTiny();
    const r = fixVrm(glb)!;
    expect(r.scale).toBeGreaterThan(5);
    const back = readGlb(r.fixed);
    expect(modelHeight(back.json, back.bin)).toBeCloseTo(1.58, 2);
    expect(fixVrm(r.fixed)).toBeUndefined(); // bones filled in and the right size: nothing left to do
  });
});

describe("bones named by body part ('leg left thigh', 'arm right elbow', 'head neck upper')", () => {
  it("recognises them, skips helper bones, and finds the hips where spine and legs meet", async () => {
    const { guessHumanoidByParts } = await import("./vrmfix.js");
    const names = ["root hips_010", "spine lower_0200", "spine middle_0201", "spine upper_0202", "head neck lower_0222", "head neck upper_0224", "leg left thigh_025", "leg left knee_027", "leg left ankle_029", "leg right thigh_032", "leg right knee_034", "leg right ankle_036", "arm left shoulder 1_0444", "arm left shoulder 2 ctrl_0445", "arm left shoulder 2_0447", "arm left elbow_0449", "arm left wrist_0451", "arm left finger 1a_0457", "unused DEF-thigh.L.001_026"];
    const nodes: { name: string; children?: number[] }[] = names.map((name) => ({ name }));
    nodes[0].children = [1, 6, 9];
    nodes[1].children = [2];
    nodes[2].children = [3];
    nodes[3].children = [4, 12];
    nodes[4].children = [5];
    nodes[6].children = [7, 18];
    nodes[7].children = [8];
    nodes[9].children = [10];
    nodes[10].children = [11];
    nodes[12].children = [13, 14];
    nodes[14].children = [15];
    nodes[15].children = [16];
    nodes[16].children = [17];
    const map = guessHumanoidByParts(nodes, new Set());
    const named = Object.fromEntries(Object.entries(map).map(([b, i]) => [b, names[i]]));
    expect(named).toMatchObject({
      hips: "root hips_010", spine: "spine lower_0200", chest: "spine middle_0201", upperChest: "spine upper_0202", neck: "head neck lower_0222", head: "head neck upper_0224",
      leftUpperLeg: "leg left thigh_025", leftLowerLeg: "leg left knee_027", leftFoot: "leg left ankle_029", rightFoot: "leg right ankle_036",
      leftShoulder: "arm left shoulder 1_0444", leftUpperArm: "arm left shoulder 2_0447", leftLowerArm: "arm left elbow_0449", leftHand: "arm left wrist_0451", leftThumbMetacarpal: "arm left finger 1a_0457",
    });
  });
});

import { describe, expect, it } from "vitest";
import { fixVrm, guessHumanoid, readGlb, writeGlb } from "./vrmfix.js";

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
});

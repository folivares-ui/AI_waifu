import { autoRig, needsRig, type RigGltf } from "./autorig.js";
/**
 * Repairs VRM files whose humanoid bone list is empty (common in models converted from other formats, e.g.
 * Sketchfab exports): without it no VRM viewer can load them ("these humanoid bones are required but not exist").
 * The bones are recognised by their names and the list is filled in. Nothing else in the file changes.
 */

type GltfNode = {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
};
interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  normalized?: boolean;
}
interface Gltf {
  nodes: GltfNode[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  skins?: { joints: number[]; inverseBindMatrices?: number }[];
  meshes?: { primitives: { attributes: Record<string, number> }[] }[];
  accessors?: Accessor[];
  bufferViews?: { byteOffset?: number; byteLength: number; byteStride?: number }[];
  extensions?: {
    VRMC_vrm?: { humanoid?: { humanBones?: Record<string, { node: number }> } };
    VRM?: { humanoid?: { humanBones?: { bone: string; node: number }[] } };
  };
}

/** Splits a GLB into its JSON and the rest (binary chunk kept byte for byte). */
export function readGlb(buf: Buffer): { json: Gltf; bin: Buffer | undefined } {
  if (buf.length < 20 || buf.toString("latin1", 0, 4) !== "glTF") throw new Error("not a GLB/VRM file");
  const jsonLen = buf.readUInt32LE(12);
  if (buf.toString("latin1", 16, 20) !== "JSON") throw new Error("GLB without a JSON chunk");
  const json = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen)) as Gltf;
  const rest = 20 + jsonLen;
  const bin = rest + 8 <= buf.length ? buf.subarray(rest) : undefined; // header + data of the BIN chunk
  return { json, bin };
}

export function writeGlb(json: unknown, binChunk: Buffer | undefined): Buffer {
  let text = Buffer.from(JSON.stringify(json), "utf8");
  const pad = (4 - (text.length % 4)) % 4;
  if (pad) text = Buffer.concat([text, Buffer.alloc(pad, 0x20)]); // JSON chunks are padded with spaces
  const header = Buffer.alloc(12);
  const total = 12 + 8 + text.length + (binChunk?.length ?? 0);
  header.write("glTF", 0, "latin1");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(text.length, 0);
  jsonHeader.write("JSON", 4, "latin1");
  return Buffer.concat([header, jsonHeader, text, ...(binChunk ? [binChunk] : [])]);
}

/** Node names without exporter suffixes ("L arm_111" -> "l arm", "mixamorig:LeftArm" -> "leftarm"). */
const clean = (n: string) =>
  n
    .replace(/^mixamorig\d*:/i, "")
    .replace(/([_.]\d+)+$/, "")
    .replace(/^(J_Bip_|Bip0?1[ _]?|DEF[-_]|ORG[-_])/i, "")
    .toLowerCase()
    .trim();

/** Side marker of a cleaned name: "l arm", "arm_l", "arm.l", "leftarm", "upperarm_left"... */
function side(n: string): "l" | "r" | undefined {
  if (/(^|[ _.\-])(l|left)([ _.\-]|$)|^left|left$/.test(n)) return "l";
  if (/(^|[ _.\-])(r|right)([ _.\-]|$)|^right|right$/.test(n)) return "r";
  return undefined;
}
const core = (n: string) =>
  n
    .replace(/(^|[ _.\-])(l|r|left|right)([ _.\-]|$)/g, " ")
    .replace(/^(left|right)|(left|right)$/g, "")
    .replace(/[ _.\-]+/g, " ")
    .trim();

/** Candidate names for each bone (after removing side markers), most specific first. */
const NAMES: Record<string, RegExp> = {
  spine: /^(spine|waist|spine ?0?1?|abdomen|torso)$/,
  chest: /^(chest|spine ?0?2|upper ?chest|spine1)$/,
  upperChest: /^(upper ?chest|spine ?0?3|spine2)$/,
  neck: /^neck( ?0?1)?$/,
  head: /^head$/,
  Shoulder: /^(collar|clavicle|shoulder)$/,
  UpperArm: /^(upper ?arm|arm)$/,
  LowerArm: /^(lower ?arm|fore ?arm|elbow)$/,
  Hand: /^(hand|wrist)$/,
  UpperLeg: /^(upper ?leg|thigh|up ?leg|leg)$/,
  LowerLeg: /^(lower ?leg|knee|calf|shin)$/,
  Foot: /^(foot|ankle)$/,
  Toes: /^(toes?|toe ?base|ball)$/,
  Eye: /^eye$/,
};
const FINGERS: [string, RegExp][] = [
  ["Thumb", /^thumb ?(finger)?/],
  ["Index", /^index ?(finger)?/],
  ["Middle", /^middle ?(finger)?/],
  ["Ring", /^ring ?(finger)?/],
  ["Little", /^(little|pinky) ?(finger)?/],
];

/** Fills the humanoid map from bone names. Returns VRM 1.0 bone names -> node index. */
export function guessHumanoid(nodes: GltfNode[], joints: Set<number>): Record<string, number> {
  const parent = new Map<number, number>();
  nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  const isAncestor = (a: number, b: number) => {
    for (let p = parent.get(b); p !== undefined; p = parent.get(p)) if (p === a) return true;
    return false;
  };
  const info = nodes.map((n, i) => {
    const c = clean(n.name ?? "");
    return { i, c, side: side(c), core: core(c) };
  });
  const pick = (re: RegExp, s?: "l" | "r") => info.find((x) => (joints.size === 0 || joints.has(x.i)) && x.side === s && re.test(x.core))?.i;
  const out: Record<string, number> = {};
  for (const bone of ["spine", "chest", "upperChest", "neck", "head"]) {
    const i = pick(NAMES[bone]);
    if (i !== undefined) out[bone] = i;
  }
  for (const [s, prefix] of [["l", "left"], ["r", "right"]] as const) {
    for (const part of ["Shoulder", "UpperArm", "LowerArm", "Hand", "UpperLeg", "LowerLeg", "Foot", "Toes", "Eye"]) {
      const i = pick(NAMES[part], s);
      if (i !== undefined) out[prefix + part] = i;
    }
    // Fingers: A/B/C or 1/2/3 segments -> proximal/intermediate/distal (thumb: metacarpal/proximal/distal).
    for (const [finger, re] of FINGERS) {
      const segs = info
        .filter((x) => (joints.size === 0 || joints.has(x.i)) && x.side === s && re.test(x.core))
        .sort((a, b) => a.core.localeCompare(b.core));
      const names = finger === "Thumb" ? ["Metacarpal", "Proximal", "Distal"] : ["Proximal", "Intermediate", "Distal"];
      segs.slice(0, 3).forEach((x, k) => (out[`${prefix}${finger}${names[k]}`] = x.i));
    }
  }
  // Hips: the bone both the spine and the legs hang from (closest common ancestor).
  const spine = out.spine;
  const legs = [out.leftUpperLeg, out.rightUpperLeg].filter((x): x is number => x !== undefined);
  const named = pick(/^(hips?|pelvis|cog|root ?hips)$/);
  if (named !== undefined && spine !== undefined && legs.every((l) => isAncestor(named, l)) && isAncestor(named, spine)) out.hips = named;
  else if (spine !== undefined && legs.length) {
    for (let p = parent.get(spine); p !== undefined; p = parent.get(p)) {
      if (legs.every((l) => isAncestor(p!, l))) {
        out.hips = p;
        break;
      }
    }
  }
  // Chest/upperChest must sit between spine and neck: drop them if the hierarchy disagrees.
  if (out.chest !== undefined && (spine === undefined || !isAncestor(spine, out.chest))) delete out.chest;
  if (out.upperChest !== undefined && (out.chest === undefined || !isAncestor(out.chest, out.upperChest))) delete out.upperChest;
  return out;
}

/**
 * Bones named by body part, side and position, e.g. "leg left thigh", "arm right elbow", "arm left finger 2b",
 * "spine lower", "head neck upper" (rigs exported from some game-model tools). Helper bones ("unused", "ctrl",
 * twist) are ignored. Returns VRM 1.0 bone names -> node index.
 */
export function guessHumanoidByParts(nodes: GltfNode[], joints: Set<number>): Record<string, number> {
  const parent = new Map<number, number>();
  nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  const clean = (n: string) => n.replace(/(_\d+)+$/, "").toLowerCase().trim();
  const all = nodes
    .map((n, i) => ({ i, n: clean(n.name ?? "") }))
    .filter((x) => (joints.size === 0 || joints.has(x.i)) && !/unused|ctrl|twist|_end|\bend\b|mch|org|def/.test(x.n));
  const find = (re: RegExp) => all.find((x) => re.test(x.n))?.i;
  const out: Record<string, number> = {};
  const put = (bone: string, i: number | undefined) => i !== undefined && (out[bone] = i);
  put("spine", find(/^spine lower$/));
  put("chest", find(/^spine middle$/));
  put("upperChest", find(/^spine upper$/));
  put("neck", find(/^head neck lower$/));
  put("head", find(/^head neck upper$/));
  for (const [s, side] of [["left", "left"], ["right", "right"]] as const) {
    put(`${s}UpperLeg`, find(new RegExp(`^leg ${side} thigh$`)));
    put(`${s}LowerLeg`, find(new RegExp(`^leg ${side} knee$`)));
    put(`${s}Foot`, find(new RegExp(`^leg ${side} ankle$`)));
    put(`${s}Toes`, find(new RegExp(`^leg ${side} toes$`)));
    put(`${s}Shoulder`, find(new RegExp(`^arm ${side} shoulder 1$`)));
    put(`${s}UpperArm`, find(new RegExp(`^arm ${side} shoulder 2$`)));
    put(`${s}LowerArm`, find(new RegExp(`^arm ${side} elbow$`)));
    put(`${s}Hand`, find(new RegExp(`^arm ${side} wrist$`)));
    put(`${s}Eye`, find(new RegExp(`^head eyeball ${side}$`)));
    // finger 1 = thumb .. 5 = little; a/b/c = the three segments
    const F: [string, string[]][] = [["Thumb", ["Metacarpal", "Proximal", "Distal"]], ["Index", ["Proximal", "Intermediate", "Distal"]], ["Middle", ["Proximal", "Intermediate", "Distal"]], ["Ring", ["Proximal", "Intermediate", "Distal"]], ["Little", ["Proximal", "Intermediate", "Distal"]]];
    F.forEach(([f, segs], k) => ["a", "b", "c"].forEach((seg, j) => put(`${s}${f}${segs[j]}`, find(new RegExp(`^arm ${side} finger ${k + 1}${seg}$`)))));
  }
  // hips: where the spine and both legs meet
  const isAnc = (a: number, b: number) => {
    for (let p = parent.get(b); p !== undefined; p = parent.get(p)) if (p === a) return true;
    return false;
  };
  if (out.spine !== undefined && out.leftUpperLeg !== undefined && out.rightUpperLeg !== undefined) {
    for (let p = parent.get(out.spine); p !== undefined; p = parent.get(p)) {
      if (isAnc(p, out.leftUpperLeg) && isAnc(p, out.rightUpperLeg)) {
        out.hips = p;
        break;
      }
    }
  }
  return out;
}

/**
 * AdvancedSkeleton-style names: "Root_M", "Spine1_M", "Chest_M", "Head_M", "Hip_L", "Knee_L", "Ankle_L",
 * "Scapula_L", "Shoulder_L", "Elbow_L", "Wrist_L", "IndexFinger1_L"... (the _M/_L/_R suffix is the side).
 * "...Part1" twist helpers are ignored. Returns VRM 1.0 bone names -> node index.
 */
export function guessHumanoidAdvanced(nodes: GltfNode[], joints: Set<number>): Record<string, number> {
  const clean = (n: string) => n.replace(/_\d+$/, "");
  const all = nodes.map((n, i) => ({ i, n: clean(n.name ?? "") })).filter((x) => joints.size === 0 || joints.has(x.i));
  const find = (name: string) => all.find((x) => x.n === name)?.i;
  const out: Record<string, number> = {};
  const put = (bone: string, name: string) => {
    const i = find(name);
    if (i !== undefined) out[bone] = i;
  };
  put("hips", "Root_M");
  put("spine", "Spine1_M");
  put("chest", "Spine2_M");
  put("upperChest", "Chest_M");
  put("neck", "Neck_M");
  put("head", "Head_M");
  for (const [s, k] of [["left", "L"], ["right", "R"]] as const) {
    put(`${s}UpperLeg`, `Hip_${k}`);
    put(`${s}LowerLeg`, `Knee_${k}`);
    put(`${s}Foot`, `Ankle_${k}`);
    put(`${s}Toes`, `Toes_${k}`);
    put(`${s}Shoulder`, `Scapula_${k}`);
    put(`${s}UpperArm`, `Shoulder_${k}`);
    put(`${s}LowerArm`, `Elbow_${k}`);
    put(`${s}Hand`, `Wrist_${k}`);
    put(`${s}Eye`, `eye_${k}`);
    const F: [string, string, string[]][] = [["Thumb", "Thumb", ["Metacarpal", "Proximal", "Distal"]], ["Index", "Index", ["Proximal", "Intermediate", "Distal"]], ["Middle", "Middle", ["Proximal", "Intermediate", "Distal"]], ["Ring", "Ring", ["Proximal", "Intermediate", "Distal"]], ["Little", "Pinky", ["Proximal", "Intermediate", "Distal"]]];
    for (const [f, src, segs] of F) segs.forEach((g, j) => put(`${s}${f}${g}`, `${src}Finger${j + 1}_${k}`));
  }
  return out;
}

const REQUIRED = ["hips", "spine", "head", "leftUpperLeg", "leftLowerLeg", "leftFoot", "rightUpperLeg", "rightLowerLeg", "rightFoot", "leftUpperArm", "leftLowerArm", "leftHand", "rightUpperArm", "rightLowerArm", "rightHand"];

/** VRM 0.x names for the same bones ("leftThumbMetacarpal" was "leftThumbProximal" there, and so on). */
function toVrm0(bone: string): string {
  return bone.replace(/Thumb(Metacarpal|Proximal|Distal)$/, (_, s: string) => `Thumb${({ Metacarpal: "Proximal", Proximal: "Intermediate", Distal: "Distal" } as Record<string, string>)[s]}`);
}

// ---------- size ----------

type M4 = number[]; // column-major 4x4, like glTF

const mul = (a: M4, b: M4): M4 => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const apply = (m: M4, p: number[]) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);

function localMatrix(n: GltfNode): M4 {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** World matrix of every node in the rest pose. */
export function worldMatrices(json: Gltf): M4[] {
  const parent = new Map<number, number>();
  json.nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  const out: M4[] = [];
  const world = (i: number): M4 => {
    if (out[i]) return out[i];
    const p = parent.get(i);
    return (out[i] = p === undefined ? localMatrix(json.nodes[i]) : mul(world(p), localMatrix(json.nodes[i])));
  };
  json.nodes.forEach((_, i) => world(i));
  return out;
}

/** Reads accessor data from the BIN chunk (header included, as readGlb returns it); normalized ints become 0..1. */
function readFloats(json: Gltf, bin: Buffer | undefined, index: number): number[][] | undefined {
  const a = json.accessors?.[index];
  if (!a || a.bufferView === undefined || !bin) return undefined;
  const size = ({ 5126: 4, 5125: 4, 5123: 2, 5121: 1 } as Record<number, number>)[a.componentType];
  if (!size) return undefined;
  const read = (o: number) => {
    const v = a.componentType === 5126 ? bin.readFloatLE(o) : a.componentType === 5125 ? bin.readUInt32LE(o) : a.componentType === 5123 ? bin.readUInt16LE(o) : bin[o];
    return a.normalized ? v / (a.componentType === 5123 ? 65535 : 255) : v;
  };
  const bv = json.bufferViews?.[a.bufferView];
  if (!bv) return undefined;
  const n = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 } as Record<string, number>)[a.type] ?? 1;
  const stride = bv.byteStride ?? n * size;
  const base = 8 + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out: number[][] = [];
  for (let k = 0; k < a.count; k++) {
    const o = base + k * stride;
    if (o + n * size > bin.length) return undefined;
    out.push(Array.from({ length: n }, (_, c) => read(o + c * size)));
  }
  return out;
}

/** Total skin weight per joint node (how much of the mesh each joint moves). */
function jointWeights(json: Gltf, bin: Buffer | undefined): Map<number, number> {
  const weight = new Map<number, number>();
  json.nodes.forEach((n) => {
    const skin = n.skin !== undefined ? json.skins?.[n.skin] : undefined;
    if (!skin || n.mesh === undefined) return;
    for (const prim of json.meshes?.[n.mesh]?.primitives ?? []) {
      const J = prim.attributes.JOINTS_0 !== undefined ? readFloats(json, bin, prim.attributes.JOINTS_0) : undefined;
      const Wt = prim.attributes.WEIGHTS_0 !== undefined ? readFloats(json, bin, prim.attributes.WEIGHTS_0) : undefined;
      if (!J || !Wt) continue;
      J.forEach((js, v) => js.forEach((j, k) => {
        const node = skin.joints[j];
        if (node !== undefined) weight.set(node, (weight.get(node) ?? 0) + Wt[v][k]);
      }));
    }
  });
  return weight;
}

/**
 * Height of the model in its rest pose (metres): from its skeleton (the joints that actually move the mesh; props
 * and helpers can sit far away), or from the meshes' bounding boxes when it has no skeleton.
 */
export function modelHeight(json: Gltf, bin: Buffer | undefined): number | undefined {
  const W = worldMatrices(json);
  const joints = [...new Set(json.skins?.flatMap((s) => s.joints) ?? [])];
  if (joints.length >= 2) {
    const weight = jointWeights(json, bin);
    const used = weight.size ? joints.filter((j) => (weight.get(j) ?? 0) > 0) : joints;
    const ys = (used.length >= 2 ? used : joints).map((j) => W[j][13]);
    const h = Math.max(...ys) - Math.min(...ys);
    return h > 0 ? h : undefined;
  }
  let lo = Infinity;
  let hi = -Infinity;
  json.nodes.forEach((n, ni) => {
    if (n.mesh === undefined) return;
    for (const prim of json.meshes?.[n.mesh]?.primitives ?? []) {
      const acc = json.accessors?.[prim.attributes.POSITION];
      if (!acc?.min || !acc.max) continue;
      for (let c = 0; c < 8; c++) {
        const y = apply(W[ni], [c & 1 ? acc.max[0] : acc.min[0], c & 2 ? acc.max[1] : acc.min[1], c & 4 ? acc.max[2] : acc.min[2]])[1];
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
    }
  });
  return isFinite(hi - lo) && hi > lo ? hi - lo : undefined;
}

/** Scales the whole model about the origin (its root nodes), so nothing else in the file has to change. */
function rescale(json: Gltf, s: number) {
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
  for (const r of roots) {
    const n = json.nodes[r];
    if (n.matrix) n.matrix = n.matrix.map((v, i) => (i < 15 && i % 4 !== 3 ? v * s : v));
    else {
      if (n.translation) n.translation = n.translation.map((v) => v * s);
      n.scale = (n.scale ?? [1, 1, 1]).map((v) => v * s);
    }
  }
}

// ---------- bones by shape (names unreadable) ----------

/**
 * Recognises the humanoid bones from the shape of the skeleton alone: the lowest joints are the feet, the joints
 * furthest to each side are the hands, the highest is on the head. Used when the names say nothing (e.g. they were
 * written in another alphabet and got lost in a conversion).
 */
export function guessHumanoidByShape(json: Gltf, bin?: Buffer): Record<string, number> {
  const W = worldMatrices(json);
  // How much of the mesh each joint moves (helpers, IK targets and props have little or nothing).
  const weight = jointWeights(json, bin);
  const P = W.map((m) => [m[12], m[13], m[14]]);
  const joints = [...new Set(json.skins?.flatMap((s) => s.joints) ?? [])];
  if (joints.length < 10) return {};
  const parent = new Map<number, number>();
  json.nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  const pathTo = (i: number) => {
    const out: number[] = [];
    for (let p: number | undefined = i; p !== undefined; p = parent.get(p)) out.unshift(p);
    return out;
  };
  const lca = (...ids: number[]) => {
    const paths = ids.map(pathTo);
    let k = 0;
    while (paths.every((p) => p[k] !== undefined && p[k] === paths[0][k])) k++;
    return paths[0][k - 1];
  };
  const dist = (a: number, b: number) => Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1], P[a][2] - P[b][2]);
  const ys = joints.map((j) => P[j][1]);
  const H = Math.max(...ys) - Math.min(...ys);
  // middle of the body: halfway between the joints furthest to each side (the hands)
  const xs = joints.map((j) => P[j][0]);
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
  const top = joints.reduce((a, b) => (P[b][1] > P[a][1] ? b : a));
  const lowest = (side: number) => {
    // (props held near the feet, like a weapon resting on the floor, sit in the middle: not a foot)
    const cand = joints.filter((j) => (P[j][0] - cx) * side > 0.04 * H);
    if (!cand.length) return undefined;
    // several chains can end at the toes (deform bones, the game's own, IK targets): take the one that skins
    const minY = Math.min(...cand.map((j) => P[j][1]));
    const pathWeight = (j: number) => pathTo(j).reduce((s, n) => s + (weight.get(n) ?? 0), 0);
    return cand.filter((j) => P[j][1] < minY + 0.01 * H).reduce((a, b) => (pathWeight(b) > pathWeight(a) ? b : a));
  };
  const furthest = (side: number) => {
    const cand = joints.filter((j) => P[j][1] > Math.min(...ys) + 0.4 * H);
    return cand.length ? cand.reduce((a, b) => ((P[b][0] - cx) * side > (P[a][0] - cx) * side ? b : a)) : undefined;
  };
  const out: Record<string, number> = {};
  const footA = lowest(1);
  const footB = lowest(-1);
  if (footA === undefined || footB === undefined) return {};
  const hips = lca(footA, footB, top);
  if (hips === undefined) return {};
  out.hips = hips;

  // Legs: the two longest downward segments are the thigh and the shin.
  const leg = (low: number) => {
    const path = pathTo(low);
    const chain = path.slice(path.indexOf(hips));
    const drops = chain.slice(0, -1).map((n, i) => ({ i, d: P[n][1] - P[chain[i + 1]][1] }));
    const big = [...drops].sort((a, b) => b.d - a.d).slice(0, 2).sort((a, b) => a.i - b.i);
    if (big.length < 2 || big[0].d < 0.1 * H || big[1].d < 0.1 * H) return undefined;
    const upper = chain[big[0].i];
    const lower = chain[big[1].i];
    const foot = chain[big[1].i + 1];
    const toes = chain[big[1].i + 2];
    return { upper, lower, foot, toes };
  };
  const legA = leg(footA);
  const legB = leg(footB);
  // Which way she faces: the toes point forward. VRM's left is +x when facing +z.
  const front = legA?.toes !== undefined ? Math.sign(P[legA.toes][2] - P[legA.foot][2]) || 1 : 1;
  const [leftLeg, rightLeg] = front > 0 ? [legA, legB] : [legB, legA];
  for (const [side, l] of [["left", leftLeg], ["right", rightLeg]] as const) {
    if (!l) continue;
    out[`${side}UpperLeg`] = l.upper;
    out[`${side}LowerLeg`] = l.lower;
    out[`${side}Foot`] = l.foot;
    if (l.toes !== undefined) out[`${side}Toes`] = l.toes;
  }

  // Spine: from the hips up to where both arms branch off (the chest), then neck and head.
  const tipA = furthest(1);
  const tipB = furthest(-1);
  if (tipA === undefined || tipB === undefined) return out;
  const chest = lca(tipA, tipB);
  const up = pathTo(top);
  if (chest === undefined || !up.includes(chest) || up.indexOf(chest) <= up.indexOf(hips)) return out;
  const spine = up.slice(up.indexOf(hips) + 1, up.indexOf(chest) + 1);
  out.spine = spine[0];
  if (spine.length === 2) out.chest = spine[1];
  if (spine.length >= 3) {
    out.chest = spine[spine.length - 2];
    out.upperChest = spine[spine.length - 1];
  }
  const above = up.slice(up.indexOf(chest) + 1, up.indexOf(chest) + 4);
  const kids = (i: number) => json.nodes[i].children?.length ?? 0;
  const head = above.reduce((a, b) => (kids(b) > kids(a) ? b : a), above[0]);
  if (head !== undefined) {
    out.head = head;
    const neck = above[above.indexOf(head) - 1];
    if (neck !== undefined) out.neck = neck;
    // Eyes: a mirrored pair of bones on the head, above it, that move part of the mesh (the irises).
    // (hair and ribbon roots are mirrored too, but they start chains; an eye is a single bone, maybe with an end)
    const size = (i: number): number => 1 + (json.nodes[i].children ?? []).reduce((s, c) => s + size(c), 0);
    const onHead = (json.nodes[head].children ?? []).filter((c) => (weight.get(c) ?? 0) > 0 && P[c][1] > P[head][1] && size(c) <= 2);
    // (ribbons and hair roots sit on top of the head; the eyes are the single bones closest to the head bone)
    let pair: [number, number] | undefined;
    let bestScore = Infinity;
    for (const a of onHead) for (const b of onHead) {
      if (a === b || P[a][0] - P[head][0] <= 0.005 * H) continue;
      const mirror = Math.abs(P[a][0] - P[head][0] + (P[b][0] - P[head][0])) + Math.abs(P[a][1] - P[b][1]) + Math.abs(P[a][2] - P[b][2]);
      const near = Math.abs(P[a][1] - P[head][1]) < 0.12 * H && Math.abs(P[a][0] - P[head][0]) < 0.05 * H;
      const score = size(a) + (10 * dist(a, head)) / H;
      if (near && mirror < 0.004 * H && score < bestScore) {
        bestScore = score;
        pair = [a, b];
      }
    }
    if (pair) {
      const [plusX, minusX] = pair;
      out.leftEye = front > 0 ? plusX : minusX;
      out.rightEye = front > 0 ? minusX : plusX;
    }
  }

  // Arms: the hand is where the fingers branch; elbow = where upper arm and forearm are about equally long.
  const arm = (tip: number) => {
    const path = pathTo(tip);
    const chain = path.slice(path.indexOf(chest) + 1);
    // (twist helpers hang from the arm too, but they are single bones; fingers are chains)
    const fingers = (n: number) => (json.nodes[n].children ?? []).filter((c) => kids(c) > 0).length;
    const hi = chain.findIndex((n) => fingers(n) >= 3);
    const h = hi >= 0 ? hi : chain.length - 1;
    const hand = chain[h];
    let best: { u: number; l: number; score: number } | undefined;
    const reach = Math.max(...chain.slice(0, h).map((n) => dist(n, hand)));
    for (let u = 0; u < h - 1; u++) {
      if (dist(chain[u], hand) < 0.6 * reach) continue;
      for (let l = u + 1; l < h; l++) {
        const score = Math.abs(dist(chain[u], chain[l]) - dist(chain[l], hand)) / reach;
        if (!best || score <= best.score + 1e-9) best = { u, l, score };
      }
    }
    if (!best) return undefined;
    return { shoulder: best.u > 0 ? chain[best.u - 1] : undefined, upper: chain[best.u], lower: chain[best.l], hand };
  };
  const armA = arm(tipA);
  const armB = arm(tipB);
  const [leftArm, rightArm] = front > 0 ? [armA, armB] : [armB, armA];
  for (const [side, a] of [["left", leftArm], ["right", rightArm]] as const) {
    if (!a) continue;
    if (a.shoulder !== undefined) out[`${side}Shoulder`] = a.shoulder;
    out[`${side}UpperArm`] = a.upper;
    out[`${side}LowerArm`] = a.lower;
    out[`${side}Hand`] = a.hand;
  }
  return out;
}

/** Height a model is scaled to when it comes far too small or too big (metres). */
const TARGET_HEIGHT = 1.58;

/**
 * Returns the repaired file, or undefined when nothing needed (or could be) fixed.
 * Repairs: an empty humanoid bone list (filled from the bone names, or from the skeleton's shape when the names
 * are unreadable) and a size far from a person's (some conversions lose a scale step: a 20 cm or 100 m model).
 * Throws with a readable message when the required bones cannot be recognised.
 */
export function fixVrm(buf: Buffer): { fixed: Buffer; bones: number; scale?: number; rigged?: boolean } | undefined {
  const read = readGlb(buf);
  const json = read.json;
  let bin = read.bin;
  const v1 = json.extensions?.VRMC_vrm;
  const v0 = json.extensions?.VRM;
  const empty1 = v1 && Object.keys(v1.humanoid?.humanBones ?? {}).length === 0;
  const empty0 = v0 && (v0.humanoid?.humanBones ?? []).length === 0;
  const height = modelHeight(json, bin);
  const scale = height !== undefined && (height < 0.6 || height > 4) ? TARGET_HEIGHT / height : undefined;
  const rig = (empty1 || empty0) && bin !== undefined && needsRig(json as unknown as RigGltf);
  if (!empty1 && !empty0 && scale === undefined) return undefined;
  if (scale !== undefined) rescale(json, scale);
  let bones = 0;
  if (rig) {
    // A statue (no skeleton at all): give it one. Done after resizing, so the skeleton has a person's size.
    const r = autoRig(json as unknown as RigGltf, bin!);
    bin = r.bin;
    const map = r.humanBones;
    if (empty1) v1!.humanoid = { ...(v1!.humanoid ?? {}), humanBones: Object.fromEntries(Object.entries(map).map(([b, node]) => [b, { node }])) };
    if (empty0) v0!.humanoid = { ...(v0!.humanoid ?? {}), humanBones: Object.entries(map).map(([b, node]) => ({ bone: toVrm0(b), node })) };
    return { fixed: writeGlb(json, bin), bones: Object.keys(map).length, scale, rigged: true };
  }
  if (empty1 || empty0) {
    const joints = new Set(json.skins?.flatMap((s) => s.joints) ?? []);
    let map = guessHumanoid(json.nodes, joints);
    if (REQUIRED.some((b) => map[b] === undefined)) {
      const byParts = guessHumanoidByParts(json.nodes, joints);
      if (REQUIRED.every((b) => byParts[b] !== undefined)) map = byParts;
    }
    if (REQUIRED.some((b) => map[b] === undefined)) {
      const adv = guessHumanoidAdvanced(json.nodes, joints);
      if (REQUIRED.every((b) => adv[b] !== undefined)) map = adv;
    }
    if (REQUIRED.some((b) => map[b] === undefined)) {
      const byShape = guessHumanoidByShape(json, bin);
      if (REQUIRED.every((b) => byShape[b] !== undefined)) map = byShape;
    }
    const missing = REQUIRED.filter((b) => map[b] === undefined);
    if (missing.length) throw new Error(`No se reconocen estos huesos del modelo: ${missing.join(", ")}`);
    if (empty1) v1!.humanoid = { ...(v1!.humanoid ?? {}), humanBones: Object.fromEntries(Object.entries(map).map(([b, node]) => [b, { node }])) };
    if (empty0) v0!.humanoid = { ...(v0!.humanoid ?? {}), humanBones: Object.entries(map).map(([b, node]) => ({ bone: toVrm0(b), node })) };
    bones = Object.keys(map).length;
  }
  return { fixed: writeGlb(json, bin), bones, scale };
}

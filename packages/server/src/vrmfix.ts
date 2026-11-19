/**
 * Repairs VRM files whose humanoid bone list is empty (common in models converted from other formats, e.g.
 * Sketchfab exports): without it no VRM viewer can load them ("these humanoid bones are required but not exist").
 * The bones are recognised by their names and the list is filled in. Nothing else in the file changes.
 */

type GltfNode = { name?: string; children?: number[]; mesh?: number; skin?: number };
interface Gltf {
  nodes: GltfNode[];
  skins?: { joints: number[] }[];
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
    .replace(/[_.]\d+$/, "")
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

const REQUIRED = ["hips", "spine", "head", "leftUpperLeg", "leftLowerLeg", "leftFoot", "rightUpperLeg", "rightLowerLeg", "rightFoot", "leftUpperArm", "leftLowerArm", "leftHand", "rightUpperArm", "rightLowerArm", "rightHand"];

/** VRM 0.x names for the same bones ("leftThumbMetacarpal" was "leftThumbProximal" there, and so on). */
function toVrm0(bone: string): string {
  return bone.replace(/Thumb(Metacarpal|Proximal|Distal)$/, (_, s: string) => `Thumb${({ Metacarpal: "Proximal", Proximal: "Intermediate", Distal: "Distal" } as Record<string, string>)[s]}`);
}

/**
 * Returns the repaired file, or undefined when nothing needed (or could be) fixed.
 * Throws with a readable message when the required bones cannot be recognised.
 */
export function fixVrm(buf: Buffer): { fixed: Buffer; bones: number } | undefined {
  const { json, bin } = readGlb(buf);
  const v1 = json.extensions?.VRMC_vrm;
  const v0 = json.extensions?.VRM;
  const empty1 = v1 && Object.keys(v1.humanoid?.humanBones ?? {}).length === 0;
  const empty0 = v0 && (v0.humanoid?.humanBones ?? []).length === 0;
  if (!empty1 && !empty0) return undefined;
  const joints = new Set(json.skins?.flatMap((s) => s.joints) ?? []);
  const map = guessHumanoid(json.nodes, joints);
  const missing = REQUIRED.filter((b) => map[b] === undefined);
  if (missing.length) throw new Error(`No se reconocen estos huesos del modelo: ${missing.join(", ")}`);
  if (empty1) v1!.humanoid = { ...(v1!.humanoid ?? {}), humanBones: Object.fromEntries(Object.entries(map).map(([b, node]) => [b, { node }])) };
  if (empty0) v0!.humanoid = { ...(v0!.humanoid ?? {}), humanBones: Object.entries(map).map(([b, node]) => ({ bone: toVrm0(b), node })) };
  return { fixed: writeGlb(json, bin), bones: Object.keys(map).length };
}

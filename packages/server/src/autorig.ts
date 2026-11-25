/**
 * Gives a skeleton to a model that has none (a statue: e.g. converted from an .obj file), so it can move like the
 * others. The model must stand upright (+y up), face +z and be in a T- or A-pose, which is how VRM models and most
 * character exports come.
 *
 * 1. Joints are placed from the shape of the mesh: feet at the bottom, legs below the hem, the arms as the parts that
 *    stick out sideways (a straight line fitted through them), shoulders/neck/head from the arms' height, eyes
 *    from the eye openings of the face. Everything else uses usual body proportions.
 * 2. Each piece of the mesh (connected part) is assigned to bones: pieces that reach the top of the head (hair,
 *    face) follow the head (long hair blends into the chest lower down); the rest by where each vertex is: along an
 *    arm, a leg, or the spine, blending smoothly at the joints. A skirt follows the hips.
 *
 * The result is ordinary glTF skinning (JOINTS_0/WEIGHTS_0, one skin) plus the humanoid bone map.
 */

type M4 = number[];
type V3 = [number, number, number];

interface Node {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface Prim {
  attributes: Record<string, number>;
  indices?: number;
}
interface Acc {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  normalized?: boolean;
}
export interface RigGltf {
  nodes: Node[];
  scenes?: { nodes?: number[] }[];
  scene?: number;
  skins?: { joints: number[]; inverseBindMatrices?: number; skeleton?: number }[];
  meshes?: { primitives: Prim[] }[];
  accessors?: Acc[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number }[];
  buffers?: { byteLength: number }[];
}

// ---------- small math ----------

const mul = (a: M4, b: M4): M4 => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const apply = (m: M4, p: number[]): V3 => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]) as V3;
function invert(m: M4): M4 {
  // general 4x4 inverse (affine matrices here)
  const inv = new Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const d = 1 / det;
  inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  inv[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  inv[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  inv[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  inv[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  inv[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  inv[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  inv[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  inv[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  inv[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return inv;
}
function localMatrix(n: Node): M4 {
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
function worldMatrices(json: RigGltf): M4[] {
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
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const lerp = (a: V3, b: V3, t: number): V3 => add(a, scale(sub(b, a), t));
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// ---------- reading / writing the binary chunk ----------

function readAcc(json: RigGltf, bin: Buffer, index: number): number[][] {
  const a = json.accessors![index];
  const bv = json.bufferViews![a.bufferView!];
  const n = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 } as Record<string, number>)[a.type];
  const size = ({ 5126: 4, 5125: 4, 5123: 2, 5121: 1 } as Record<number, number>)[a.componentType];
  const stride = bv.byteStride ?? n * size;
  const base = 8 + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out: number[][] = [];
  for (let k = 0; k < a.count; k++) {
    const o = base + k * stride;
    out.push(
      Array.from({ length: n }, (_, c) => {
        const q = o + c * size;
        return a.componentType === 5126 ? bin.readFloatLE(q) : a.componentType === 5125 ? bin.readUInt32LE(q) : a.componentType === 5123 ? bin.readUInt16LE(q) : bin[q];
      }),
    );
  }
  return out;
}

/** Appends data to the BIN chunk (header included); returns the new chunk and the byte offset of the data. */
function appendBin(json: RigGltf, bin: Buffer, data: Buffer): { bin: Buffer; offset: number } {
  const body = bin.subarray(8);
  const pad = (4 - (body.length % 4)) % 4;
  const offset = body.length + pad;
  const tailPad = (4 - (data.length % 4)) % 4;
  const nb = Buffer.concat([body, Buffer.alloc(pad), data, Buffer.alloc(tailPad)]);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(nb.length, 0);
  header.write("BIN\0", 4, "latin1");
  if (json.buffers?.[0]) json.buffers[0].byteLength = nb.length;
  return { bin: Buffer.concat([header, nb]), offset };
}

// ---------- geometry helpers ----------

interface Piece {
  prim: { mesh: number; prim: number; node: number; pos: V3[] };
  verts: number[];
  top: number;
  bottom: number;
}

function pieces(pos: V3[], index: number[]): number[][] {
  const par = Int32Array.from({ length: pos.length }, (_, i) => i);
  const find = (a: number): number => {
    while (par[a] !== a) a = par[a] = par[par[a]];
    return a;
  };
  const first = new Map<string, number>();
  pos.forEach((p, i) => {
    const k = p.map((x) => Math.round(x * 1e5)).join();
    const f = first.get(k);
    if (f === undefined) first.set(k, i);
    else par[find(i)] = find(f);
  });
  for (let t = 0; t + 2 < index.length; t += 3) {
    par[find(index[t + 1])] = find(index[t]);
    par[find(index[t + 2])] = find(index[t]);
  }
  const g = new Map<number, number[]>();
  pos.forEach((_, i) => {
    const r = find(i);
    (g.get(r) ?? g.set(r, []).get(r)!).push(i);
  });
  return [...g.values()];
}

/** Boundary loops (holes) of a triangle mesh, as point lists. */
function holes(pos: V3[], index: number[]): V3[][] {
  const id = new Map<string, number>();
  const w = pos.map((p) => {
    const k = p.map((x) => Math.round(x * 1e5)).join();
    if (!id.has(k)) id.set(k, id.size);
    return id.get(k)!;
  });
  const at: V3[] = [];
  pos.forEach((p, i) => (at[w[i]] ??= p));
  const count = new Map<string, number>();
  for (let t = 0; t + 2 < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = w[index[t + k]];
      const b = w[index[t + ((k + 1) % 3)]];
      if (a === b) continue;
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }
  const adj = new Map<number, number[]>();
  for (const [key, c] of count) {
    if (c !== 1) continue;
    const [a, b] = key.split("_").map(Number);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const seen = new Set<number>();
  const out: V3[][] = [];
  for (const s of adj.keys()) {
    if (seen.has(s)) continue;
    const c: number[] = [];
    const st = [s];
    seen.add(s);
    while (st.length) {
      const a = st.pop()!;
      c.push(a);
      for (const b of adj.get(a) ?? []) if (!seen.has(b)) (seen.add(b), st.push(b));
    }
    if (c.length >= 6) out.push(c.map((i) => at[i]));
  }
  return out;
}

/** Straight line through points (centroid + main direction). */
function fitLine(pts: V3[]): { c: V3; d: V3 } {
  const c = scale(pts.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / pts.length);
  // power iteration on the covariance
  let d: V3 = [1, -0.3, 0];
  for (let it = 0; it < 30; it++) {
    let n: V3 = [0, 0, 0];
    for (const p of pts) {
      const q = sub(p, c);
      n = add(n, scale(q, dot(q, d)));
    }
    d = scale(n, 1 / (len(n) || 1));
  }
  return { c, d };
}

/** How a vertex past the wrist splits between the hand and the finger segments. */
function fingerWeights(f: NonNullable<ReturnType<typeof fingersOf>>, wrist: V3, p: V3): { hand: number; bones: [string, number][] } {
  const q = sub(p, wrist);
  const t = dot(q, f.u);
  const wv = dot(q, f.w);
  const L = f.L;
  const seg = (x: number, a: number, b: number, c: number, names: [string, string, string]): [string, number][] => {
    // blend smoothly across each joint (+-3% of the hand)
    const k1 = smooth((x - a + 0.03 * L) / (0.06 * L));
    const k2 = smooth((x - b + 0.03 * L) / (0.06 * L));
    const k3 = smooth((x - c + 0.03 * L) / (0.06 * L));
    return [[names[0], k1 * (1 - k2)], [names[1], k2 * (1 - k3)], [names[2], k3]];
  };
  if (f.thumb && wv > f.thumbEdge && t < 0.75 * L) {
    const s = dot(sub(p, f.thumb.base), f.thumb.dir) / (f.thumb.len || 1);
    const bones = seg(s, 0.1, 0.45, 0.72, ["ThumbMetacarpal", "ThumbProximal", "ThumbDistal"]).filter(([, x]) => x > 0);
    const used = bones.reduce((a, [, x]) => a + x, 0);
    return { hand: 1 - Math.min(1, used), bones };
  }
  const k = f.centers.reduce((b, c, j) => (Math.abs(wv - c) < Math.abs(wv - f.centers[b]) ? j : b), 0);
  const name = FINGERS[k];
  const bones = seg(t, 0.45 * L, 0.66 * L, 0.82 * L, [`${name}Proximal`, `${name}Intermediate`, `${name}Distal`]).filter(([, x]) => x > 0);
  const used = bones.reduce((a, [, x]) => a + x, 0);
  return { hand: 1 - Math.min(1, used), bones };
}

// ---------- the rig ----------

export const RIG_BONES = [
  "hips", "spine", "chest", "upperChest", "neck", "head", "leftEye", "rightEye",
  "leftShoulder", "leftUpperArm", "leftLowerArm", "leftHand", "rightShoulder", "rightUpperArm", "rightLowerArm", "rightHand",
  "leftUpperLeg", "leftLowerLeg", "leftFoot", "leftToes", "rightUpperLeg", "rightLowerLeg", "rightFoot", "rightToes",
  ...(["left", "right"] as const).flatMap((s) => [
    `${s}ThumbMetacarpal`, `${s}ThumbProximal`, `${s}ThumbDistal`,
    ...(["Index", "Middle", "Ring", "Little"] as const).flatMap((f) => [`${s}${f}Proximal`, `${s}${f}Intermediate`, `${s}${f}Distal`] as const),
  ] as const),
] as const;
type Bone = (typeof RIG_BONES)[number];
const PARENT: Partial<Record<Bone, Bone>> = {
  spine: "hips", chest: "spine", upperChest: "chest", neck: "upperChest", head: "neck", leftEye: "head", rightEye: "head",
  leftShoulder: "upperChest", leftUpperArm: "leftShoulder", leftLowerArm: "leftUpperArm", leftHand: "leftLowerArm",
  rightShoulder: "upperChest", rightUpperArm: "rightShoulder", rightLowerArm: "rightUpperArm", rightHand: "rightLowerArm",
  leftUpperLeg: "hips", leftLowerLeg: "leftUpperLeg", leftFoot: "leftLowerLeg", leftToes: "leftFoot",
  rightUpperLeg: "hips", rightLowerLeg: "rightUpperLeg", rightFoot: "rightLowerLeg", rightToes: "rightFoot",
};
for (const s of ["left", "right"] as const) {
  for (const f of ["Thumb", "Index", "Middle", "Ring", "Little"] as const) {
    const segs = f === "Thumb" ? ["Metacarpal", "Proximal", "Distal"] : ["Proximal", "Intermediate", "Distal"];
    segs.forEach((g, k) => (PARENT[`${s}${f}${g}` as Bone] = (k === 0 ? `${s}Hand` : `${s}${f}${segs[k - 1]}`) as Bone));
  }
}

const FINGERS = ["Index", "Middle", "Ring", "Little"] as const;

/**
 * Fingers of one hand, from the shape of the mesh beyond the wrist. Hand frame: u along the arm, w across the hand
 * (the fingers lie side by side along it; +w is the thumb's side, towards the front), n the third axis. The four
 * fingers are the four bands of vertices along w near the fingertips; the thumb is what lies beyond the index on
 * the thumb's side, closer to the wrist.
 */
function fingersOf(pts: V3[], wrist: V3, u: V3) {
  const rel = pts.map((p) => sub(p, wrist));
  const ts = rel.map((q) => dot(q, u));
  const L = Math.max(...ts);
  if (!(L > 0.02)) return undefined;
  // width axis: main spread of the hand across the arm; its sign towards the front (+z), where the thumb is
  const perp = rel.map((q, i) => sub(q, scale(u, ts[i])));
  let w = fitLine(perp.map((q) => q)).d;
  if (w[2] < 0) w = scale(w, -1);
  const n: V3 = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
  const ws = perp.map((q) => dot(q, w));
  const ns = perp.map((q) => dot(q, n));
  // the four fingers near their tips (the thumb is shorter)
  const tipIdx = ts.map((t, i) => i).filter((i) => ts[i] > 0.7 * L && ts[i] < 0.96 * L);
  if (tipIdx.length < 12) return undefined;
  const wsTip = tipIdx.map((i) => ws[i]);
  let lo = Math.min(...wsTip), hi = Math.max(...wsTip);
  let centers = [0, 1, 2, 3].map((k) => hi - ((k + 0.5) / 4) * (hi - lo)); // index (thumb side) first
  for (let it = 0; it < 12; it++) {
    const sums = centers.map(() => [0, 0]);
    for (const i of tipIdx) {
      const k = centers.reduce((b, c, j) => (Math.abs(ws[i] - c) < Math.abs(ws[i] - centers[b]) ? j : b), 0);
      sums[k][0] += ws[i];
      sums[k][1]++;
    }
    centers = centers.map((c, k) => (sums[k][1] ? sums[k][0] / sums[k][1] : c));
  }
  const nMean = (k: number) => {
    const sel = tipIdx.filter((i) => centers.reduce((b, c, j) => (Math.abs(ws[i] - c) < Math.abs(ws[i] - centers[b]) ? j : b), 0) === k);
    return sel.length ? sel.reduce((s, i) => s + ns[i], 0) / sel.length : 0;
  };
  const at = (t: number, wv: number, nv: number): V3 => add(add(add(wrist, scale(u, t)), scale(w, wv)), scale(n, nv));
  const joints: Record<string, V3> = {};
  const spacing = Math.abs(centers[0] - centers[3]) / 3 || 0.01;
  FINGERS.forEach((f, k) => {
    const nk = nMean(k);
    joints[`${f}Proximal`] = at(0.45 * L, centers[k], nk);
    joints[`${f}Intermediate`] = at(0.66 * L, centers[k], nk);
    joints[`${f}Distal`] = at(0.82 * L, centers[k], nk);
  });
  // thumb: beyond the index on the thumb's side, in the first part of the hand
  const thumbEdge = centers[0] + 0.6 * spacing;
  const thumbIdx = ts.map((t, i) => i).filter((i) => ws[i] > thumbEdge && ts[i] < 0.75 * L);
  let thumb: { base: V3; dir: V3; len: number } | undefined;
  if (thumbIdx.length >= 8) {
    const tp = thumbIdx.map((i) => pts[i]);
    let { c, d } = fitLine(tp);
    if (dot(d, u) < 0) d = scale(d, -1); // from the wrist out
    const proj = tp.map((p) => dot(sub(p, c), d));
    const a = Math.min(...proj), b = Math.max(...proj);
    const base = add(c, scale(d, a));
    thumb = { base, dir: d, len: b - a };
    joints.ThumbMetacarpal = add(base, scale(d, 0.1 * (b - a)));
    joints.ThumbProximal = add(base, scale(d, 0.45 * (b - a)));
    joints.ThumbDistal = add(base, scale(d, 0.72 * (b - a)));
  }
  return { L, w, n, centers, thumbEdge, thumb, joints, u };
}

export interface RigResult {
  json: RigGltf;
  bin: Buffer;
  /** VRM 1.0 bone name -> node index. */
  humanBones: Record<string, number>;
  joints: Record<string, V3>;
}

/** True when the file has meshes but no skeleton at all. */
/**
 * The model's meshes in world space: one array of points per primitive of each mesh node. `bind`: skinned meshes
 * as they were modelled (their bind pose, the vertices as stored), else as they look at rest (skinning applied).
 */
export function restShape(json: RigGltf, bin: Buffer, bind = false): { node: number; prim: number; pos: V3[]; normal?: V3[]; blend?: M4[] }[] {
  const W = worldMatrices(json);
  const jm = (json.skins ?? []).map((s) => {
    const ibm = s.inverseBindMatrices !== undefined ? readAcc(json, bin, s.inverseBindMatrices) : s.joints.map(() => IDENTITY);
    return s.joints.map((j, k) => mul(W[j], ibm[k]));
  });
  const out: ReturnType<typeof restShape> = [];
  json.nodes.forEach((n, ni) => {
    if (n.mesh === undefined) return;
    json.meshes![n.mesh].primitives.forEach((p, pi) => {
      const local = readAcc(json, bin, p.attributes.POSITION);
      const nrm = p.attributes.NORMAL !== undefined ? readAcc(json, bin, p.attributes.NORMAL) : undefined;
      const skin = n.skin !== undefined ? jm[n.skin] : undefined;
      if (!skin || p.attributes.JOINTS_0 === undefined || p.attributes.WEIGHTS_0 === undefined || bind) {
        const m = skin && bind ? IDENTITY : W[ni]; // (a skinned mesh's own node transform does not apply to it)
        out.push({ node: ni, prim: pi, pos: local.map((v) => apply(m, v)), normal: nrm?.map((v) => dirOf(m, v)), blend: local.map(() => m) });
        return;
      }
      const js = readAcc(json, bin, p.attributes.JOINTS_0);
      const wa = json.accessors![p.attributes.WEIGHTS_0];
      const norm = wa.componentType === 5121 ? 255 : wa.componentType === 5123 ? 65535 : 1;
      const ws = readAcc(json, bin, p.attributes.WEIGHTS_0).map((w) => w.map((x) => x / norm));
      const blend = local.map((_, i) => {
        const m = new Array(16).fill(0);
        let t = 0;
        for (let k = 0; k < 4; k++) {
          const w = ws[i][k];
          if (!w) continue;
          t += w;
          const jmk = skin[js[i][k]] ?? IDENTITY;
          for (let e = 0; e < 16; e++) m[e] += w * jmk[e];
        }
        return t > 0 ? m.map((x) => x / t) : W[ni];
      });
      out.push({ node: ni, prim: pi, pos: local.map((v, i) => apply(blend[i], v)), normal: nrm?.map((v, i) => dirOf(blend[i], v)), blend });
    });
  });
  return out;
}

const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function dirOf(m: M4, v: number[]): V3 {
  const d: V3 = [0, 1, 2].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2]) as V3;
  const l = Math.hypot(...d) || 1;
  return [d[0] / l, d[1] / l, d[2] / l];
}

/**
 * Takes the skeleton off a model (its meshes keep the shape they were modelled in), so it
 * can be rigged again from its shape: for models whose skeleton does not match the body (e.g. from an online
 * auto-rigger that put the head joint at the chest). Returns the new BIN chunk.
 */
export function unskin(json: RigGltf, binIn: Buffer): Buffer {
  const W = worldMatrices(json);
  // the shape as modelled: a skeleton that does not fit the body would have bent it out of shape at rest
  const shape = restShape(json, binIn, true);
  let bin = binIn;
  const addAccessor = (data: Buffer, acc: Omit<Acc, "bufferView">) => {
    const r = appendBin(json, bin, data);
    bin = r.bin;
    json.bufferViews!.push({ buffer: 0, byteOffset: r.offset, byteLength: data.length });
    json.accessors!.push({ ...acc, bufferView: json.bufferViews!.length - 1 });
    return json.accessors!.length - 1;
  };
  const vec3 = (pts: V3[], withBounds: boolean) => {
    const b = Buffer.alloc(pts.length * 12);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    pts.forEach((v, i) => v.forEach((x, c) => {
      b.writeFloatLE(x, i * 12 + c * 4);
      lo[c] = Math.min(lo[c], x);
      hi[c] = Math.max(hi[c], x);
    }));
    return addAccessor(b, { componentType: 5126, count: pts.length, type: "VEC3", ...(withBounds ? { min: lo, max: hi } : {}) });
  };
  const jointSet = new Set((json.skins ?? []).flatMap((s) => s.joints));
  for (const sh of shape) {
    const node = json.nodes[sh.node];
    const prim = json.meshes![node.mesh!].primitives[sh.prim] as Prim & { targets?: Record<string, number>[] };
    if (node.skin === undefined && !prim.attributes.JOINTS_0) continue;
    // the mesh node may sit anywhere: its vertices are stored in its own frame
    const inv = invert(W[sh.node]);
    prim.attributes.POSITION = vec3(sh.pos.map((v) => apply(inv, v)), true);
    if (sh.normal) prim.attributes.NORMAL = vec3(sh.normal.map((v) => dirOf(inv, v)), false);
    // morph targets are offsets in the old bind frame: turn them with each vertex's own skinning
    prim.targets?.forEach((t) => {
      for (const key of ["POSITION", "NORMAL"]) {
        if (t[key] === undefined) continue;
        const d = readAcc(json, binIn, t[key]);
        const turned = d.map((v, i) => {
          const m = mul(inv, sh.blend![i]);
          const r: V3 = [0, 1, 2].map((c) => m[c] * v[0] + m[4 + c] * v[1] + m[8 + c] * v[2]) as V3;
          return r;
        });
        t[key] = vec3(turned, key === "POSITION");
      }
    });
    delete prim.attributes.JOINTS_0;
    delete prim.attributes.WEIGHTS_0;
    delete node.skin;
  }
  json.skins = [];
  // the old skeleton leaves the scene (anything that is not a joint under it moves up to the scene's root)
  const parent = new Map<number, number>();
  json.nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  const scene = json.scenes?.[json.scene ?? 0];
  const keep = (i: number, under: number | undefined) => {
    // re-attach a non-joint node found below a joint to the first non-joint ancestor (or the scene), keeping its place
    const n = json.nodes[i];
    const w = W[i];
    if (under === undefined) (scene!.nodes ??= []).push(i);
    else (json.nodes[under].children ??= []).push(i);
    const pw = under === undefined ? IDENTITY : W[under];
    n.matrix = mul(invert(pw), w);
    delete n.translation;
    delete n.rotation;
    delete n.scale;
  };
  const walk = (i: number, anchor: number | undefined) => {
    for (const c of [...(json.nodes[i].children ?? [])]) {
      if (!jointSet.has(c)) {
        json.nodes[i].children = json.nodes[i].children!.filter((k) => k !== c);
        keep(c, anchor);
      } else walk(c, anchor);
    }
  };
  for (const j of jointSet) {
    const p = parent.get(j);
    if (p !== undefined && jointSet.has(p)) continue; // only the top of each skeleton
    if (p !== undefined) json.nodes[p].children = json.nodes[p].children!.filter((c) => c !== j);
    else if (scene?.nodes) scene.nodes = scene.nodes.filter((c) => c !== j);
    walk(j, p);
  }
  for (const n of json.nodes) if (n.children && !n.children.length) delete n.children;
  return bin;
}

export function needsRig(json: RigGltf): boolean {
  return !json.skins?.length && json.nodes.some((n) => n.mesh !== undefined);
}

export function autoRig(json: RigGltf, binIn: Buffer): RigResult {
  const W = worldMatrices(json);
  // every primitive, in world space
  const prims: { node: number; mesh: number; prim: number; pos: V3[]; index: number[] }[] = [];
  json.nodes.forEach((n, ni) => {
    if (n.mesh === undefined) return;
    json.meshes![n.mesh].primitives.forEach((p, pi) => {
      const local = readAcc(json, binIn, p.attributes.POSITION);
      const pos = local.map((v) => apply(W[ni], v));
      const index = p.indices !== undefined ? readAcc(json, binIn, p.indices).map((v) => v[0]) : pos.map((_, i) => i);
      prims.push({ node: ni, mesh: n.mesh!, prim: pi, pos, index });
    });
  });
  if (!prims.length) throw new Error("el modelo no tiene mallas");
  const all = prims.flatMap((p) => p.pos);
  const minY = Math.min(...all.map((p) => p[1]));
  const H = Math.max(...all.map((p) => p[1])) - minY;
  const Y = (f: number) => minY + f * H;
  const cx = (Math.min(...all.map((p) => p[0])) + Math.max(...all.map((p) => p[0]))) / 2;

  // Arms: what sticks out sideways (beyond the hair and the torso), above the waist.
  const armLine = (side: number) => {
    const pts = all.filter((p) => (p[0] - cx) * side > 0.17 * H && p[1] > Y(0.45));
    if (pts.length < 20) throw new Error("no se encuentran los brazos (el modelo debe estar en pose T o A)");
    // (through the middle of each slice across the arm: a wide sleeve or cape would tilt a plain fit of all its
    // points towards the front or back)
    const mids: V3[] = [];
    const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const step = 0.02 * H;
    const bins = new Map<number, V3[]>();
    for (const p of pts) {
      const k = Math.floor(((p[0] - cx) * side) / step);
      (bins.get(k) ?? bins.set(k, []).get(k)!).push(p);
    }
    // (the innermost quarter can still catch hair or a cape beside the shoulder: left out)
    const reach0 = Math.max(...pts.map((p) => (p[0] - cx) * side));
    const inner = 0.17 * H + 0.25 * (reach0 - 0.17 * H);
    for (const b of bins.values()) {
      if (b.length < 3 || med(b.map((p) => (p[0] - cx) * side)) < inner) continue;
      mids.push([med(b.map((p) => p[0])), med(b.map((p) => p[1])), med(b.map((p) => p[2]))]);
    }
    let { c, d } = fitLine(pts);
    // (only when the plain fit runs steeply front to back, which an arm in a T- or A-pose does not)
    const detailed = pts.length > 300 && mids.length >= 5 && Math.abs(d[2]) > 0.35;
    if (detailed) ({ c, d } = fitLine(mids));
    if (detailed) {
      // Its depth (front to back): near the shoulder, long hair falling down the back (or a wide sleeve) would pull
      // it backwards, so the arm runs from the body's middle depth (that of the thighs, where nothing hangs over
      // them) at the shoulder to the middle of its outer half.
      const reach = Math.max(...pts.map((p) => (p[0] - cx) * side));
      const outer = pts.filter((p) => (p[0] - cx) * side > (0.17 * H + reach) / 2);
      const thighs = all.filter((p) => p[1] > Y(0.25) && p[1] < Y(0.35)).map((p) => p[2]);
      if (outer.length >= 10 && thighs.length >= 10) {
        const xo = med(outer.map((p) => p[0])), zo = med(outer.map((p) => p[2]));
        const xs = cx + side * 0.1 * H, zs = med(thighs);
        const l = Math.hypot(d[0], d[1]) || 1;
        const dx = d[0] / l, dy = d[1] / l;
        const yo = c[1] + (dy / (dx || 1e-6)) * (xo - c[0]);
        const slope = (zo - zs) / (xo - xs || 1e-6);
        const dd: V3 = [dx, dy, slope * dx];
        d = scale(dd, 1 / len(dd));
        c = [xo, yo, zo];
      }
    }
    if (d[0] * side < 0) d = scale(d, -1); // pointing out, towards the hand
    const tip = pts.reduce((a, b) => (dot(sub(b, c), d) > dot(sub(a, c), d) ? b : a));
    const along = (x: number) => add(c, scale(d, (x - c[0]) / (d[0] || 1e-6))); // point of the line at a given x
    const shoulder = along(cx + side * 0.1 * H);
    const tipOnLine = add(c, scale(d, dot(sub(tip, c), d)));
    const wrist = sub(tipOnLine, scale(d, 0.085 * H));
    const elbow = lerp(shoulder, wrist, 0.48);
    return { d, shoulder, elbow, wrist };
  };
  const armL = armLine(1); // +x: her left (facing +z)
  const armR = armLine(-1);
  // Hands: what lies beyond the wrist along the arm (close to its line).
  const handOf = (a: ReturnType<typeof armLine>) => {
    const pts = all.filter((p) => {
      const t = dot(sub(p, a.wrist), a.d);
      const r = len(sub(sub(p, a.wrist), scale(a.d, t)));
      return t > -0.005 * H && t < 0.14 * H && r < 0.06 * H;
    });
    return pts.length > 30 ? fingersOf(pts, a.wrist, a.d) : undefined;
  };
  const handL = handOf(armL);
  const handR = handOf(armR);
  const shoulderY = (armL.shoulder[1] + armR.shoulder[1]) / 2;

  // Legs: below the hem the legs stand apart. Where something covers the middle (skirt or crotch) they end.
  let crotch = Y(0.3);
  for (let f = 0.12; f < 0.6; f += 0.005) {
    const y = Y(f);
    const mid = all.some((p) => Math.abs(p[1] - y) < 0.004 * H && Math.abs(p[0] - cx) < 0.008 * H);
    if (mid) break;
    crotch = y;
  }
  const hipY = Math.min(Y(0.56), Math.max(Y(0.45), crotch + 0.08 * H));
  const legAt = (side: number, y: number): V3 => {
    const pts = all.filter((p) => Math.abs(p[1] - y) < 0.01 * H && (p[0] - cx) * side > 0.004 * H && (p[0] - cx) * side < 0.12 * H);
    if (!pts.length) return [cx + side * 0.05 * H, y, 0];
    return [pts.reduce((s, p) => s + p[0], 0) / pts.length, y, pts.reduce((s, p) => s + p[2], 0) / pts.length];
  };
  const leg = (side: number) => {
    const low = legAt(side, Y(0.1));
    const high = legAt(side, Math.min(crotch - 0.02 * H, Y(0.38)));
    const k = (hipY - low[1]) / (high[1] - low[1] || 1);
    const hip: V3 = [low[0] + (high[0] - low[0]) * k, hipY, low[2] + (high[2] - low[2]) * k];
    if (Math.abs(hip[0] - cx) < 0.03 * H) hip[0] = cx + side * 0.03 * H;
    const ankle: V3 = [low[0] + (high[0] - low[0]) * ((Y(0.045) - low[1]) / (high[1] - low[1] || 1)), Y(0.045), low[2]];
    const knee = lerp(ankle, hip, 0.5);
    knee[1] += 0.01 * H;
    const foot = all.filter((p) => p[1] < Y(0.03) && (p[0] - cx) * side > 0);
    const front = foot.length ? Math.max(...foot.map((p) => p[2])) : ankle[2] + 0.05 * H;
    const toes: V3 = [ankle[0], Y(0.012), ankle[2] + 0.6 * (front - ankle[2])];
    return { hip, knee, ankle, toes };
  };
  const legL = leg(1);
  const legR = leg(-1);

  // Spine, neck and head: heights from the hips and shoulders; depth from the body itself.
  const depthAt = (y: number, halfW: number) => {
    const pts = all.filter((p) => Math.abs(p[1] - y) < 0.01 * H && Math.abs(p[0] - cx) < halfW);
    return pts.length ? (Math.min(...pts.map((p) => p[2])) + Math.max(...pts.map((p) => p[2]))) / 2 : 0;
  };
  let neckY = shoulderY + 0.025 * H;
  let headY = neckY + 0.04 * H;
  // A big head (stylised proportions) reaches lower than usual: the head turns from just below the chin. The chin
  // is where the front of the face steps back to the neck (looking down the middle of the body, below the
  // usual head height): only ever lowers the head.
  {
    const front = (y: number) => {
      const z = all.filter((p) => Math.abs(p[1] - y) < 0.005 * H && Math.abs(p[0] - cx) < 0.015 * H).map((p) => p[2]);
      return z.length >= 3 ? Math.max(...z) : undefined;
    };
    let prev = front(headY);
    for (let y = headY - 0.01 * H; y > shoulderY + 0.03 * H; y -= 0.01 * H) {
      const f = front(y);
      if (f !== undefined && prev !== undefined && f < prev - 0.015 * H) {
        headY = y + 0.005 * H;
        neckY = Math.min(neckY, headY - 0.03 * H);
        break;
      }
      if (f !== undefined) prev = f;
    }
  }
  const at = (y: number, halfW = 0.08 * H): V3 => [cx, y, depthAt(y, halfW)];
  const J: Record<string, V3> = {
    hips: at(hipY),
    spine: at(hipY + 0.25 * (shoulderY - hipY)),
    chest: at(hipY + 0.55 * (shoulderY - hipY)),
    upperChest: at(hipY + 0.8 * (shoulderY - hipY)),
    neck: at(neckY, 0.03 * H),
    head: at(headY, 0.05 * H),
  };
  for (const [s, hnd] of [["left", handL], ["right", handR]] as const) {
    if (!hnd) continue;
    for (const [k, v] of Object.entries(hnd.joints)) J[`${s}${k}`] = v;
    if (!hnd.thumb) for (const g of ["Metacarpal", "Proximal", "Distal"]) delete J[`${s}Thumb${g}`];
  }
  for (const [s, a, l] of [["left", armL, legL], ["right", armR, legR]] as const) {
    const side = s === "left" ? 1 : -1;
    J[`${s}Shoulder`] = [cx + side * 0.025 * H, shoulderY - 0.005 * H, J.upperChest[2]];
    J[`${s}UpperArm`] = a.shoulder;
    J[`${s}LowerArm`] = a.elbow;
    J[`${s}Hand`] = a.wrist;
    J[`${s}UpperLeg`] = l.hip;
    J[`${s}LowerLeg`] = l.knee;
    J[`${s}Foot`] = l.ankle;
    J[`${s}Toes`] = l.toes;
  }

  // Pieces of the mesh: those that reach the top of the head move with it (hair, face, eyes, ornaments).
  const allPieces: (Piece & { headPart: boolean })[] = [];
  for (const p of prims) {
    for (const verts of pieces(p.pos, p.index)) {
      const ys = verts.map((i) => p.pos[i][1]);
      const top = Math.max(...ys);
      const bottom = Math.min(...ys);
      allPieces.push({ prim: p, verts, top, bottom, headPart: top > Y(0.9) || bottom > headY + 0.01 * H });
    }
  }

  // Eyes: a mirrored pair of openings in the face (pieces of the head), at eye height.
  const eyeHoles: { c: V3; w: number; box: number[] }[] = [];
  for (const p of prims) {
    for (const h of holes(p.pos, p.index)) {
      const xs = h.map((q) => q[0]);
      const ys = h.map((q) => q[1]);
      const w = Math.max(...xs) - Math.min(...xs);
      const hh = Math.max(...ys) - Math.min(...ys);
      const c: V3 = [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, Math.max(...h.map((q) => q[2]))];
      // eyes sit in the upper half of the head (an anime head is about 1/6-1/7 of the height), near the middle
      if (c[1] < Math.max(headY + 0.03 * H, Y(0.85)) || c[1] > Y(0.97) || w < 0.01 * H || w > 0.06 * H || hh < 0.006 * H) continue;
      if (Math.abs(c[0] - cx) < 0.008 * H || Math.abs(c[0] - cx) > 0.05 * H) continue;
      if (hh > 0.04 * H || hh > 1.3 * w) continue; // gaps between strands of hair are long and narrow
      eyeHoles.push({ c, w, box: [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] });
    }
  }
  let eyePair: [V3, V3] | undefined;
  let best = Infinity;
  for (const a of eyeHoles) for (const b of eyeHoles) {
    if (a.c[0] - cx <= 0 || b.c[0] - cx >= 0) continue;
    const mirror = Math.abs(a.c[0] - cx + (b.c[0] - cx)) + Math.abs(a.c[1] - b.c[1]) + Math.abs(a.c[2] - b.c[2]);
    // An eye is layered: its opening holds more openings (eye white, iris, eyelid patches); a hole in the hair
    // does not. So the symmetric pair with the most holes inside it, then the biggest.
    const nested = (e: { box: number[] }) => eyeHoles.filter((o) => o.c[0] > e.box[0] && o.c[0] < e.box[1] && o.c[1] > e.box[2] && o.c[1] < e.box[3]).length;
    const score = -Math.min(nested(a), nested(b)) * 1000 - (a.w + b.w) / H;
    if (mirror < 0.006 * H && score < best) {
      best = score;
      eyePair = [a.c, b.c];
    }
  }
  if (eyePair) {
    J.leftEye = [eyePair[0][0], eyePair[0][1], eyePair[0][2] - 0.012 * H];
    J.rightEye = [eyePair[1][0], eyePair[1][1], eyePair[1][2] - 0.012 * H];
  }

  // Hair that hangs below the neck: chains of bones around the head (one every 36 degrees where there is hair),
  // so it can swing (spring physics in the app). Short hair and the face stay with the head.
  const hairPiece = (pc: { headPart: boolean; bottom: number }) => pc.headPart && pc.bottom < neckY;
  const rootY = J.head[1] + 0.04 * H; // about ear height: above it the hair lies on the head
  const hc = J.head;
  const angleOf = (p: V3) => Math.atan2(p[0] - hc[0], p[2] - hc[2]);
  const BINS = 10;
  const binOf = (a: number) => ((Math.floor(((a + Math.PI) / (2 * Math.PI)) * BINS) % BINS) + BINS) % BINS;
  const hairPts: V3[][] = Array.from({ length: BINS }, () => []);
  for (const pc of allPieces) {
    if (!hairPiece(pc)) continue;
    for (const i of pc.verts) {
      const v = pc.prim.pos[i];
      if (v[1] < rootY) hairPts[binOf(angleOf(v))].push(v);
    }
  }
  const chains: { bin: number; names: string[]; ys: number[] }[] = [];
  const PARENTS: Record<string, string> = { ...(PARENT as Record<string, string>) };
  hairPts.forEach((pts, bin) => {
    if (pts.length < 30) return;
    const bottom = Math.min(...pts.map((v) => v[1]));
    if (rootY - bottom < 0.06 * H) return;
    const ys = [0, 0.16, 0.33, 0.5, 0.66, 0.82, 0.96].map((f) => rootY - f * (rootY - bottom));
    const names: string[] = [];
    let prev: V3 | undefined;
    ys.forEach((y, k) => {
      const near = pts.filter((v) => Math.abs(v[1] - y) < 0.03 * H);
      const at: V3 = near.length
        ? [near.reduce((a, v) => a + v[0], 0) / near.length, y, near.reduce((a, v) => a + v[2], 0) / near.length]
        : prev ? [prev[0], y, prev[2]] : [hc[0], y, hc[2]];
      const name = `hair_${bin}_${k}`;
      J[name] = at;
      PARENTS[name] = k === 0 ? "head" : `hair_${bin}_${k - 1}`;
      names.push(name);
      prev = at;
    });
    chains.push({ bin, names, ys });
  });
  const hairBones = chains.flatMap((c) => c.names);

  const bones = [...RIG_BONES.filter((b) => J[b]), ...hairBones];
  const bi = new Map<string, number>(bones.map((b, i) => [b, i]));

  // ---------- weights ----------
  const weightsOf = (p: V3, part: number): [string, number][] => {
    const headPart = part > 0;
    const w = new Map<string, number>();
    const put = (b: string, v: number) => v > 0 && w.set(b, (w.get(b) ?? 0) + v);
    if (part === 2 && chains.length && p[1] < rootY + 0.02 * H) {
      // hanging hair: the two nearest chains around the head, and along each chain by height
      const a = angleOf(p);
      const angDist = (c: { bin: number }) => {
        const mid = -Math.PI + ((c.bin + 0.5) / BINS) * 2 * Math.PI;
        let d = Math.abs(a - mid);
        if (d > Math.PI) d = 2 * Math.PI - d;
        return d;
      };
      const near = [...chains].sort((x, y) => angDist(x) - angDist(y)).slice(0, 2);
      const d0 = angDist(near[0]);
      const d1 = near[1] ? angDist(near[1]) : Infinity;
      const w0 = near[1] ? d1 / (d0 + d1 || 1) : 1;
      const root = smooth((rootY + 0.02 * H - p[1]) / (0.04 * H)); // blends in from the head
      put("head", 1 - root);
      near.forEach((c, ci) => {
        const k = ci === 0 ? w0 : 1 - w0;
        const ys = c.ys;
        if (p[1] >= ys[0]) return put(c.names[0], root * k);
        for (let j = 0; j < ys.length - 1; j++) {
          if (p[1] >= ys[j + 1]) {
            const t = (ys[j] - p[1]) / (ys[j] - ys[j + 1] || 1);
            put(c.names[j], root * k * (1 - t));
            put(c.names[j + 1], root * k * t);
            return;
          }
        }
        put(c.names[ys.length - 1], root * k);
      });
      return [...w];
    }
    if (headPart) {
      // long hair below the neck follows the chest more and more (but stays mostly the head's: it is not body)
      const a = 0.45 * smooth((neckY - p[1]) / (0.15 * H));
      put("head", 1 - a);
      put("upperChest", a);
      return [...w];
    }
    // spine chain by height
    const spine = (k: number) => {
      const chain: [string, number][] = [["hips", J.hips[1]], ["spine", J.spine[1]], ["chest", J.chest[1]], ["upperChest", J.upperChest[1]], ["neck", J.neck[1]], ["head", J.head[1]]];
      const y = p[1];
      if (y <= chain[0][1]) return put("hips", k);
      for (let i = 0; i < chain.length - 1; i++) {
        const [a, ya] = chain[i];
        const [b, yb] = chain[i + 1];
        if (y <= yb) {
          const t = smooth((y - ya) / (yb - ya));
          put(a, k * (1 - t));
          put(b, k * t);
          return;
        }
      }
      put("head", k);
    };
    // arms
    for (const [s, a] of [["left", armL], ["right", armR]] as const) {
      const side = s === "left" ? 1 : -1;
      if ((p[0] - cx) * side < 0.05 * H) continue;
      const t = dot(sub(p, a.shoulder), a.d);
      const r = len(sub(sub(p, a.shoulder), scale(a.d, t)));
      const radius = 0.045 * H + 0.04 * H * smooth(1 - t / (0.08 * H)); // wider at the shoulder (sleeves)
      if (t < -0.03 * H || r > radius) continue;
      const tE = dot(sub(a.elbow, a.shoulder), a.d);
      const tW = dot(sub(a.wrist, a.shoulder), a.d);
      const toArm = smooth((t + 0.02 * H) / (0.045 * H)); // body -> arm at the shoulder
      const e = smooth((t - tE + 0.02 * H) / (0.04 * H));
      const h = smooth((t - tW + 0.012 * H) / (0.024 * H));
      put(`${s}UpperArm`, toArm * (1 - e));
      put(`${s}LowerArm`, toArm * e * (1 - h));
      const fingers = (s === "left" ? handL : handR);
      const fw = fingers ? fingerWeights(fingers, a.wrist, p) : undefined;
      if (fw) {
        put(`${s}Hand`, toArm * h * fw.hand);
        for (const [b, x] of fw.bones) put(`${s}${b}`, toArm * h * x);
      } else put(`${s}Hand`, toArm * h);
      if (toArm < 1) {
        put(`${s}Shoulder`, (1 - toArm) * 0.6);
        spine((1 - toArm) * 0.4);
      }
      return [...w];
    }
    // legs (below the hips, near a leg's axis; a skirt further out stays with the hips)
    if (p[1] < hipY) {
      const side = p[0] >= cx ? 1 : -1;
      const l = side > 0 ? legL : legR;
      const s = side > 0 ? "left" : "right";
      const axis = (y: number): V3 => {
        if (y >= l.knee[1]) return lerp(l.knee, l.hip, (y - l.knee[1]) / (l.hip[1] - l.knee[1] || 1));
        return lerp(l.ankle, l.knee, Math.max(0, (y - l.ankle[1]) / (l.knee[1] - l.ankle[1] || 1)));
      };
      const q = axis(p[1]);
      const r = Math.hypot(p[0] - q[0], p[2] - q[2]);
      const reach = p[1] < l.ankle[1] + 0.01 * H ? 0.16 * H : 0.075 * H; // feet stick out forward
      const onLeg = p[1] < crotch ? smooth((reach - r) / (0.02 * H)) : smooth((0.06 * H - r) / (0.02 * H)) * smooth((hipY - p[1]) / (hipY - crotch || 1));
      if (onLeg > 0) {
        const kn = smooth((l.knee[1] + 0.02 * H - p[1]) / (0.04 * H)); // 1 below the knee
        const an = smooth((l.ankle[1] + 0.012 * H - p[1]) / (0.024 * H)); // 1 below the ankle
        put(`${s}UpperLeg`, onLeg * (1 - kn));
        put(`${s}LowerLeg`, onLeg * kn * (1 - an));
        put(`${s}Foot`, onLeg * an);
      }
      if (onLeg < 1) put("hips", 1 - onLeg);
      return [...w];
    }
    spine(1);
    return [...w];
  };

  // ---------- write: joints, skin, JOINTS_0 / WEIGHTS_0 ----------
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
  const rootIdx = roots[0] ?? 0;
  const rootW = W[rootIdx];
  const rootInv = invert(rootW);
  const firstJoint = json.nodes.length;
  const nodeOf = (b: string) => firstJoint + bi.get(b)!;
  bones.forEach((b) => {
    const parent = PARENTS[b];
    const pw = parent ? J[parent] : undefined;
    // joints have no rotation: their local offset is the world offset brought into the parent's (root's) frame
    const local = pw ? apply(rootInv, J[b]).map((v, k) => v - apply(rootInv, pw)[k]) : apply(rootInv, J[b]);
    json.nodes.push({ name: `rig_${b}`, translation: local });
  });
  bones.forEach((b) => {
    const parent = PARENTS[b];
    if (parent) (json.nodes[nodeOf(parent)].children ??= []).push(nodeOf(b));
  });
  (json.nodes[rootIdx].children ??= []).push(nodeOf("hips"));

  // World matrix of each joint (rest): root rotation/scale with the joint at its position.
  const jointWorld = bones.map((b) => {
    const m = [...rootW];
    m[12] = J[b][0];
    m[13] = J[b][1];
    m[14] = J[b][2];
    return m;
  });

  let bin = binIn;
  const addAccessor = (data: Buffer, acc: Omit<Acc, "bufferView">) => {
    const r = appendBin(json, bin, data);
    bin = r.bin;
    json.bufferViews!.push({ buffer: 0, byteOffset: r.offset, byteLength: data.length });
    json.accessors!.push({ ...acc, bufferView: json.bufferViews!.length - 1 });
    return json.accessors!.length - 1;
  };

  const skins = new Map<number, number>(); // mesh node -> skin
  for (const p of prims) {
    if (!skins.has(p.node)) {
      // inverse bind = (joint world)^-1 * mesh world, so the mesh stays where it was
      const ibm = Buffer.alloc(bones.length * 64);
      bones.forEach((_, k) => mul(invert(jointWorld[k]), W[p.node]).forEach((v, c) => ibm.writeFloatLE(v, k * 64 + c * 4)));
      const acc = addAccessor(ibm, { componentType: 5126, count: bones.length, type: "MAT4" });
      (json.skins ??= []).push({ joints: bones.map((b) => nodeOf(b)), inverseBindMatrices: acc, skeleton: nodeOf("hips") });
      skins.set(p.node, json.skins.length - 1);
      json.nodes[p.node].skin = json.skins.length - 1;
    }
    const part = new Uint8Array(p.pos.length); // 0 body, 1 head, 2 hanging hair
    for (const pc of allPieces) if (pc.prim === p && pc.headPart) for (const i of pc.verts) part[i] = hairPiece(pc) ? 2 : 1;
    const jb = Buffer.alloc(p.pos.length * 8);
    const wb = Buffer.alloc(p.pos.length * 16);
    p.pos.forEach((v, i) => {
      const ws = weightsOf(v, part[i]).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const total = ws.reduce((s, [, x]) => s + x, 0) || 1;
      if (!ws.length) ws.push(["hips", 1]);
      ws.forEach(([b, x], k) => {
        jb.writeUInt16LE(bi.get(b) ?? 0, i * 8 + k * 2);
        wb.writeFloatLE(x / total, i * 16 + k * 4);
      });
    });
    const prim = json.meshes![p.mesh].primitives[p.prim];
    prim.attributes.JOINTS_0 = addAccessor(jb, { componentType: 5123, count: p.pos.length, type: "VEC4" });
    prim.attributes.WEIGHTS_0 = addAccessor(wb, { componentType: 5126, count: p.pos.length, type: "VEC4" });
  }
  const human = new Set<string>(RIG_BONES);
  return { json, bin, humanBones: Object.fromEntries(bones.filter((b) => human.has(b)).map((b) => [b, nodeOf(b)])), joints: J as Record<string, V3> };
}

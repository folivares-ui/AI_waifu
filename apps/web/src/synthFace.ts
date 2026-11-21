import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { EyeCurtain } from "./eyeCurtain";

/**
 * Eyelids and mouth opening for models that have neither blendshapes nor eyelid/jaw bones (e.g. models converted
 * from games whose expressions were blendshapes that got lost in the conversion), but whose face mesh has
 * eye openings (the eyeballs are separate meshes behind them) and a mouth slit.
 *
 * The missing movements are built from the model's own geometry when it loads, as morph targets:
 *  - upper lid: the skin and lashes above each eye slide down to the lower lid, staying in front of the eyeball;
 *  - lower lid: the same, upwards (smiling eyes);
 *  - mouth: everything below the lip line drops like a jaw, more in the middle than at the corners.
 *
 * Everything below works in a "face frame": metres, +y up, +z towards the front of the face (x is left/right,
 * either sign). The core is pure (arrays in, arrays out) so it can be tested without a renderer.
 */

export type V3 = [number, number, number];

export interface FaceMeshIn {
  /** xyz per vertex, face frame. */
  pos: Float32Array;
  index: ArrayLike<number>;
  /** 1 if the vertex mostly follows the head bone itself (not an eye, eyebrow, mouth... bone). */
  onHead: Uint8Array;
}

export interface FaceMorphs {
  /** Per mesh (same order as the input), per target: displacement per vertex in the face frame (undefined = untouched). */
  upper: (Float32Array | undefined)[];
  lower: (Float32Array | undefined)[];
  mouth: (Float32Array | undefined)[];
  /** Eyebrow and mouth-shape channels (only with `expressive`): channel -> per mesh displacements. */
  extra: Record<string, (Float32Array | undefined)[]>;
  /** The eyebrow pieces found (only with `expressive`): mesh index and its vertices. */
  brows: { mesh: number; verts: number[] }[];
  /** Eyes that get new eyelids instead of stretched skin. */
  curtains: CurtainEye[];
  info: { eyes: number; gap: number[]; mouthWidth?: number; moved: number };
}

/** Channels built for faces with no bones at all (eyebrows and mouth shapes). */
export const EXPRESSIVE_CHANNELS = ["browUp", "browAngry", "browSad", "browFurrow", "mouthSmile", "mouthFrown", "mouthNarrow", "mouthWide", "mouthPout"] as const;

const RES = 0.0005; // grid cell: 0.5 mm

// ---------- mesh helpers ----------

/** Vertices that share a position (UV seams split them) get the same id. */
function weld(pos: Float32Array): Int32Array {
  const ids = new Int32Array(pos.length / 3);
  const seen = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) {
    const k = `${Math.round(pos[i * 3] * 1e5)},${Math.round(pos[i * 3 + 1] * 1e5)},${Math.round(pos[i * 3 + 2] * 1e5)}`;
    let id = seen.get(k);
    if (id === undefined) seen.set(k, (id = seen.size));
    ids[i] = id;
  }
  return ids;
}

/** Connected pieces of a mesh (welded), as lists of vertex indices. */
export function components(m: FaceMeshIn): number[][] {
  const w = weld(m.pos);
  const n = m.pos.length / 3;
  const par = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => {
    while (par[a] !== a) a = par[a] = par[par[a]];
    return a;
  };
  const union = (a: number, b: number) => (par[find(a)] = find(b));
  const firstOf = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const f = firstOf.get(w[i]);
    if (f === undefined) firstOf.set(w[i], i);
    else union(i, f);
  }
  for (let t = 0; t < m.index.length; t += 3) {
    union(m.index[t], m.index[t + 1]);
    union(m.index[t], m.index[t + 2]);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(i);
  }
  return [...groups.values()];
}

/** Holes and outer edges of a mesh: closed chains of edges used by a single triangle (welded vertex positions). */
export function boundaryLoops(m: FaceMeshIn): V3[][] {
  const w = weld(m.pos);
  const at = new Map<number, V3>();
  for (let i = 0; i < w.length; i++) if (!at.has(w[i])) at.set(w[i], [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]]);
  const count = new Map<string, number>();
  for (let t = 0; t < m.index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = w[m.index[t + k]];
      const b = w[m.index[t + ((k + 1) % 3)]];
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
  const used = new Set<number>();
  const loops: V3[][] = [];
  for (const start of adj.keys()) {
    if (used.has(start)) continue;
    const loop: number[] = [];
    let prev = -1;
    let cur = start;
    while (cur !== -1 && !used.has(cur)) {
      used.add(cur);
      loop.push(cur);
      const next = (adj.get(cur) ?? []).find((x) => x !== prev && !used.has(x));
      prev = cur;
      cur = next ?? -1;
    }
    if (loop.length >= 3) loops.push(loop.map((i) => at.get(i)!));
  }
  return loops;
}

function inPolygon(x: number, y: number, poly: V3[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const bbox = (pts: ArrayLike<number>[] | V3[]) => {
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let c = 0; c < 3; c++) {
    mn[c] = Math.min(mn[c], p[c]);
    mx[c] = Math.max(mx[c], p[c]);
  }
  return { mn, mx };
};

const vtx = (m: FaceMeshIn, i: number): V3 => [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];

/** Depth map over a box: for each 0.5 mm cell, the front-most (or back-most) z of some triangles. */
class Grid {
  readonly nx: number;
  readonly ny: number;
  readonly z: Float32Array;
  constructor(readonly x0: number, readonly y0: number, x1: number, y1: number, private front: boolean) {
    this.nx = Math.max(1, Math.round((x1 - x0) / RES) + 1);
    this.ny = Math.max(1, Math.round((y1 - y0) / RES) + 1);
    this.z = new Float32Array(this.nx * this.ny).fill(front ? -Infinity : Infinity);
  }
  cell(x: number, y: number): number {
    const i = Math.round((x - this.x0) / RES);
    const j = Math.round((y - this.y0) / RES);
    return i < 0 || j < 0 || i >= this.nx || j >= this.ny ? -1 : j * this.nx + i;
  }
  get(x: number, y: number): number | undefined {
    const k = this.cell(x, y);
    const v = k < 0 ? undefined : this.z[k];
    return v === undefined || !isFinite(v) ? undefined : v;
  }
  /** Rasterises one triangle, keeping the front-most (or back-most) z per cell. */
  tri(a: V3, b: V3, c: V3, keep?: (z: number) => boolean) {
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-14) return;
    const i0 = Math.max(0, Math.ceil((Math.min(a[0], b[0], c[0]) - this.x0) / RES));
    const i1 = Math.min(this.nx - 1, Math.floor((Math.max(a[0], b[0], c[0]) - this.x0) / RES));
    const j0 = Math.max(0, Math.ceil((Math.min(a[1], b[1], c[1]) - this.y0) / RES));
    const j1 = Math.min(this.ny - 1, Math.floor((Math.max(a[1], b[1], c[1]) - this.y0) / RES));
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + j * RES;
      for (let i = i0; i <= i1; i++) {
        const x = this.x0 + i * RES;
        const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
        const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
        const z = l1 * a[2] + l2 * b[2] + l3 * c[2];
        if (keep && !keep(z)) continue;
        const k = j * this.nx + i;
        if (this.front ? z > this.z[k] : z < this.z[k]) this.z[k] = z;
      }
    }
  }
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * An eyebrow: a long thin piece above the eye (clear of the lashes), over it. Lashes can reach as high, but each
 * strand is narrow.
 */
function isBrow(e: Eye, pts: V3[], minAbove = 0.05): boolean {
  const cols = [...e.top.keys()].filter((i) => isFinite(e.top[i]));
  if (!cols.length) return false;
  const x0 = e.x0 + cols[0] * RES;
  const x1 = e.x0 + cols[cols.length - 1] * RES;
  const top = openingAt(e, (x0 + x1) / 2)!.top;
  const { mn, mx } = bbox(pts);
  const cx = (mn[0] + mx[0]) / 2;
  const w = mx[0] - mn[0];
  if (mn[1] < top + minAbove * e.gmax || mx[1] > top + 2.6 * e.gmax) return false;
  if (cx < x0 - 0.2 * (x1 - x0) || cx > x1 + 0.2 * (x1 - x0)) return false;
  return w >= 0.45 * (x1 - x0) && mx[1] - mn[1] <= 0.45 * w;
}

/** The skin of a face mesh: its biggest piece (eyes, lashes, teeth... may be pieces of the same mesh). */
const skinOf = (comps: number[][]) => comps.reduce((a, b) => (b.length > a.length ? b : a));

// ---------- eyes ----------

interface Eye {
  /** Upper and lower edge of the visible opening, per 0.5 mm column. */
  x0: number;
  top: Float32Array;
  bottom: Float32Array;
  gmax: number;
  /** Front-most eyeball surface (whites, iris): moving lids must stay in front of it. */
  ball: Grid;
  /**
   * The eyeball lives inside the face mesh itself (no separate eye meshes). The skin there was never meant to
   * stretch over it, so the lids are new pieces of skin instead (see EyeCurtain) and the face is left as it is.
   */
  curtain?: boolean;
  /** The hole of the face skin around the eye (its outline). */
  hole?: V3[];
}

/** Morph target (not a rig channel) that sinks a new-lid eye's layers out of sight once it is shut. */
export const EYE_HIDE = "_eyeHide";
/** Morph target that brings the upper lashes in front of the new lids as soon as they move. */
export const LASH_FWD = "_lashFwd";
/** Morph targets that squeeze a new-lid eye below its closing lid, one per stage of closing. */
export const EYE_CLIP = "_eyeClip";
export const CLIP_STAGES = [0.25, 0.5, 0.75, 0.9, 1];

/** Where the new lids meet when the eye is shut, as a fraction of its height from the bottom. */
export const CURTAIN_MEET = 0.35;

/**
 * How far the upper lid's edge comes down when the eye is shut, at a point along the eye: (1 - CURTAIN_MEET) of
 * the eye's height there, smoothed along the eye (a 2 mm bell) so the closed line is one even curve and the
 * lashes on it are carried down without bending, even at the corners where the height changes fast.
 */
function shutShift(e: Eye, x: number): number {
  // One gentle arch over the whole eye (most in the middle, 35% of it at the corners and beyond), so the lash
  // line keeps its own shape as it comes down instead of bending where the eye's height changes fast.
  const cols = [...e.top.keys()].filter((i) => isFinite(e.top[i]));
  if (!cols.length) return 0;
  const x0 = e.x0 + cols[0] * RES;
  const x1 = e.x0 + cols[cols.length - 1] * RES;
  const xc = (x0 + x1) / 2;
  const u = Math.min(1, Math.abs(x - xc) / ((x1 - x0) / 2 || 1));
  return (1 - CURTAIN_MEET) * e.gmax * (1 - 0.65 * u * u);
}

/** What the app needs to draw the new eyelids of one eye (face frame). */
export interface CurtainEye {
  face: number;
  xs: number[];
  top: number[];
  bottom: number[];
  gmax: number;
  /** Front of the eyeball at a point (undefined outside it). */
  ballZ: (x: number, y: number) => number | undefined;
  /** A vertex of the face's skin, clear of the eye and the eyebrow: the lids take their colour from it. */
  skinVertex: number;
  /** Vertices of the face's skin (its texture is continued over the lids). */
  skin: number[];
  /** Where the lids meet when shut, per column (the same curve the lashes come down to). */
  meet: number[];
}

function openingAt(e: Eye, x: number): { top: number; bottom: number; gap: number } | undefined {
  const i = Math.round((x - e.x0) / RES);
  if (i < 0 || i >= e.top.length || !isFinite(e.top[i])) return undefined;
  return { top: e.top[i], bottom: e.bottom[i], gap: e.top[i] - e.bottom[i] };
}

/**
 * Finds the opening of one eye: the hole of the face mesh around the eye centre, then where the eyeball is seen
 * through it (no face skin in front of it).
 */
function findEye(meshes: FaceMeshIn[], comps: number[][][], center: V3, midX?: number): { eye: Eye; face: number } | undefined {
  // 1. A hole of some mesh at the eye, with that mesh all around it (not the outline of a patch). The eye bone is
  // usually inside it; in some rigs it sits off it (at the back of the eyeball), so the nearest hole close by.
  let best: { loop: V3[]; mesh: number; area: number; d: number; front: number; size: number } | undefined;
  meshes.forEach((m, mi) => {
    // holes of the skin itself (its biggest piece): the outlines of eye pieces kept in the same mesh (eye white,
    // eyeliner) are loops around the eye too, but smaller than the real opening
    const skin = new Set(skinOf(comps[mi]));
    const skinIndex: number[] = [];
    for (let t = 0; t < m.index.length; t += 3) if (skin.has(m.index[t])) skinIndex.push(m.index[t], m.index[t + 1], m.index[t + 2]);
    for (const loop of boundaryLoops({ ...m, index: skinIndex })) {
      const { mn, mx } = bbox(loop);
      const w = mx[0] - mn[0];
      const h = mx[1] - mn[1];
      if (w < 0.008 || w > 0.09 || h < 0.004 || h > 0.07) continue;
      if (midX !== undefined && mn[0] < midX && mx[0] > midX) continue; // spans both eyes: an opening inside the head
      const inside = inPolygon(center[0], center[1], loop);
      const d = inside ? 0 : Math.hypot((mn[0] + mx[0]) / 2 - center[0], (mn[1] + mx[1]) / 2 - center[1]);
      if (d > Math.max(w, h)) continue;
      let around = 0;
      for (let i = 0; i < m.pos.length / 3; i++) {
        const [x, y] = vtx(m, i);
        if (y > mn[1] && y < mx[1] && x < mn[0] - 0.003 && x > mn[0] - 0.03) around |= 1;
        if (y > mn[1] && y < mx[1] && x > mx[0] + 0.003 && x < mx[0] + 0.03) around |= 2;
        if (x > mn[0] && x < mx[0] && y > mx[1] + 0.003 && y < mx[1] + 0.03) around |= 4;
        if (x > mn[0] && x < mx[0] && y < mn[1] - 0.003 && y > mn[1] - 0.03) around |= 8;
      }
      // the eye is on the front of the face: of the holes near it, the front-most (holes in the hair behind the head
      // can be just as close); between equally front-most ones, the bigger mesh (the face itself)
      const front = mx[2];
      const size = m.pos.length;
      // Holes around the eye bone win (the biggest: the socket rather than a patch of eyeliner inside it); only
      // if none surrounds it, the front-most one nearby.
      const better = !best
        ? true
        : d === 0 || best.d === 0
          ? d === 0 && (best.d !== 0 || w * h > best.area)
          : front > best.front + 0.002 || (Math.abs(front - best.front) <= 0.002 && (size > best.size || (size === best.size && d < best.d)));
      if (around === 15 && better) best = { loop, mesh: mi, area: w * h, d, front, size };
    }
  });
  if (!best) return undefined;
  const face = best.mesh;
  const hole = bbox(best.loop);
  const gx0 = hole.mn[0] - 0.006;
  const gx1 = hole.mx[0] + 0.006;
  const gy0 = hole.mn[1] - 0.006;
  const gy1 = hole.mx[1] + 0.006;
  const near = (p: V3) => p[0] > gx0 - 0.02 && p[0] < gx1 + 0.02 && p[1] > gy0 - 0.02 && p[1] < gy1 + 0.035;

  // 2. Front-most face skin, and the back-most other surface (the eyeball) behind the hole.
  const skin = new Grid(gx0, gy0, gx1, gy1, true);
  const back = new Grid(gx0, gy0, gx1, gy1, false);
  const zMin = hole.mn[2] - 0.006;
  // The skin is the face mesh's biggest piece; its other pieces (eyeballs, lashes... some models keep them in the
  // same mesh) are treated like separate meshes.
  const skinPiece = new Uint8Array(meshes[face].pos.length / 3);
  for (const i of skinOf(comps[face])) skinPiece[i] = 1;
  meshes.forEach((m, mi) => {
    const local = new Uint8Array(m.pos.length / 3);
    for (const c of comps[mi]) if (!(mi === face && skinPiece[c[0]]) && c.every((i) => near(vtx(m, i)))) for (const i of c) local[i] = 1;
    for (let t = 0; t < m.index.length; t += 3) {
      const [ia, ib, ic] = [m.index[t], m.index[t + 1], m.index[t + 2]];
      if (mi === face && skinPiece[ia]) skin.tri(vtx(m, ia), vtx(m, ib), vtx(m, ic));
      else if (local[ia] && local[ib] && local[ic]) back.tri(vtx(m, ia), vtx(m, ib), vtx(m, ic), (z) => z > zMin);
    }
  });
  // 3. The opening: cells where the eyeball is visible. Per column, its top and bottom.
  const zFront = hole.mx[2] + 0.25 * (hole.mx[0] - hole.mn[0]);
  const top = new Float32Array(skin.nx).fill(NaN);
  const bottom = new Float32Array(skin.nx).fill(NaN);
  for (let i = 0; i < skin.nx; i++) {
    for (let j = 0; j < skin.ny; j++) {
      const k = j * skin.nx + i;
      const b = back.z[k];
      // the eyeball: behind the face's front (not a lash or eyebrow drawn over the skin), inside the hole,
      // with no skin in front of it
      if (!isFinite(b) || b > zFront || skin.z[k] > b - 0.001) continue;
      const y = gy0 + j * RES;
      if (!inPolygon(gx0 + i * RES, y, best.loop)) continue;
      top[i] = isNaN(top[i]) ? y : Math.max(top[i], y);
      bottom[i] = isNaN(bottom[i]) ? y : Math.min(bottom[i], y);
    }
  }
  // ignore stray columns: keep those at least 1/4 as tall as the tallest
  let gmax = 0;
  for (let i = 0; i < skin.nx; i++) if (isFinite(top[i])) gmax = Math.max(gmax, top[i] - bottom[i]);
  if (gmax < 0.003) return undefined;
  for (let i = 0; i < skin.nx; i++) if (!(top[i] - bottom[i] >= gmax * 0.08)) top[i] = bottom[i] = NaN; // (corners included)
  // The very corners (a few mm where the eye white tapers under the skin's edge) close too: extend each end,
  // narrowing to nothing.
  const valid = [...top.keys()].filter((i) => isFinite(top[i]));
  if (valid.length) {
    const ext = Math.round(0.007 / RES);
    for (const [edge, dir] of [[valid[0], -1], [valid[valid.length - 1], 1]] as const) {
      const mid = (top[edge] + bottom[edge]) / 2;
      const half = (top[edge] - bottom[edge]) / 2;
      for (let k = 1; k <= ext; k++) {
        const i = edge + dir * k;
        if (i < 0 || i >= skin.nx || isFinite(top[i])) continue;
        const f = 1 - k / (ext + 1);
        top[i] = mid + half * f;
        bottom[i] = mid - half * f;
      }
    }
  }
  const eye: Eye = { x0: gx0, top, bottom, gmax, ball: new Grid(gx0, gy0 - 0.01, gx1, gy1 + 0.01, true), hole: best.loop };

  // 4. Eyeball pieces (their surface is the back-most layer, in the middle of the opening), to keep lids in front.
  meshes.forEach((m, mi) => {
    for (const c of comps[mi]) {
      if (mi === face && skinPiece[c[0]]) continue;
      if (c.length < 3) continue; // stray vertices that belong to no triangle
      const pts = c.map((i) => vtx(m, i));
      if (!pts.every(near)) continue;
      if (eyeballPiece(eye, pts, back)) {
        if (mi === face) eye.curtain = true;
        for (let t = 0; t < m.index.length; t += 3) {
          const [ia, ib, ic] = [m.index[t], m.index[t + 1], m.index[t + 2]];
          if (c.includes(ia)) eye.ball.tri(vtx(m, ia), vtx(m, ib), vtx(m, ic));
        }
      }
    }
  });
  return { eye, face };
}

/** True for the whites/iris of the eye: they lie on the back-most surface, around the middle of the opening. */
/**
 * A piece lying inside the eye opening, around its middle: part of the eyeball (iris, pupil, highlights), even if
 * it sits a few mm in front of the eye white (anime eyes are often layered with depth).
 */
function insideOpening(e: Eye, pts: V3[]): boolean {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const o = openingAt(e, cx);
  if (!o) return false;
  const r = (cy - o.bottom) / (o.gap || 1);
  if (r < 0.2 || r > 0.8) return false;
  const inside = pts.filter((p) => {
    const q = openingAt(e, p[0]);
    return q !== undefined && p[1] > q.bottom - 0.001 && p[1] < q.top + 0.001;
  }).length;
  return inside >= 0.85 * pts.length;
}

function eyeballPiece(e: Eye, pts: V3[], back: Grid): boolean {
  if (insideOpening(e, pts)) return true;
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const o = openingAt(e, cx);
  if (!o) return false;
  const r = (cy - o.bottom) / (o.gap || 1);
  if (r < 0.15 || r > 0.85) return false;
  const dz = pts.map((p) => p[2] - (back.get(p[0], p[1]) ?? Infinity)).filter(isFinite).sort((a, b) => a - b);
  return dz.length > 0 && dz[Math.floor(dz.length / 2)] < 0.002;
}

/** How far down (upper lid) or up (lower lid) a vertex moves when the lid travels its whole way, 0..1 times the gap. */
function lidWeight(e: Eye, p: V3, upper: boolean, rigid: boolean): { w: number; gap: number; inside: number; top?: number; bottom?: number; fade?: number } {
  let o = openingAt(e, p[0]);
  let fade = 1;
  if (!o && rigid) {
    // a lash that runs past the corner (the outer flick): it follows the nearest edge of the lid, fading out
    const cols = [...e.top.keys()].filter((i) => isFinite(e.top[i]));
    if (cols.length) {
      const x0 = e.x0 + cols[0] * RES;
      const x1 = e.x0 + cols[cols.length - 1] * RES;
      const x = Math.min(x1, Math.max(x0, p[0]));
      o = openingAt(e, x);
      fade = e.curtain ? 1 : smooth(1 - (Math.abs(p[0] - x) - 0.15 * (x1 - x0)) / (0.5 * (x1 - x0))); // fully with it just past the corner
    }
  }
  if (!o || fade <= 0) return { w: 0, gap: 0, inside: 0 };
  const mid = (o.top + o.bottom) / 2;
  if (upper ? p[1] < mid : p[1] >= mid) return { w: 0, gap: 0, inside: 0 };
  const h = upper ? p[1] - o.top : o.bottom - p[1]; // height above the upper edge / below the lower one
  // The lid itself (rim, lashes and the skin just above them) moves as one piece; above it the skin stretches
  // up to `reach`, where it no longer moves. (Moving only the rim would uncover the eyeball behind the lid.)
  // (capped in mm: anime eyes can be huge, and stretching skin that far would drag the eyebrow down with it)
  const lid = Math.min((upper ? 0.3 : 0.15) * e.gmax, upper ? 0.006 : 0.003);
  const reach = Math.min((upper ? 0.6 : 0.4) * e.gmax, upper ? 0.012 : 0.008);
  const inside = Math.max(0, -h); // how far into the opening it already is
  if (rigid) return { w: h < reach * 2.2 ? fade : 0, gap: o.gap * fade, inside: inside * fade, top: o.top, bottom: o.bottom, fade };
  return { w: h <= lid ? 1 : Math.max(0, 1 - (h - lid) / (reach - lid)), gap: o.gap, inside };
}

// ---------- mouth ----------

interface Mouth {
  cx: number;
  cy: number;
  cz: number;
  half: number; // half width (centre to corner)
  lip: (x: number) => number;
}

/** The mouth slit: a hole of the face mesh between the two corners, much wider than tall. */
function findMouth(meshes: FaceMeshIn[], face: number, corners: [V3, V3]): Mouth | undefined {
  const [a, b] = corners;
  const cx = (a[0] + b[0]) / 2;
  const half = Math.abs(a[0] - b[0]) / 2;
  const cy = (a[1] + b[1]) / 2;
  if (half < 0.004) return undefined;
  let best: V3[] | undefined;
  for (const loop of boundaryLoops(meshes[face])) {
    const { mn, mx } = bbox(loop);
    const w = mx[0] - mn[0];
    if (w < half * 0.8 || w > half * 2.6 || mx[1] - mn[1] > Math.max(0.006, w * 0.35)) continue;
    if (Math.abs((mn[0] + mx[0]) / 2 - cx) > half * 0.3 || Math.abs((mn[1] + mx[1]) / 2 - cy) > half * 0.6) continue;
    if (!best || w > bbox(best).mx[0] - bbox(best).mn[0]) best = loop;
  }
  if (!best) return undefined;
  const { mn, mx } = bbox(best);
  const lineY = (x: number) => {
    const near = best!.filter((p) => Math.abs(p[0] - x) < 0.0015);
    return near.length ? near.reduce((s, p) => s + p[1], 0) / near.length : undefined;
  };
  const lx = mn[0];
  const rx = mx[0];
  const ly = lineY(lx + 0.0005) ?? cy;
  const ry = lineY(rx - 0.0005) ?? cy;
  return {
    cx: (lx + rx) / 2,
    cy: (mn[1] + mx[1]) / 2,
    cz: mx[2],
    half: Math.max(half, (rx - lx) / 2),
    lip: (x) => (x <= lx ? ly : x >= rx ? ry : lineY(x) ?? ly + ((x - lx) / (rx - lx)) * (ry - ly)),
  };
}

/** Jaw-like drop of everything under the lip line: 1 in the middle of the lower lip, fading to the corners and chin. */
function jawWeight(m: Mouth, p: V3): number {
  const depth = Math.max(0, m.lip(p[0]) - p[1]); // (the lower lip's inner edge can sit a hair above the line)
  const dx = Math.abs(p[0] - m.cx);
  const width = m.half * (1 + 0.9 * Math.min(1, depth / 0.012)); // the chin is wider than the lips' gap
  const wx = Math.max(0, 1 - (dx / width) ** 2);
  const wy = depth < 0.004 ? 1 : Math.max(0.4, 1 - (depth - 0.004) / 0.04);
  const wz = smooth((p[2] - (m.cz - 0.035)) / 0.015); // not the back of the head / neck
  return wx * wy * wz;
}

/** Vertices of the face mesh on the jaw side of the mouth slit (flood fill from under the lips). */
function lowerJaw(m: FaceMeshIn, mo: Mouth): Uint8Array {
  const n = m.pos.length / 3;
  const w = weld(m.pos);
  const nb = new Map<number, number[]>();
  const link = (a: number, b: number) => (nb.get(a) ?? nb.set(a, []).get(a)!).push(b);
  for (let t = 0; t < m.index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = w[m.index[t + k]];
      const b = w[m.index[t + ((k + 1) % 3)]];
      if (a !== b) {
        link(a, b);
        link(b, a);
      }
    }
  }
  const pos = new Map<number, V3>();
  for (let i = 0; i < n; i++) if (!pos.has(w[i])) pos.set(w[i], vtx(m, i));
  const depth = (p: V3) => mo.lip(p[0]) - p[1];
  const allowed = (p: V3) => p[2] > mo.cz - 0.04 && depth(p) < 0.05 && (depth(p) > 0.002 || Math.abs(p[0] - mo.cx) < mo.half * 0.9);
  const seen = new Set<number>();
  const queue: number[] = [];
  for (const [id, p] of pos) {
    const d = depth(p);
    if (d > 0.003 && d < 0.006 && Math.abs(p[0] - mo.cx) < mo.half * 0.5 && p[2] > mo.cz - 0.01) {
      seen.add(id);
      queue.push(id);
    }
  }
  while (queue.length) {
    const a = queue.pop()!;
    for (const b of nb.get(a) ?? []) {
      if (seen.has(b) || !allowed(pos.get(b)!)) continue;
      seen.add(b);
      queue.push(b);
    }
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = seen.has(w[i]) ? 1 : 0;
  return out;
}

/**
 * Without bones at the mouth corners: the slit of the face mesh below the eyes (a hole much wider than tall,
 * centred between them), its ends being the corners.
 */
function guessMouthCorners(face: FaceMeshIn, eyes: [V3, V3]): [V3, V3] | undefined {
  const ed = Math.hypot(eyes[0][0] - eyes[1][0], eyes[0][1] - eyes[1][1]);
  const mx = (eyes[0][0] + eyes[1][0]) / 2;
  const my = (eyes[0][1] + eyes[1][1]) / 2;
  let best: V3[] | undefined;
  for (const loop of boundaryLoops(face)) {
    const { mn, mx: hi } = bbox(loop);
    const w = hi[0] - mn[0];
    const cy = (mn[1] + hi[1]) / 2;
    if (w < 0.2 * ed || w > 1.2 * ed || hi[1] - mn[1] > 0.35 * w) continue;
    if (Math.abs((mn[0] + hi[0]) / 2 - mx) > 0.15 * ed || cy > my - 0.4 * ed || cy < my - 1.8 * ed) continue;
    if (!best || w > bbox(best).mx[0] - bbox(best).mn[0]) best = loop;
  }
  if (!best) return undefined;
  const l = best.reduce((a, b) => (b[0] < a[0] ? b : a));
  const r = best.reduce((a, b) => (b[0] > a[0] ? b : a));
  return [l, r];
}

/**
 * Eyebrows drawn as their own pieces above each eye (faces with no brow bones): they move up, tilt (angry / sad)
 * and draw together. Returns how many vertices move.
 */
function eyebrows(
  meshes: FaceMeshIn[],
  comps: number[][][],
  found: { eye: Eye; face: number }[],
  eyes: V3[],
  put: (channel: string, mi: number, i: number, x: number, y: number, z: number) => void,
  pieces: { mesh: number; verts: number[] }[],
): number {
  const midX = eyes.reduce((s, e) => s + e[0], 0) / eyes.length;
  let moved = 0;
  for (const { eye, face } of found) {
    const cols = [...eye.top.keys()].filter((i) => isFinite(eye.top[i]));
    if (!cols.length) continue;
    const x0 = eye.x0 + cols[0] * RES;
    const x1 = eye.x0 + cols[cols.length - 1] * RES;
    const ex = (x0 + x1) / 2;
    const top = openingAt(eye, ex)!.top;
    const unit = Math.max(0.003, Math.min(0.007, 0.38 * eye.gmax));
    // the eyebrow is the highest long thin piece above the eye (a crease line drawn over the lid is lower)
    let brow: { mi: number; c: number[]; y: number } | undefined;
    meshes.forEach((m, mi) => {
      for (const c of comps[mi]) {
        if (mi === face && c === skinOf(comps[mi])) continue; // the face skin itself
        const pts = c.map((i) => vtx(m, i));
        if (!isBrow(eye, pts)) continue;
        if (c.filter((i) => m.onHead[i]).length < c.length * 0.6) continue;
        const y = bbox(pts).mn[1];
        if (!brow || y > brow.y) brow = { mi, c, y };
      }
    });
    if (brow) {
      const { mi, c } = brow;
      const m = meshes[mi];
      {
        const pts = c.map((i) => vtx(m, i));
        const { mn, mx } = bbox(pts);
        const cx = (mn[0] + mx[0]) / 2;
        const inner = Math.min(Math.abs(mn[0] - midX), Math.abs(mx[0] - midX));
        const outer = Math.max(Math.abs(mn[0] - midX), Math.abs(mx[0] - midX));
        const inward = cx > midX ? -1 : 1; // towards the nose
        pieces.push({ mesh: mi, verts: c });
        for (const i of c) {
          const t = Math.max(0, Math.min(1, (Math.abs(vtx(m, i)[0] - midX) - inner) / (outer - inner || 1))); // 0 inner .. 1 outer
          // Anime-style, clearly readable: angry = inner end bent down hard and pulled towards the nose, outer end
          // up; sad = inner end up (also drawn together), outer end down; surprised = up, more in the middle (arch).
          const inn = Math.pow(1 - t, 1.5);
          put("browUp", mi, i, 0, unit * (1 + 0.35 * Math.sin(Math.PI * t)), 0);
          put("browAngry", mi, i, inward * unit * 0.3 * (1 - t), unit * (-1.2 * inn + 0.6 * t), 0);
          put("browSad", mi, i, inward * unit * 0.2 * (1 - t), unit * (1.2 * inn - 0.5 * t), 0);
          put("browFurrow", mi, i, inward * unit * 0.45 * (1 - t), -unit * 0.25 * (1 - t), 0);
          moved++;
        }
      }
    }
  }
  return moved;
}

// ---------- everything ----------

/**
 * Builds the three morph targets. `eyes`: eyeball centres (face frame). `mouthCorners`: positions of the mouth
 * corners if the rig has bones there. Returns undefined if no eye opening is found.
 */
export function buildFaceMorphs(meshes: FaceMeshIn[], eyes: V3[], mouthCorners?: [V3, V3], expressive = false): FaceMorphs | undefined {
  const comps = meshes.map(components);
  const midX = eyes.length === 2 ? (eyes[0][0] + eyes[1][0]) / 2 : undefined;
  const found = eyes.map((c) => findEye(meshes, comps, c, midX)).filter((x): x is { eye: Eye; face: number } => !!x);
  if (found.length === 0) return undefined;
  const upper: (Float32Array | undefined)[] = meshes.map(() => undefined);
  const lower: (Float32Array | undefined)[] = meshes.map(() => undefined);
  const mouth: (Float32Array | undefined)[] = meshes.map(() => undefined);
  let moved = 0;

  // New-lid eyes: once shut, the eye's own layers sink behind the skin (out of sight, as in a closed anime eye)
  const hide: (Float32Array | undefined)[] = meshes.map(() => undefined);
  // ...and the upper lashes come forward, in front of the new lid, as soon as it starts to move (they lie on it)
  const lashFwd: (Float32Array | undefined)[] = meshes.map(() => undefined);
  const clip: (Float32Array | undefined)[][] = CLIP_STAGES.map(() => meshes.map(() => undefined));
  const lidFront = (e: Eye) => {
    let f = -Infinity;
    for (let i = 0; i < e.top.length; i++) {
      if (!isFinite(e.top[i])) continue;
      const x = e.x0 + i * RES;
      for (let k = 0; k <= 10; k++) f = Math.max(f, e.ball.get(x, e.bottom[i] + ((e.top[i] - e.bottom[i]) * k) / 10) ?? -Infinity);
    }
    return isFinite(f) ? f + 0.0012 : undefined; // where EyeCurtain draws the lids
  };
  const centres = new Map<number[], V3>();
  const pieceOf = new Map<string, number[]>();
  const sink = (mi: number, i: number) => {
    const a = (hide[mi] ??= new Float32Array(meshes[mi].pos.length));
    // each piece shrinks to its own centre, behind the lids: no triangle is left to show through a gap
    let c = pieceOf.get(`${mi}:${i}`);
    if (!c) {
      c = comps[mi].find((cc) => cc.includes(i)) ?? [i];
      for (const k of c) pieceOf.set(`${mi}:${k}`, c);
    }
    let ctr = centres.get(c);
    if (!ctr) {
      const pts = c.map((k) => vtx(meshes[mi], k));
      ctr = [pts.reduce((s, q) => s + q[0], 0) / pts.length, pts.reduce((s, q) => s + q[1], 0) / pts.length, Math.min(...pts.map((q) => q[2]))];
      centres.set(c, ctr);
    }
    const p = vtx(meshes[mi], i);
    a[i * 3] = ctr[0] - p[0];
    a[i * 3 + 1] = ctr[1] - p[1];
    a[i * 3 + 2] = ctr[2] - 0.01 - p[2];
  };
  for (const { eye, face } of found) {
    meshes.forEach((m, mi) => {
      for (const c of comps[mi]) {
        const pts = c.map((i) => vtx(m, i));
        const isFace = mi === face && c === skinOf(comps[mi]); // the face skin itself (its biggest piece)
        if (isFace && eye.curtain) continue; // new lids cover the eye: the face skin stays put
        if (!isFace && eye.curtain && mi === face) {
          // new-lid eyes: whatever sits in the eye's lower part (socket walls showing at the corners, the lower
          // lashes, the corner of the eye) sinks out of sight once the eye is shut
          const { mn, mx } = bbox(pts);
          const cols = [...eye.top.keys()].filter((k) => isFinite(eye.top[k]));
          if (cols.length && !isBrow(eye, pts, 0.03) && mx[1] - mn[1] < eye.gmax) {
            const ex0 = eye.x0 + cols[0] * RES;
            const ex1 = eye.x0 + cols[cols.length - 1] * RES;
            const cx = (mn[0] + mx[0]) / 2;
            const cy = pts.reduce((a, q) => a + q[1], 0) / pts.length;
            const q = openingAt(eye, Math.min(ex1, Math.max(ex0, cx)));
            if (q && cx > ex0 - 0.015 && cx < ex1 + 0.015 && cy < q.bottom + CURTAIN_MEET * q.gap) for (const i of c) sink(mi, i);
          }
        }
        let rigid = false;
        if (!isFace) {
          // Pieces in front of the skin: lashes and eyeliner move with the lids; eyebrows, eyeballs and anything
          // driven by its own bones (iris, brows...) do not.
          const { mn, mx } = bbox(pts);
          if (mn[0] < eye.x0 - 0.01 || mx[0] > eye.x0 + eye.top.length * RES + 0.01) continue;
          if (mx[1] - mn[1] > eye.gmax * 2) continue;
          if (c.filter((i) => m.onHead[i]).length < c.length * 0.6) continue;
          const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
          const o = openingAt(eye, Math.min(Math.max(cx, eye.x0), eye.x0 + (eye.top.length - 1) * RES));
          if (!o) continue;
          const onBall = pts.filter((p) => {
            const b = eye.ball.get(p[0], p[1]);
            return b !== undefined && p[2] <= b + 0.0005;
          }).length;
          if (onBall > pts.length * 0.5 || insideOpening(eye, pts)) {
            // whites / iris / highlights fold onto the closed line with the lid (hidden behind it anyway; without
            // this the eye white can peek out at the corners, where the lid barely moves)
            // (eyeballs that are separate meshes sit well behind the lid: only their corners need it)
            const cornersOnly = mi !== face;
            if (eye.curtain) {
              // the eye under a closing lid is squeezed below the lid's edge (staged: see CLIP_STAGES), so the
              // lid never has to be in front of it
              for (const i of c) {
                const q = vtx(m, i);
                const cols = [...eye.top.keys()].filter((kk) => isFinite(eye.top[kk]));
                const xx = Math.min(eye.x0 + cols[cols.length - 1] * RES, Math.max(eye.x0 + cols[0] * RES, q[0]));
                const o = openingAt(eye, xx);
                if (!o) continue;
                const shift = shutShift(eye, q[0]);
                const meet = o.top - shift;
                CLIP_STAGES.forEach((k, j) => {
                  const upperEdge = o.top - k * shift;
                  const lk = smooth((k - 0.8) / 0.2);
                  const lowerEdge = o.bottom + lk * Math.max(0, meet - o.bottom);
                  const y = Math.max(Math.min(q[1], upperEdge), Math.min(lowerEdge, upperEdge));
                  if (y !== q[1]) (clip[j][mi] ??= new Float32Array(m.pos.length))[i * 3 + 1] = y - q[1];
                });
                sink(mi, i);
              }
              continue;
            }
            const cols = [...eye.top.keys()].filter((i) => isFinite(eye.top[i]));
            if (cols.length) {
              const ex0 = eye.x0 + cols[0] * RES;
              const ex1 = eye.x0 + cols[cols.length - 1] * RES;
              for (const i of c) {
                const p = vtx(m, i);
                const x = Math.min(ex1, Math.max(ex0, p[0]));
                const q = openingAt(eye, x);
                if (!q || (cornersOnly && x === p[0] && q.gap > 0.45 * eye.gmax)) continue;
                const closed = q.bottom - 0.05 * q.gap; // just under the closed line: behind the lower lid
                const arr = (upper[mi] ??= new Float32Array(m.pos.length));
                arr[i * 3 + 1] += Math.min(0, closed - p[1]); // (only down: the lower part is the lower lid's)
                moved++;
              }
            }
            continue;
          }
          // the eyebrow (it has its own channels) and the crease line drawn above the lid stay where they are
          if (isBrow(eye, pts, 0.12)) continue; // (lash strips hug the top edge: lower than this)
          if (mn[1] > o.top + 1.3 * eye.gmax) continue; // well above the eye: not part of the lid
          rigid = true;
        }
        // New-lid eyes: a lash piece moves as one (a strip hanging into the eye must not split at its middle):
        // it belongs to the upper lid or the lower one by where its centre is.
        if (rigid && eye.curtain) {
          const cx = pts.reduce((a, q) => a + q[0], 0) / pts.length;
          const cy = pts.reduce((a, q) => a + q[1], 0) / pts.length;
          const cols = [...eye.top.keys()].filter((k) => isFinite(eye.top[k]));
          const o = cols.length ? openingAt(eye, Math.min(eye.x0 + cols[cols.length - 1] * RES, Math.max(eye.x0 + cols[0] * RES, cx))) : undefined;
          if (o) {
            const pieceUpper = cy > o.bottom + 0.5 * o.gap;
            for (const i of c) {
              if (pieceUpper) {
                const arr = (upper[mi] ??= new Float32Array(m.pos.length));
                arr[i * 3 + 1] += -shutShift(eye, vtx(m, i)[0]);
              } else sink(mi, i); // lower lashes stay until the eye is shut, then go
              moved++;
            }
          }
          continue;
        }
        for (const i of c) {
          const p = vtx(m, i);
          for (const [target, isUpper] of [[upper, true], [lower, false]] as const) {
            const lw = lidWeight(eye, p, isUpper, rigid);
            const { w, gap, inside } = lw;
            if (w <= 0 || gap <= 0) continue;
            // Whatever hangs into the opening (the lid's own rim, the lower strip of the lashes) ends up squashed
            // against the closed lid line instead of sticking out below it.
            let dy = (isUpper ? -1 : 1) * (inside > 0 ? gap - 0.85 * inside : w * gap);
            if (rigid && eye.curtain && lw.top !== undefined && lw.bottom !== undefined) {
              // New lids (see EyeCurtain): both meet on a curved line a third of the way up the eye, like an
              // anime eye drawn closed; the upper lashes become that line, the lower ones tuck under it.
              const g = lw.top - lw.bottom;
              const meet = lw.bottom + CURTAIN_MEET * g;
              void meet;
              // the upper lashes are carried down whole (no squashing), by the same smooth amount as the lid's edge
              dy = isUpper ? -shutShift(eye, p[0]) : 0;
              if (!isUpper) sink(mi, i); // the lower lashes stay until the eye is shut, then go: one line stays
            } else if (rigid && isUpper && lw.top !== undefined && lw.bottom !== undefined) {
              // Upper lashes and eyeliner all gather on the closed line (also at the corners, where the opening is
              // narrow: otherwise the sides of the eye's outline stay up as strokes), keeping a little thickness.
              const g = lw.top - lw.bottom;
              const closed = lw.bottom + 0.12 * g + 0.4 * Math.max(0, p[1] - lw.top);
              const k = smooth(1 - g / (0.6 * eye.gmax)); // 0 in the middle of the eye .. 1 at the corners
              dy = dy * (1 - k) + (closed - p[1]) * (lw.fade ?? 1) * k;
            }
            // Stay in front of the eyeball along the whole way (the morph moves in a straight line).
            let dz = 0;
            const startsVisible = (eye.ball.get(p[0], p[1]) ?? -Infinity) + 0.0008 <= p[2];
            // (a vertex hidden behind the eyeball at rest only has to be in front of it once the lid is a third down)
            for (let s = startsVisible ? 0.05 : 0.35; s <= 1.0001; s += 0.05) {
              const b = eye.ball.get(p[0], p[1] + dy * s);
              if (b !== undefined) dz = Math.max(dz, (b + 0.0008 - p[2]) / s);
            }
            dz = Math.min(dz, 0.6 * eye.gmax);
            const arr = (target[mi] ??= new Float32Array(m.pos.length));
            arr[i * 3 + 1] += dy;
            arr[i * 3 + 2] += dz;
            moved++;
          }
        }
      }
    });
  }

  const extra: Record<string, (Float32Array | undefined)[]> = {};
  if (hide.some(Boolean)) extra[EYE_HIDE] = hide;
  void lashFwd;
  void lidFront;
  for (let j = 0; j < CLIP_STAGES.length; j++) if (clip[j].some(Boolean)) extra[`${EYE_CLIP}${j}`] = clip[j];
  const put = (channel: string, mi: number, i: number, x: number, y: number, z: number) => {
    const arr = ((extra[channel] ??= meshes.map(() => undefined))[mi] ??= new Float32Array(meshes[mi].pos.length));
    arr[i * 3] += x;
    arr[i * 3 + 1] += y;
    arr[i * 3 + 2] += z;
  };
  const brows: { mesh: number; verts: number[] }[] = [];
  if (expressive) moved += eyebrows(meshes, comps, found, eyes, put, brows);

  let mouthWidth: number | undefined;
  const corners = mouthCorners ?? (eyes.length === 2 ? guessMouthCorners(meshes[found[0].face], eyes as [V3, V3]) : undefined);
  if (corners) {
    const mo = findMouth(meshes, found[0].face, corners);
    if (mo) {
      mouthWidth = mo.half * 2;
      const drop = Math.min(0.012, 0.3 * mouthWidth); // ~9 mm on a 3 cm wide mouth
      const face = found[0].face;
      const fm = meshes[face];
      // The lower lip and chin: the skin connected to the chin without crossing the slit. Going round the
      // corners is not allowed, so the upper lip (even its inner edge, a hair below the lip line) stays.
      const lowerPart = lowerJaw(fm, mo);
      const key = (p: V3) => `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;
      const byPos = new Map<string, number>();
      const fa = (mouth[face] = new Float32Array(fm.pos.length));
      for (let i = 0; i < fm.pos.length / 3; i++) {
        if (!lowerPart[i]) continue;
        const w = jawWeight(mo, vtx(fm, i));
        if (w <= 0) continue;
        fa[i * 3 + 1] = -w * drop;
        fa[i * 3 + 2] = -w * drop * 0.15;
        byPos.set(key(vtx(fm, i)), w);
        moved++;
      }
      // The inside of the mouth (teeth, tongue) where it meets the lips moves with them; deeper, its lower half
      // drops like the jaw.
      meshes.forEach((m, mi) => {
        if (mi === face) return;
        let touches = false;
        for (let i = 0; !touches && i < m.pos.length / 3; i++) touches = byPos.has(key(vtx(m, i)));
        if (!touches) return;
        const arr = (mouth[mi] = new Float32Array(m.pos.length));
        for (let i = 0; i < m.pos.length / 3; i++) {
          const p = vtx(m, i);
          const w = byPos.get(key(p)) ?? (mo.lip(p[0]) - p[1] > 0.0015 ? jawWeight(mo, p) : 0);
          if (w <= 0) continue;
          arr[i * 3 + 1] = -w * drop;
          arr[i * 3 + 2] = -w * drop * 0.15;
          moved++;
        }
      });
      if (expressive) {
        // Mouth shapes: the corners (and around them) move; for the pout, the middle of the lips comes forward.
        const k = mouthWidth / 0.03; // sizes below are for a 3 cm wide mouth, in mm
        const R = mo.half * 0.75;
        const touching = meshes.map((_, mi) => mouth[mi] !== undefined || mi === face);
        meshes.forEach((m, mi) => {
          if (!touching[mi]) return;
          const lower = mi === face ? lowerPart : undefined;
          for (let i = 0; i < m.pos.length / 3; i++) {
            const p = vtx(m, i);
            if (Math.abs(p[2] - mo.cz) > 0.02) continue;
            for (const side of [-1, 1]) {
              const cxs = mo.cx + side * mo.half;
              const d = Math.hypot(p[0] - cxs, p[1] - mo.lip(cxs));
              const w = smooth(1 - d / R) * 0.001 * k;
              if (w <= 0) continue;
              put("mouthSmile", mi, i, side * 1.5 * w, 3 * w, 0);
              put("mouthFrown", mi, i, 0, -2.6 * w, 0);
              put("mouthNarrow", mi, i, -side * 2.5 * w, 0, 0);
              put("mouthWide", mi, i, side * 2.5 * w, 0.4 * w, 0);
              put("mouthPout", mi, i, 0, -2 * w, 0);
              moved++;
            }
            const dc = Math.hypot((p[0] - mo.cx) / mo.half, (p[1] - mo.lip(p[0])) / (mo.half * 0.6));
            const wc = smooth(1 - dc) * 0.001 * k;
            if (wc > 0) put("mouthPout", mi, i, 0, (lower?.[i] ? 1.2 : 0.2) * wc, 1.6 * wc);
          }
        });
      }
    }
  }
  const curtains: CurtainEye[] = found
    .filter((f) => f.eye.curtain)
    .map(({ eye, face }) => {
      const idx = [...eye.top.keys()].filter((i) => isFinite(eye.top[i]));
      // The lids cover the whole hole of the skin (at the corners it is wider than the opening one sees, and
      // the inside of the eye would show there once the lids are shut): per 0.5 mm column, the opening where
      // it is known, else the hole's own outline.
      const hole = eye.hole ?? [];
      const hx0 = Math.min(eye.x0 + idx[0] * RES, ...hole.map((q) => q[0]));
      const hx1 = Math.max(eye.x0 + idx[idx.length - 1] * RES, ...hole.map((q) => q[0]));
      const xs: number[] = [];
      const tops: number[] = [];
      const bottoms: number[] = [];
      for (let x = hx0; x <= hx1 + 1e-9; x += RES) {
        const o = openingAt(eye, x);
        const near = hole.filter((q) => Math.abs(q[0] - x) < 0.0012);
        const ht = near.length ? Math.max(...near.map((q) => q[1])) : undefined;
        const hb = near.length ? Math.min(...near.map((q) => q[1])) : undefined;
        const t = o ? o.top : ht;
        const b = o ? (hb !== undefined ? Math.min(o.bottom, Math.max(hb, o.bottom - 0.003)) : o.bottom) : hb;
        if (t === undefined || b === undefined || t - b < 0.0005) continue;
        xs.push(x);
        tops.push(t);
        bottoms.push(b);
      }
      // plain skin: the face skin vertex nearest to a point well above the eye (forehead), in front
      const fm = meshes[face];
      const skin = skinOf(comps[face]);
      const cx = eye.x0 + ((idx[0] + idx[idx.length - 1]) / 2) * RES;
      const ty = Math.max(...idx.map((i) => eye.top[i])) + 0.9 * eye.gmax;
      const front = Math.max(...skin.map((i) => fm.pos[i * 3 + 2]));
      let skinVertex = skin[0];
      let bd = Infinity;
      for (const i of skin) {
        const d = Math.hypot(fm.pos[i * 3] - cx, fm.pos[i * 3 + 1] - ty) + Math.max(0, front - 0.03 - fm.pos[i * 3 + 2]);
        if (d < bd) (bd = d), (skinVertex = i);
      }
      return {
        skinVertex,
        skin,
        face,
        xs,
        top: tops,
        bottom: bottoms,
        meet: xs.map((x, k) => tops[k] - shutShift(eye, x)), // (may pass the eye's lower edge at the corners)
        gmax: eye.gmax,
        ballZ: (x: number, y: number) => eye.ball.get(x, y),
      };
    });
  return { upper, lower, mouth, extra, brows, curtains, info: { eyes: found.length, gap: found.map((f) => f.eye.gmax), mouthWidth, moved } };
}

// ---------- three.js glue ----------

export interface LidWeights {
  blink?: number;
  squint?: number;
  eyeSmile?: number;
  eyeWide?: number;
  mouthOpen?: number;
  [channel: string]: number | undefined;
}

/** Morph targets installed on the model's meshes, driven by the face rig's channels. */
export class SynthFace {
  private slots: { mesh: THREE.Mesh; upper?: number; lower?: number; mouth?: number; extra: [string, number][] }[] = [];
  readonly hasEyes: boolean;
  readonly hasMouth: boolean;
  /** Eyebrow / mouth-shape channels it built (faces with no bones at all). */
  readonly extraChannels: string[];
  /** How many eyebrow meshes are drawn over the hair. */
  browsOnTop = 0;
  /** New eyelids (eyes that live inside the face mesh). */
  curtains: EyeCurtain[] = [];

  private constructor(slots: SynthFace["slots"], hasEyes: boolean, hasMouth: boolean, extraChannels: string[]) {
    this.slots = slots;
    this.hasEyes = hasEyes;
    this.hasMouth = hasMouth;
    this.extraChannels = extraChannels;
  }

  /**
   * Call in the rest pose. `mouthCorners`: names of the bones at the mouth corners, if any.
   * Returns undefined when the face has no eye openings to work with.
   */
  static build(vrm: VRM, mouthCorners?: [THREE.Object3D, THREE.Object3D], expressive = false): SynthFace | undefined {
    const H = vrm.humanoid;
    const head = H.getRawBoneNode("head");
    if (!head) return undefined;
    const meshes: THREE.SkinnedMesh[] = [];
    vrm.scene.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (m.isSkinnedMesh && m.visible && m.geometry.index && m.geometry.attributes.skinIndex) meshes.push(m);
    });
    if (!meshes.length) return undefined;
    vrm.scene.updateMatrixWorld(true);
    // Where each vertex is drawn in the rest pose: geometry -> world goes through the mesh's bind matrices and
    // the skeleton (some converted models store the mesh turned 90 degrees and undo it there). In the rest pose
    // every bone contributes the same transform, so one affine matrix per mesh does it (taken from the head).
    const toWorld = new Map<THREE.SkinnedMesh, THREE.Matrix4>();
    for (const m of meshes) {
      const k = m.skeleton.bones.indexOf(head as THREE.Bone);
      if (k < 0) continue;
      const skin = new THREE.Matrix4().multiplyMatrices(head.matrixWorld, m.skeleton.boneInverses[k]);
      toWorld.set(m, new THREE.Matrix4().multiplyMatrices(m.matrixWorld, m.bindMatrixInverse).multiply(skin).multiply(m.bindMatrix));
    }
    const used = meshes.filter((m) => toWorld.has(m));
    const world = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());
    const eyeBones = (["leftEye", "rightEye"] as const).map((n) => H.getRawBoneNode(n)).filter((b): b is THREE.Object3D => !!b);
    if (!used.length || eyeBones.length === 0) return undefined;
    const eyePos = eyeBones.map(world);
    // VRM models face +z (VRMUtils.rotateVRM0 turns 0.x ones around). (Eye bones are no guide: in some rigs they
    // sit at the back of the eyeball, behind the head bone.)
    const front = 1;
    const toFace = (p: THREE.Vector3): V3 => [p.x, p.y, p.z * front];

    const inputs: FaceMeshIn[] = used.map((m) => {
      const g = m.geometry;
      const pos = g.attributes.position;
      const out = new Float32Array(pos.count * 3);
      const v = new THREE.Vector3();
      const A = toWorld.get(m)!;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(A);
        out.set(toFace(v), i * 3);
      }
      const si = g.attributes.skinIndex;
      const sw = g.attributes.skinWeight;
      const onHead = new Uint8Array(pos.count);
      for (let i = 0; i < pos.count; i++) {
        let best = 0;
        for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
        onHead[i] = m.skeleton.bones[si.getComponent(i, best)] === head ? 1 : 0;
      }
      return { pos: out, index: g.index!.array, onHead };
    });
    const corners = mouthCorners?.map(world);
    const res = buildFaceMorphs(
      inputs,
      eyePos.map(toFace),
      corners && corners[0] && corners[1] ? [toFace(corners[0]), toFace(corners[1])] : undefined,
      expressive,
    );
    if (!res) return undefined;
    if (import.meta.env?.DEV) console.info(`[avatar] synthesized face: ${JSON.stringify(res.info)}`);

    // Install: displacements back from the face frame to each mesh's own geometry space.
    const slots: SynthFace["slots"] = [];
    used.forEach((m, mi) => {
      const extraNames = Object.keys(res.extra).filter((c) => res.extra[c][mi]);
      const targets = [res.upper[mi], res.lower[mi], res.mouth[mi], ...extraNames.map((c) => res.extra[c][mi])];
      if (!targets.some(Boolean)) return;
      const g = m.geometry;
      const inv = new THREE.Matrix3().setFromMatrix4(toWorld.get(m)!).invert(); // world -> geometry (directions)
      const pos = g.attributes.position;
      const rel = g.morphTargetsRelative || !g.morphAttributes.position?.length;
      if (!g.morphAttributes.position?.length) g.morphTargetsRelative = true;
      const list = (g.morphAttributes.position ??= []);
      const slot: SynthFace["slots"][number] = { mesh: m, extra: [] };
      const names = ["upper", "lower", "mouth"] as const;
      targets.forEach((d, ti) => {
        if (!d) return;
        const arr = new Float32Array(pos.count * 3);
        const v = new THREE.Vector3();
        for (let i = 0; i < pos.count; i++) {
          v.set(d[i * 3], d[i * 3 + 1], d[i * 3 + 2] * front).applyMatrix3(inv);
          if (!rel) v.add(new THREE.Vector3().fromBufferAttribute(pos, i)); // absolute morph targets
          arr.set([v.x, v.y, v.z], i * 3);
        }
        const attr = new THREE.Float32BufferAttribute(arr, 3);
        attr.name = `synth_${names[ti] ?? extraNames[ti - 3]}`;
        if (ti < 3) slot[names[ti]] = list.length;
        else slot.extra.push([extraNames[ti - 3], list.length]);
        list.push(attr);
        // other morph attributes (normals) must have the same count
        if (g.morphAttributes.normal) g.morphAttributes.normal.push(new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3), 3));
      });
      m.updateMorphTargets();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        // The closed lid is the skin of the socket's rim stretched down over the eye: those triangles can end up
        // facing away from the camera, and would be skipped as back faces.
        if (slot.upper !== undefined) mat.side = THREE.DoubleSide;
        mat.needsUpdate = true;
      }
      slots.push(slot);
    });
    const face = new SynthFace(slots, res.info.eyes > 0, res.info.mouthWidth !== undefined, Object.keys(res.extra));
    for (const ce of res.curtains) {
      const c = EyeCurtain.build(head, ce, used[ce.face], inputs[ce.face].pos);
      if (c) face.curtains.push(c);
    }
    // The model's own eyebrows, when they are meshes of their own: in anime games they are drawn over the fringe
    // (a special pass the converted model lost), so they hide under the hair. Draw them after the hair, on top.
    // They keep their own shape and move with the eyebrow morphs above (up, angry, sad, furrow).
    if (expressive && res.brows.length) {
      const byMesh = new Map<number, number>();
      for (const b of res.brows) byMesh.set(b.mesh, (byMesh.get(b.mesh) ?? 0) + b.verts.length);
      for (const [mi, n] of byMesh) {
        if (n !== inputs[mi].pos.length / 3) {
          // The eyebrows are part of a bigger mesh (the face): draw a copy of just their triangles over the hair,
          // sharing the skeleton and the morph targets (it is moved with the same influences).
          const src = used[mi];
          const verts = new Set(res.brows.filter((b) => b.mesh === mi).flatMap((b) => b.verts));
          const index = src.geometry.index!;
          const tris: number[] = [];
          for (let t = 0; t < index.count; t += 3) {
            const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
            if (verts.has(a) && verts.has(b) && verts.has(c)) tris.push(a, b, c);
          }
          if (!tris.length) continue;
          const geo = src.geometry.clone();
          geo.setIndex(tris);
          geo.clearGroups();
          const mat = [src.material].flat()[0].clone();
          mat.depthTest = false;
          mat.depthWrite = false;
          mat.transparent = true;
          const overlay = new THREE.SkinnedMesh(geo, mat);
          overlay.name = `${src.name} eyebrows`;
          overlay.position.copy(src.position);
          overlay.quaternion.copy(src.quaternion);
          overlay.scale.copy(src.scale);
          overlay.renderOrder = 100;
          overlay.frustumCulled = false;
          src.parent?.add(overlay);
          overlay.bind(src.skeleton, src.bindMatrix);
          overlay.updateMorphTargets();
          const slot = slots.find((sl) => sl.mesh === src);
          if (slot) slots.push({ ...slot, mesh: overlay, extra: [...slot.extra] });
          face.browsOnTop++;
          continue;
        }
        const m = used[mi];
        for (const mat of [m.material].flat()) {
          mat.depthTest = false;
          mat.depthWrite = false;
          mat.transparent = true;
          mat.needsUpdate = true;
        }
        m.renderOrder = 100;
        face.browsOnTop++;
      }
    }
    return face;
  }

  /** Lid travel (fractions of the eye opening) for the eye channels; never more than closed. */
  static lids(w: LidWeights): { upper: number; lower: number } {
    // The lower lid moves little: on these models its rim is usually painted (red/dark waterline), which looks
    // odd when it rises over the iris, so smiling and squinting come mostly from the upper lid.
    let upper = (w.blink ?? 0) * 0.9 + (w.squint ?? 0) * 0.36 + (w.eyeSmile ?? 0) * 0.56 - (w.eyeWide ?? 0) * 0.06;
    let lower = (w.blink ?? 0) * 0.16 + (w.squint ?? 0) * 0.07 + (w.eyeSmile ?? 0) * 0.14 - (w.eyeWide ?? 0) * 0.03;
    const sum = upper + lower;
    if (sum > 1.06) {
      upper *= 1.06 / sum;
      lower *= 1.06 / sum;
    }
    return { upper, lower };
  }

  apply(w: LidWeights) {
    let { upper, lower } = SynthFace.lids(w);
    if (this.curtains.length) {
      // new lids: one "closedness" drives both, the lower lid joining only near the end (see EyeCurtain)
      const k = Math.max(0, Math.min(1, upper / 0.9));
      upper = k;
      lower = k * k * k;
      const extraW: Record<string, number> = { [EYE_HIDE]: smooth((k - 0.86) / 0.1) };
      // piecewise between the clip stages (stage "0" = no clipping)
      const ks = [0, ...CLIP_STAGES];
      for (let j = 0; j < CLIP_STAGES.length; j++) extraW[`${EYE_CLIP}${j}`] = 0;
      for (let j = 0; j < ks.length - 1; j++) {
        if (k >= ks[j] && k <= ks[j + 1]) {
          const t = (k - ks[j]) / (ks[j + 1] - ks[j] || 1);
          // (once the eye is hidden the clipping fades out, or the two would add up into a visible sliver)
          const keep = 1 - extraW[EYE_HIDE];
          if (j > 0) extraW[`${EYE_CLIP}${j - 1}`] = (1 - t) * keep;
          extraW[`${EYE_CLIP}${j}`] = t * keep;
          break;
        }
      }
      w = { ...w, ...extraW };
    }
    const open = Math.max(0, w.mouthOpen ?? 0);
    for (const s of this.slots) {
      const inf = s.mesh.morphTargetInfluences;
      if (!inf) continue;
      if (s.upper !== undefined) inf[s.upper] = upper;
      if (s.lower !== undefined) inf[s.lower] = lower;
      if (s.mouth !== undefined) inf[s.mouth] = open;
      for (const [c, k] of s.extra) inf[k] = w[c] ?? 0;
    }
    for (const c of this.curtains) c.apply(upper);
  }
}

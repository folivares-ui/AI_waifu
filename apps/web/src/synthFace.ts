import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";

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
  info: { eyes: number; gap: number[]; mouthWidth?: number; moved: number };
}

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

// ---------- eyes ----------

interface Eye {
  /** Upper and lower edge of the visible opening, per 0.5 mm column. */
  x0: number;
  top: Float32Array;
  bottom: Float32Array;
  gmax: number;
  /** Front-most eyeball surface (whites, iris): moving lids must stay in front of it. */
  ball: Grid;
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
function findEye(meshes: FaceMeshIn[], comps: number[][][], center: V3): { eye: Eye; face: number } | undefined {
  // 1. A hole of some mesh around the eye centre, with that mesh all around it (not the outline of a patch).
  let best: { loop: V3[]; mesh: number; area: number } | undefined;
  meshes.forEach((m, mi) => {
    for (const loop of boundaryLoops(m)) {
      const { mn, mx } = bbox(loop);
      const w = mx[0] - mn[0];
      const h = mx[1] - mn[1];
      if (w < 0.008 || w > 0.09 || h < 0.004 || h > 0.07 || !inPolygon(center[0], center[1], loop)) continue;
      let around = 0;
      for (let i = 0; i < m.pos.length / 3; i++) {
        const [x, y] = vtx(m, i);
        if (y > mn[1] && y < mx[1] && x < mn[0] - 0.003 && x > mn[0] - 0.03) around |= 1;
        if (y > mn[1] && y < mx[1] && x > mx[0] + 0.003 && x < mx[0] + 0.03) around |= 2;
        if (x > mn[0] && x < mx[0] && y > mx[1] + 0.003 && y < mx[1] + 0.03) around |= 4;
        if (x > mn[0] && x < mx[0] && y < mn[1] - 0.003 && y > mn[1] - 0.03) around |= 8;
      }
      if (around === 15 && (!best || w * h > best.area)) best = { loop, mesh: mi, area: w * h };
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
  meshes.forEach((m, mi) => {
    const local = new Uint8Array(m.pos.length / 3);
    if (mi !== face) for (const c of comps[mi]) if (c.every((i) => near(vtx(m, i)))) for (const i of c) local[i] = 1;
    for (let t = 0; t < m.index.length; t += 3) {
      const [ia, ib, ic] = [m.index[t], m.index[t + 1], m.index[t + 2]];
      if (mi === face) skin.tri(vtx(m, ia), vtx(m, ib), vtx(m, ic));
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
  for (let i = 0; i < skin.nx; i++) if (!(top[i] - bottom[i] >= gmax * 0.25)) top[i] = bottom[i] = NaN;
  const eye: Eye = { x0: gx0, top, bottom, gmax, ball: new Grid(gx0, gy0 - 0.01, gx1, gy1 + 0.01, true) };

  // 4. Eyeball pieces (their surface is the back-most layer, in the middle of the opening), to keep lids in front.
  meshes.forEach((m, mi) => {
    if (mi === face) return;
    for (const c of comps[mi]) {
      const pts = c.map((i) => vtx(m, i));
      if (!pts.every(near)) continue;
      if (eyeballPiece(eye, pts, back)) {
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
function eyeballPiece(e: Eye, pts: V3[], back: Grid): boolean {
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
function lidWeight(e: Eye, p: V3, upper: boolean, rigid: boolean): { w: number; gap: number; inside: number } {
  const o = openingAt(e, p[0]);
  if (!o) return { w: 0, gap: 0, inside: 0 };
  const mid = (o.top + o.bottom) / 2;
  if (upper ? p[1] < mid : p[1] >= mid) return { w: 0, gap: 0, inside: 0 };
  const h = upper ? p[1] - o.top : o.bottom - p[1]; // height above the upper edge / below the lower one
  // The lid itself (rim, lashes and the skin just above them) moves as one piece; above it the skin stretches
  // up to `reach`, where it no longer moves. (Moving only the rim would uncover the eyeball behind the lid.)
  const lid = (upper ? 0.3 : 0.15) * e.gmax;
  const reach = (upper ? 0.6 : 0.4) * e.gmax;
  const inside = Math.max(0, -h); // how far into the opening it already is
  if (rigid) return { w: h < reach ? 1 : 0, gap: o.gap, inside };
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

// ---------- everything ----------

/**
 * Builds the three morph targets. `eyes`: eyeball centres (face frame). `mouthCorners`: positions of the mouth
 * corners if the rig has bones there. Returns undefined if no eye opening is found.
 */
export function buildFaceMorphs(meshes: FaceMeshIn[], eyes: V3[], mouthCorners?: [V3, V3]): FaceMorphs | undefined {
  const comps = meshes.map(components);
  const found = eyes.map((c) => findEye(meshes, comps, c)).filter((x): x is { eye: Eye; face: number } => !!x);
  if (found.length === 0) return undefined;
  const upper: (Float32Array | undefined)[] = meshes.map(() => undefined);
  const lower: (Float32Array | undefined)[] = meshes.map(() => undefined);
  const mouth: (Float32Array | undefined)[] = meshes.map(() => undefined);
  let moved = 0;

  for (const { eye, face } of found) {
    meshes.forEach((m, mi) => {
      for (const c of comps[mi]) {
        const pts = c.map((i) => vtx(m, i));
        const isFace = mi === face && c.length > m.pos.length / 6; // the face skin itself
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
          if (onBall > pts.length * 0.5) continue; // whites / iris
          if (mn[1] > o.top + 0.3 * eye.gmax) continue; // above the lid: eyebrow
          rigid = true;
        }
        for (const i of c) {
          const p = vtx(m, i);
          for (const [target, isUpper] of [[upper, true], [lower, false]] as const) {
            const { w, gap, inside } = lidWeight(eye, p, isUpper, rigid);
            if (w <= 0 || gap <= 0) continue;
            // Whatever hangs into the opening (the lid's own rim, the lower strip of the lashes) ends up squashed
            // against the closed lid line instead of sticking out below it.
            const dy = (isUpper ? -1 : 1) * (inside > 0 ? gap - 0.85 * inside : w * gap);
            // Stay in front of the eyeball along the whole way (the morph moves in a straight line).
            let dz = 0;
            const startsVisible = (eye.ball.get(p[0], p[1]) ?? -Infinity) + 0.0008 <= p[2];
            // (a vertex hidden behind the eyeball at rest only has to be in front of it once the lid is closed)
            for (let s = startsVisible ? 0.05 : 1; s <= 1.0001; s += 0.05) {
              const b = eye.ball.get(p[0], p[1] + dy * s);
              if (b !== undefined) dz = Math.max(dz, (b + 0.0008 - p[2]) / s);
            }
            dz = Math.min(dz, 0.25 * eye.gmax);
            const arr = (target[mi] ??= new Float32Array(m.pos.length));
            arr[i * 3 + 1] += dy;
            arr[i * 3 + 2] += dz;
            moved++;
          }
        }
      }
    });
  }

  let mouthWidth: number | undefined;
  if (mouthCorners) {
    const mo = findMouth(meshes, found[0].face, mouthCorners);
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
    }
  }
  return { upper, lower, mouth, info: { eyes: found.length, gap: found.map((f) => f.eye.gmax), mouthWidth, moved } };
}

// ---------- three.js glue ----------

export interface LidWeights {
  blink?: number;
  squint?: number;
  eyeSmile?: number;
  eyeWide?: number;
  mouthOpen?: number;
}

/** Morph targets installed on the model's meshes, driven by the face rig's channels. */
export class SynthFace {
  private slots: { mesh: THREE.Mesh; upper?: number; lower?: number; mouth?: number }[] = [];
  readonly hasEyes: boolean;
  readonly hasMouth: boolean;

  private constructor(slots: SynthFace["slots"], hasEyes: boolean, hasMouth: boolean) {
    this.slots = slots;
    this.hasEyes = hasEyes;
    this.hasMouth = hasMouth;
  }

  /**
   * Call in the rest pose. `mouthCorners`: names of the bones at the mouth corners, if any.
   * Returns undefined when the face has no eye openings to work with.
   */
  static build(vrm: VRM, mouthCorners?: [THREE.Object3D, THREE.Object3D]): SynthFace | undefined {
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
    // Which way the face looks (+z after VRMUtils.rotateVRM0, but checked: the eyes are in front of the head bone).
    const front = Math.sign(eyePos.reduce((s, p) => s + p.z, 0) / eyePos.length - world(head).z) || 1;
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
    );
    if (!res) return undefined;
    if (import.meta.env?.DEV) console.info(`[avatar] synthesized face: ${JSON.stringify(res.info)}`);

    // Install: displacements back from the face frame to each mesh's own geometry space.
    const slots: SynthFace["slots"] = [];
    used.forEach((m, mi) => {
      const targets = [res.upper[mi], res.lower[mi], res.mouth[mi]];
      if (!targets.some(Boolean)) return;
      const g = m.geometry;
      const inv = new THREE.Matrix3().setFromMatrix4(toWorld.get(m)!).invert(); // world -> geometry (directions)
      const pos = g.attributes.position;
      const rel = g.morphTargetsRelative || !g.morphAttributes.position?.length;
      if (!g.morphAttributes.position?.length) g.morphTargetsRelative = true;
      const list = (g.morphAttributes.position ??= []);
      const slot: SynthFace["slots"][number] = { mesh: m };
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
        attr.name = `synth_${names[ti]}`;
        slot[names[ti]] = list.length;
        list.push(attr);
        // other morph attributes (normals) must have the same count
        if (g.morphAttributes.normal) g.morphAttributes.normal.push(new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3), 3));
      });
      m.updateMorphTargets();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) mat.needsUpdate = true;
      slots.push(slot);
    });
    return new SynthFace(slots, res.info.eyes > 0, res.info.mouthWidth !== undefined);
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
    const { upper, lower } = SynthFace.lids(w);
    const open = Math.max(0, w.mouthOpen ?? 0);
    for (const s of this.slots) {
      const inf = s.mesh.morphTargetInfluences;
      if (!inf) continue;
      if (s.upper !== undefined) inf[s.upper] = upper;
      if (s.lower !== undefined) inf[s.lower] = lower;
      if (s.mouth !== undefined) inf[s.mouth] = open;
    }
  }
}

import * as THREE from "three";

/**
 * Eyebrows drawn anew for faces whose own eyebrows do not work outside the original game: in anime games the
 * eyebrows are drawn over the fringe (a special render pass); a converted model loses that, so they end up hidden
 * under the hair, and their shape may only make sense with the game's own shader.
 *
 * The new eyebrow is an arched ribbon where the old one was: thicker at the inner end, tapering to a point, in the
 * colours of the model's own eyebrow texture (fill + darker lower edge). It is drawn over the hair and follows the
 * face rig's eyebrow channels (up, angry, sad, furrow). Positions are in the head bone's space (rest pose).
 */

type V3 = [number, number, number];

export interface BrowPiece {
  mesh: THREE.Mesh;
  /** Its vertices in the face frame (world, rest pose: +y up, +z front). */
  points: V3[];
  /** Vertex indices in the mesh (for sampling its texture). */
  verts: number[];
}

const SEG = 18; // segments along each eyebrow

interface Side {
  inner: V3;
  outer: V3;
  /** Thickness at the inner end (m). */
  thick: number;
  /** Arch height (m). */
  arch: number;
  inward: number; // x direction towards the nose
  z: number;
}

/** Colour of the eyebrow: its texture's fill and the darker line along its lower edge. */
function sampleColors(pieces: BrowPiece[]): { fill: THREE.Color; line: THREE.Color } {
  const fallback = { fill: new THREE.Color(0.55, 0.32, 0.36), line: new THREE.Color(0.18, 0.1, 0.12) };
  try {
    const samples: THREE.Color[] = [];
    for (const p of pieces) {
      const mat = (Array.isArray(p.mesh.material) ? p.mesh.material[0] : p.mesh.material) as THREE.Material & { map?: THREE.Texture | null; color?: THREE.Color };
      const img = mat.map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
      const uv = p.mesh.geometry.attributes.uv;
      if (!img || !uv || !img.width) continue;
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const g = canvas.getContext("2d", { willReadFrequently: true });
      if (!g) continue;
      g.drawImage(img, 0, 0);
      const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
      const at = (u: number, v: number) => {
        const x = Math.min(canvas.width - 1, Math.max(0, Math.floor((((u % 1) + 1) % 1) * canvas.width)));
        const y = Math.min(canvas.height - 1, Math.max(0, Math.floor((mat.map!.flipY ? 1 - (((v % 1) + 1) % 1) : ((v % 1) + 1) % 1) * canvas.height)));
        const k = (y * canvas.width + x) * 4;
        return new THREE.Color().setRGB(data[k] / 255, data[k + 1] / 255, data[k + 2] / 255, THREE.SRGBColorSpace);
      };
      // the vertices and the middle of the triangles between them
      const set = new Set(p.verts);
      const index = p.mesh.geometry.index;
      for (const i of p.verts) samples.push(at(uv.getX(i), uv.getY(i)));
      if (index) {
        for (let t = 0; t < index.count; t += 3) {
          const [a, b, c] = [index.getX(t), index.getX(t + 1), index.getX(t + 2)];
          if (!set.has(a) || !set.has(b) || !set.has(c)) continue;
          samples.push(at((uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3, (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3));
        }
      }
    }
    if (samples.length < 6) return fallback;
    const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    samples.sort((a, b) => lum(a) - lum(b));
    const avg = (cs: THREE.Color[]) => cs.reduce((s, c) => s.add(c), new THREE.Color(0, 0, 0)).multiplyScalar(1 / cs.length);
    const line = avg(samples.slice(0, Math.max(1, Math.floor(samples.length * 0.2))));
    const fill = avg(samples.slice(Math.floor(samples.length * 0.4))).multiplyScalar(0.85); // a touch darker than the skin-lit texture
    // an eyebrow must read against the skin: if the fill is almost white, use the line colour for all of it
    if (lum(fill) > 0.8) fill.copy(line);
    return { fill, line };
  } catch {
    return fallback;
  }
}

export class DrawnBrows {
  private sides: Side[] = [];
  private geo: THREE.BufferGeometry[] = [];
  private toHead = new THREE.Matrix4();
  private last = "";

  private constructor(
    private head: THREE.Object3D,
    private unit: number,
  ) {}

  /** `gap`: height of the eye opening (sizes the movements). Undefined if the pieces do not look like two brows. */
  static build(head: THREE.Object3D, pieces: BrowPiece[], gap: number): DrawnBrows | undefined {
    const all = pieces.flatMap((p) => p.points);
    if (all.length < 6) return undefined;
    const midX = (Math.min(...all.map((p) => p[0])) + Math.max(...all.map((p) => p[0]))) / 2;
    const b = new DrawnBrows(head, Math.max(0.0025, Math.min(0.006, 0.3 * gap)));
    head.updateMatrixWorld(true);
    b.toHead.copy(head.matrixWorld).invert();
    for (const side of [1, -1]) {
      const pts = all.filter((p) => (p[0] - midX) * side > 0);
      if (pts.length < 3) return undefined;
      const inner = pts.reduce((a, c) => (Math.abs(c[0] - midX) < Math.abs(a[0] - midX) ? c : a));
      const outer = pts.reduce((a, c) => (Math.abs(c[0] - midX) > Math.abs(a[0] - midX) ? c : a));
      // middle of the old shape near each end, and how tall it was
      const near = (x: number) => pts.filter((p) => Math.abs(p[0] - x) < 0.003);
      const midY = (x: number) => {
        const n = near(x);
        return n.length ? (Math.min(...n.map((p) => p[1])) + Math.max(...n.map((p) => p[1]))) / 2 : inner[1];
      };
      const len = Math.abs(outer[0] - inner[0]);
      const tall = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]));
      const xi = inner[0] + side * 0.1 * len; // pull the ends in a little: the old ends were sharp tips
      const xo = outer[0] - side * 0.02 * len;
      b.sides.push({
        inner: [xi, midY(xi), 0],
        outer: [xo, midY(xo) - 0.08 * len, 0],
        thick: Math.max(0.0015, Math.min(0.15 * len, 0.7 * tall)),
        arch: 0.12 * len,
        inward: -side,
        z: Math.max(...pts.map((p) => p[2])) + 0.0005,
      });
    }
    const { fill, line } = sampleColors(pieces);
    const material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true });
    material.name = "drawn eyebrows";
    for (let s = 0; s < 2; s++) {
      // 4 rows: top and middle in the fill colour, middle and bottom in the line colour (crisp border between them)
      const geo = new THREE.BufferGeometry();
      const n = (SEG + 1) * 4;
      geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
      const col = new Float32Array(n * 3);
      for (let i = 0; i <= SEG; i++) for (let r = 0; r < 4; r++) col.set((r < 2 ? fill : line).toArray(), (i * 4 + r) * 3);
      geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      const idx: number[] = [];
      for (let i = 0; i < SEG; i++) {
        for (const [r0, r1] of [[0, 1], [2, 3]]) {
          const a = i * 4 + r0, bb = i * 4 + r1, c = (i + 1) * 4 + r0, d = (i + 1) * 4 + r1;
          idx.push(a, bb, d, a, d, c);
        }
      }
      geo.setIndex(idx);
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = "drawn eyebrow";
      mesh.renderOrder = 100; // after the hair
      mesh.frustumCulled = false;
      head.add(mesh);
      b.geo.push(geo);
    }
    b.apply({});
    return b;
  }

  /** Reshapes both eyebrows for the channel weights (only when they change). */
  apply(w: { browUp?: number; browAngry?: number; browSad?: number; browFurrow?: number; [channel: string]: number | undefined }) {
    const up = w.browUp ?? 0, angry = w.browAngry ?? 0, sad = w.browSad ?? 0, furrow = w.browFurrow ?? 0;
    const key = [up, angry, sad, furrow].map((v) => v.toFixed(3)).join();
    if (key === this.last) return;
    this.last = key;
    const u = this.unit;
    const v = new THREE.Vector3();
    this.sides.forEach((s, si) => {
      const pos = this.geo[si].attributes.position as THREE.BufferAttribute;
      // anger flattens the arch, sadness lifts its inner half
      const arch = s.arch * (1 - 0.5 * angry + 0.2 * sad);
      for (let i = 0; i <= SEG; i++) {
        const t = i / SEG; // 0 inner .. 1 outer
        let x = s.inner[0] + (s.outer[0] - s.inner[0]) * t;
        let y = s.inner[1] + (s.outer[1] - s.inner[1]) * t + arch * Math.sin(Math.PI * Math.pow(t, 0.8));
        y += u * (up + angry * (-0.9 + 1.4 * t) + sad * (0.9 - 1.4 * t) - furrow * 0.25 * (1 - t));
        x += s.inward * u * 0.45 * (1 - t) * furrow;
        // thick at the inner end (rounded), tapering to a point
        const h = s.thick * Math.min(1, 0.55 + 3 * t) * Math.pow(1 - t, 0.7);
        const rows = [h / 2, -h / 4, -h / 4, -h / 2];
        rows.forEach((dy, r) => {
          v.set(x, y + dy, s.z).applyMatrix4(this.toHead);
          pos.setXYZ(i * 4 + r, v.x, v.y, v.z);
        });
      }
      pos.needsUpdate = true;
    });
  }
}

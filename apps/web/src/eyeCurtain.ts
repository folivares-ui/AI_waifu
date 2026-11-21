import * as THREE from "three";
import type { CurtainEye } from "./synthFace";

/**
 * New eyelids for eyes that were never made to blink (the eyeball is part of the face mesh and the skin around
 * it cannot stretch over it without looking wrong): a sheet of the face's own skin per lid, hidden at rest, that
 * comes down from the upper edge of the eye (and up from the lower one) when she blinks or squints, following
 * the shape of the opening and staying just in front of the eyeball. The lashes move with its edge (morphs).
 *
 * Its texture is the skin right above (or below) the eye, so it looks like the lid that was always there.
 * Built in the face frame (rest pose, world) and stored in the head bone's space, so it follows the head.
 */

const ROWS = 7;

type V3 = [number, number, number];

export class EyeCurtain {
  private upper: THREE.Mesh;
  private lower: THREE.Mesh;
  private toHead = new THREE.Matrix4();
  private last = "";
  /** Front-most point of the eye, and its middle height. */
  private front = 0;
  private midY = 0;

  private constructor(
    private eye: CurtainEye,
    head: THREE.Object3D,
    material: THREE.Material,
    uvAbove: (x: number) => [number, number],
    uvBelow: (x: number) => [number, number],
  ) {
    head.updateMatrixWorld(true);
    this.toHead.copy(head.matrixWorld).invert();
    let f = -Infinity;
    eye.xs.forEach((x, c) => {
      for (let k = 0; k <= 10; k++) f = Math.max(f, eye.ballZ(x, eye.bottom[c] + ((eye.top[c] - eye.bottom[c]) * k) / 10) ?? -Infinity);
    });
    this.front = isFinite(f) ? f : 0;
    this.midY = (Math.max(...eye.top) + Math.min(...eye.bottom)) / 2;
    const make = (uvAt: (x: number) => [number, number], name: string) => {
      const n = eye.xs.length * ROWS;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
      const uv = new Float32Array(n * 2);
      eye.xs.forEach((x, c) => {
        const [u, v] = uvAt(x);
        for (let r = 0; r < ROWS; r++) uv.set([u, v], (c * ROWS + r) * 2);
      });
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      const idx: number[] = [];
      for (let c = 0; c < eye.xs.length - 1; c++) {
        for (let r = 0; r < ROWS - 1; r++) {
          const a = c * ROWS + r, b = a + 1, d = a + ROWS, e = d + 1;
          idx.push(a, d, b, b, d, e);
        }
      }
      g.setIndex(idx);
      const m = new THREE.Mesh(g, material);
      m.name = name;
      m.frustumCulled = false;
      m.visible = false;
      head.add(m);
      return m;
    };
    this.upper = make(uvAbove, "eyelid (upper)");
    this.lower = make(uvBelow, "eyelid (lower)");
  }

  /**
   * `faceMesh`: the mesh holding the face (its skin gives the lids their texture); `pos` its vertices in the
   * face frame. Returns undefined if the face has no texture coordinates.
   */
  static build(head: THREE.Object3D, eyeIn: CurtainEye, faceMesh: THREE.Mesh, pos: Float32Array): EyeCurtain | undefined {
    const uv = faceMesh.geometry.attributes.uv;
    if (!uv || eyeIn.xs.length < 3) return undefined;
    // a little wider than the opening at both corners (the eye white tapers under the skin there)
    const eye: CurtainEye = { ...eyeIn, xs: [...eyeIn.xs], top: [...eyeIn.top], bottom: [...eyeIn.bottom] };
    const step = 0.001;
    for (const end of [0, 1]) {
      const k = end ? eye.xs.length - 1 : 0;
      const mid = (eye.top[k] + eye.bottom[k]) / 2;
      const half = (eye.top[k] - eye.bottom[k]) / 2;
      for (let j = 1; j <= 4; j++) {
        const x = eye.xs[k] + (end ? 1 : -1) * j * step;
        const h = half * (1 - j / 5);
        if (end) {
          eye.xs.push(x);
          eye.top.push(mid + h);
          eye.bottom.push(mid - h);
        } else {
          eye.xs.unshift(x);
          eye.top.unshift(mid + h);
          eye.bottom.unshift(mid - h);
        }
      }
    }
    // the skin vertex nearest to a point, in front (not the eyeball or the inside of the head)
    const nearest = (x: number, y: number, z: number): [number, number] => {
      let best = -1;
      let bd = Infinity;
      for (let i = 0; i < pos.length / 3; i++) {
        if (pos[i * 3 + 2] < z - 0.004) continue;
        const d = Math.hypot(pos[i * 3] - x, pos[i * 3 + 1] - y);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      return best < 0 ? [0, 0] : [uv.getX(best), uv.getY(best)];
    };
    const at = (k: number) => Math.min(eye.xs.length - 1, Math.max(0, k));
    const col = (x: number) => at(eye.xs.findIndex((v) => v >= x));
    const frontAt = (x: number, y: number) => eye.ballZ(x, y) ?? eye.ballZ(x, (eye.top[col(x)] + eye.bottom[col(x)]) / 2) ?? 0;
    const lift = Math.min(0.15 * eye.gmax, 0.004);
    // one plain skin colour for the whole lid (sampling right next to the eye picks up lashes and eyeliner)
    void nearest;
    void lift;
    void frontAt;
    const skinUv: [number, number] = [uv.getX(eye.skinVertex), uv.getY(eye.skinVertex)];
    const uvAbove = () => skinUv;
    const uvBelow = () => skinUv;
    const mat = [faceMesh.material].flat()[0].clone();
    mat.side = THREE.DoubleSide;
    const c = new EyeCurtain(eye, head, mat, uvAbove, uvBelow);
    c.apply(0, 0);
    return c;
  }

  /** `upper` / `lower`: how far each lid has come (fraction of the eye's height at each column). */
  apply(upper: number, lower: number) {
    const key = `${upper.toFixed(3)},${lower.toFixed(3)}`;
    if (key === this.last) return;
    this.last = key;
    const e = this.eye;
    const v = new THREE.Vector3();
    const place = (mesh: THREE.Mesh, amount: number, fromTop: boolean) => {
      mesh.visible = amount > 0.01;
      if (!mesh.visible) return;
      const p = mesh.geometry.attributes.position as THREE.BufferAttribute;
      e.xs.forEach((x, c) => {
        const gap = e.top[c] - e.bottom[c];
        const edge = fromTop ? e.top[c] : e.bottom[c];
        // starts a little behind the edge of the opening, so no seam shows between skin and lid
        const start = edge + (fromTop ? 1 : -1) * Math.min(0.002, 0.08 * gap);
        const end = edge + (fromTop ? -1 : 1) * amount * gap;
        for (let r = 0; r < ROWS; r++) {
          const y = start + ((end - start) * r) / (ROWS - 1);
          // in front of every layer of the eye (white, iris, highlights): its front-most point, plus a margin
          const z = Math.max(this.front - 0.25 * Math.abs(y - this.midY) * 0, e.ballZ(x, y) ?? -Infinity) + 0.0012;
          v.set(x, y, z).applyMatrix4(this.toHead);
          p.setXYZ(c * ROWS + r, v.x, v.y, v.z);
        }
      });
      p.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    };
    // the lower lid only rises to meet the upper one when the eye is nearly shut (a thin strip of skin over the
    // bottom of the iris looks like a patch)
    const meet = Math.max(0, Math.min(1, (upper - 0.6) / 0.25));
    place(this.upper, upper, true);
    place(this.lower, lower * meet, false);
  }
}

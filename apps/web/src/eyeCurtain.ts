import * as THREE from "three";
import { CURTAIN_MEET, type CurtainEye } from "./synthFace";

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

/** Reads the colour (0..1 rgb) of the mesh's texture at a UV, or undefined if it cannot. */
function texelReader(mesh: THREE.Mesh): ((u: number, v: number) => [number, number, number] | undefined) | undefined {
  try {
    const map = ([mesh.material].flat()[0] as THREE.Material & { map?: THREE.Texture | null }).map;
    const img = map?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
    if (!map || !img || !img.width) return undefined;
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const g = cv.getContext("2d", { willReadFrequently: true });
    if (!g) return undefined;
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, cv.width, cv.height).data;
    return (u, v) => {
      const x = Math.min(cv.width - 1, Math.max(0, Math.floor((((u % 1) + 1) % 1) * cv.width)));
      const yy = (((v % 1) + 1) % 1);
      const y = Math.min(cv.height - 1, Math.max(0, Math.floor((map.flipY ? 1 - yy : yy) * cv.height)));
      const k = (y * cv.width + x) * 4;
      return [data[k] / 255, data[k + 1] / 255, data[k + 2] / 255];
    };
  } catch {
    return undefined;
  }
}

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
    uvAbove: (x: number, r: number) => [number, number],
    uvBelow: (x: number, r: number) => [number, number],
  ) {
    head.updateMatrixWorld(true);
    this.toHead.copy(head.matrixWorld).invert();
    let f = -Infinity;
    eye.xs.forEach((x, c) => {
      for (let k = 0; k <= 10; k++) f = Math.max(f, eye.ballZ(x, eye.bottom[c] + ((eye.top[c] - eye.bottom[c]) * k) / 10) ?? -Infinity);
    });
    this.front = isFinite(f) ? f : 0;
    this.midY = (Math.max(...eye.top) + Math.min(...eye.bottom)) / 2;
    const make = (uvAt: (x: number, r: number) => [number, number], name: string, flip: boolean) => {
      const n = eye.xs.length * ROWS;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
      g.setAttribute("normal", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
      const uv = new Float32Array(n * 2);
      eye.xs.forEach((x, c) => {
        for (let r = 0; r < ROWS; r++) uv.set(uvAt(x, r), (c * ROWS + r) * 2);
      });
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      const idx: number[] = [];
      for (let c = 0; c < eye.xs.length - 1; c++) {
        for (let r = 0; r < ROWS - 1; r++) {
          const a = c * ROWS + r, b = a + 1, d = a + ROWS, e = d + 1;
          if (flip) idx.push(a, b, d, b, e, d); // facing the camera
          else idx.push(a, d, b, b, d, e);
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
    this.upper = make(uvAbove, "eyelid (upper)", true);
    this.lower = make(uvBelow, "eyelid (lower)", false);
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
      for (let j = 1; j <= 3; j++) {
        const x = eye.xs[k] + (end ? 1 : -1) * j * step;
        const h = half * (1 - j / 6); // (the hole's edge is steep at the corners: cover it fully)
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
    // The lid continues the skin around the eye: each point of it takes the texture of the face's skin just
    // beyond the opening's edge, as if that skin had slid over the eye (only the skin piece: never the lashes or
    // eyeliner, which are other pieces of the same mesh).
    const skin = eye.skin.filter((i) => {
      const x = pos[i * 3], y = pos[i * 3 + 1];
      return x > eye.xs[0] - 0.02 && x < eye.xs[eye.xs.length - 1] + 0.02 && y > Math.min(...eye.bottom) - 0.03 && y < Math.max(...eye.top) + 0.04;
    });
    const nearest = (x: number, y: number): [number, number] => {
      let best = eye.skinVertex;
      let bd = Infinity;
      for (const i of skin) {
        const d = Math.hypot(pos[i * 3] - x, pos[i * 3 + 1] - y);
        if (d < bd) (bd = d), (best = i);
      }
      return [uv.getX(best), uv.getY(best)];
    };
    // One colour for the whole lid: the skin right above the middle of the eye (the lid's own skin, which is
    // what surrounds the closed eye), if its texel really is skin-coloured; else the forehead.
    const texel = texelReader(faceMesh);
    const ref = texel?.(uv.getX(eye.skinVertex), uv.getY(eye.skinVertex));
    const mid = Math.floor(eye.xs.length / 2);
    let pick: [number, number] = [uv.getX(eye.skinVertex), uv.getY(eye.skinVertex)];
    for (const up of [0.35, 0.5, 0.65, 0.8]) {
      const cand = nearest(eye.xs[mid], eye.top[mid] + up * eye.gmax);
      const c = texel?.(cand[0], cand[1]);
      if (ref && c && Math.abs(c[0] - ref[0]) + Math.abs(c[1] - ref[1]) + Math.abs(c[2] - ref[2]) < 0.15) {
        pick = cand;
        break;
      }
    }
    const uvAbove = () => pick;
    const uvBelow = () => pick;
    const mat = [faceMesh.material].flat()[0].clone();
    mat.side = THREE.DoubleSide;
    const c = new EyeCurtain(eye, head, mat, uvAbove, uvBelow);
    c.apply(0);
    return c;
  }

  /** `k`: how shut the eye is (0 open .. 1 closed). Both lids meet on a line a third of the way up the eye. */
  apply(k: number) {
    const key = k.toFixed(3);
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
        const meet = e.bottom[c] + CURTAIN_MEET * gap;
        const edge = fromTop ? e.top[c] : e.bottom[c];
        // starts a little behind the edge of the opening, so no seam shows between skin and lid
        const start = edge + (fromTop ? 1 : -1) * Math.min(0.002, 0.08 * gap);
        const end = edge + (meet - edge) * amount + (fromTop ? -1 : 1) * 0.0005 * (amount > 0.98 ? 1 : 0);
        for (let r = 0; r < ROWS; r++) {
          const y = start + ((end - start) * r) / (ROWS - 1);
          // in front of every layer of the eye (white, iris, highlights): its front-most point, plus a margin
          const z = Math.max(this.front, e.ballZ(x, y) ?? -Infinity) + 0.0012;
          v.set(x, y, z).applyMatrix4(this.toHead);
          p.setXYZ(c * ROWS + r, v.x, v.y, v.z);
        }
      });
      p.needsUpdate = true;
      mesh.geometry.computeVertexNormals();
    };
    place(this.upper, k, true);
    const j = Math.max(0, Math.min(1, (k - 0.8) / 0.2));
    place(this.lower, j * j * (3 - 2 * j), false); // the lower lid only joins at the very end
  }
}

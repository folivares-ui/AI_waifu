import * as THREE from "three";
import { MToonMaterial, VRMSpringBoneCollider, VRMSpringBoneColliderShapeCapsule, VRMSpringBoneColliderShapeSphere, VRMSpringBoneJoint, VRMSpringBoneManager, type VRM } from "@pixiv/three-vrm";

/**
 * Repairs for models that were not authored as VRM (e.g. game models converted through a generic exporter):
 * they arrive with realistic PBR materials, duplicated meshes, helper meshes and no hair physics.
 * Proper VRM models (MToon materials, spring bones) are left untouched.
 */

const FLAT_SHADED = /face|eye|mayu|brow|lash|cheek|mouth|tooth|teeth|tongue/i; // parts that must not get shadows

/** Replaces PBR materials with anime-style toon materials. Returns how many were converted. */
export function toonify(vrm: VRM): number {
  let converted = 0;
  const cache = new Map<THREE.Material, THREE.Material>();
  vrm.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const convert = (m: THREE.Material): THREE.Material => {
      const std = m as THREE.MeshStandardMaterial;
      if (!std.isMeshStandardMaterial) return m;
      let out = cache.get(m);
      if (!out) {
        const flat = FLAT_SHADED.test(m.name);
        const toon = new MToonMaterial({
          ...(std.map ? { map: std.map, shadeMultiplyTexture: std.map } : {}), // shadows = the texture itself, tinted
          color: std.color,
          shadeColorFactor: flat ? new THREE.Color(1, 1, 1) : new THREE.Color(0.8, 0.74, 0.84),
          shadingToonyFactor: 0.9,
          shadingShiftFactor: flat ? 0 : -0.05,
          giEqualizationFactor: 0.9,
          transparent: std.transparent,
          alphaTest: std.alphaTest,
          side: std.side,
        });
        toon.name = m.name;
        toon.userData.toonBase = { color: toon.color.clone(), shade: toon.shadeColorFactor.clone() };
        out = toon;
        cache.set(m, out);
        converted++;
      }
      return out;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
  });
  for (const old of cache.keys()) old.dispose();
  return converted;
}

/**
 * Brightness of the converted (toonify) materials, per character (soul "look.brightness"). The scene's ambient
 * light adds to the key light, so pale models can burn out to pure white: below 1 they are drawn darker.
 */
export function setToonBrightness(vrm: VRM, k: number) {
  vrm.scene.traverse((o) => {
    const mats = (o as THREE.Mesh).isMesh ? ((o as THREE.Mesh).material as THREE.Material | THREE.Material[]) : [];
    for (const m of Array.isArray(mats) ? mats : [mats]) {
      const base = m.userData.toonBase as { color: THREE.Color; shade: THREE.Color } | undefined;
      if (!base) continue;
      const t = m as MToonMaterial;
      t.color.copy(base.color).multiplyScalar(k);
      t.shadeColorFactor.copy(base.shade).multiplyScalar(k);
    }
  });
}

/**
 * Hides meshes that only make sense inside the original game:
 *  - exact duplicates (same vertex count + same texture), which otherwise z-fight;
 *  - small untextured overlays in an otherwise fully textured model (the game's multiply-blended face shadow,
 *    which a generic renderer draws as an opaque grey patch).
 */
export function hideHelperMeshes(vrm: VRM): string[] {
  const meshes: THREE.Mesh[] = [];
  vrm.scene.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
  const mapOf = (m: THREE.Mesh) => ((Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial).map ?? null;
  const textured = meshes.filter((m) => mapOf(m)).length;
  const seen = new Set<string>();
  const hidden: string[] = [];
  for (const m of meshes) {
    const map = mapOf(m);
    const verts = m.geometry.getAttribute("position")?.count ?? 0;
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
    const matName = mat.name;
    // Fully transparent in the file (alpha 0): invisible in the original too (effects the game drives itself).
    // Converting it to a toon material would lose that and show it as a solid white or black patch.
    if (mat.transparent && mat.opacity <= 0.01) {
      m.visible = false;
      hidden.push(`${matName} (invisible)`);
      continue;
    }
    if (!map && textured >= meshes.length - 2 && verts < 500) {
      m.visible = false;
      hidden.push(`${matName} (untextured overlay)`);
      continue;
    }
    const key = `${verts}:${map?.uuid ?? "none"}`;
    if (map && verts > 1000 && seen.has(key)) {
      m.visible = false;
      hidden.push(`${matName} (duplicate)`);
    }
    seen.add(key);
  }
  return hidden;
}

const SPRING_CHAIN = /^Sp_(He_Hair|Hi_Tail|He_Acc|Hi_Ribbon|So_Collar)\w*_\d\d(_\d{3,4})?$/; // hair, tail, ribbons
const CHAIN_LINK = /^Sp_\w+_\d\d(_\d{3,4})?$/;

/**
 * Adds simple spring physics to "Sp_*" bone chains (hair, tail, ribbons) on models that have such chains but no
 * VRM spring-bone data. No colliders, so settings are stiff to keep hair from sinking into the body.
 * Returns undefined when the model already has springs or has no such chains.
 */
export function addSpringChains(vrm: VRM): VRMSpringBoneManager | undefined {
  if (vrm.springBoneManager && vrm.springBoneManager.joints.size > 0) return undefined;
  const mgr = new VRMSpringBoneManager();
  let count = 0;
  // Hair chains made by the server's automatic rig ("rig_hair_<n>_<k>"): long hair, with the body as obstacles.
  const hairRoots: THREE.Object3D[] = [];
  vrm.scene.traverse((o) => {
    if (/^rig_hair_\d+_0$/.test(o.name)) hairRoots.push(o);
  });
  if (hairRoots.length) {
    const colliders = bodyColliders(vrm);
    const group = { colliders, name: "body" };
    const size = (vrm.humanoid.getRawBoneNode("head")?.getWorldPosition(new THREE.Vector3()).y ?? 1.35) / 0.85; // her height
    for (const root of hairRoots) {
      for (let o: THREE.Object3D | undefined = root; o; ) {
        const next: THREE.Object3D | undefined = o.children.find((c) => /^rig_hair_\d+_\d+$/.test(c.name));
        if (!next) break; // the last joint is the tip: nothing hangs from it
        mgr.addJoint(new VRMSpringBoneJoint(o, next, { stiffness: 0.55, dragForce: 0.35, gravityPower: 0.35, gravityDir: new THREE.Vector3(0, -1, 0), hitRadius: 0.012 * size }, [group]));
        count++;
        o = next;
      }
    }
  }
  vrm.scene.traverse((o) => {
    if (!SPRING_CHAIN.test(o.name)) return;
    const next = o.children.find((c) => CHAIN_LINK.test(c.name)) ?? o.children.find((c) => /_end(_\d+)?$/.test(c.name)) ?? null;
    const isTail = /Tail/.test(o.name);
    mgr.addJoint(new VRMSpringBoneJoint(o, next, { stiffness: isTail ? 0.9 : 1.6, dragForce: 0.55, gravityPower: isTail ? 0.06 : 0.02, gravityDir: new THREE.Vector3(0, -1, 0), hitRadius: 0.01 }));
    count++;
  });
  if (count === 0) return undefined;
  mgr.setInitState();
  return mgr;
}

/**
 * Spheres and capsules standing for her head, neck, chest, hips and upper arms, so swinging hair slides over the
 * body instead of through it. Sizes from her height. Each collider is attached to its bone with the bone's world
 * scale undone, so its radius is in metres whatever the skeleton's scale.
 */
function bodyColliders(vrm: VRM): VRMSpringBoneCollider[] {
  const H = vrm.humanoid;
  const size = (H.getRawBoneNode("head")?.getWorldPosition(new THREE.Vector3()).y ?? 1.35) / 0.85;
  const out: VRMSpringBoneCollider[] = [];
  const attach = (bone: string, shape: VRMSpringBoneColliderShapeSphere | VRMSpringBoneColliderShapeCapsule) => {
    const b = H.getRawBoneNode(bone as never);
    if (!b) return;
    const c = new VRMSpringBoneCollider(shape);
    b.updateWorldMatrix(true, false);
    c.scale.setScalar(1 / (b.getWorldScale(new THREE.Vector3()).x || 1));
    b.add(c);
    out.push(c);
  };
  const toward = (from: string, to: string, k = 1) => {
    const a = H.getRawBoneNode(from as never);
    const b = H.getRawBoneNode(to as never);
    if (!a || !b) return new THREE.Vector3();
    const d = b.getWorldPosition(new THREE.Vector3()).sub(a.getWorldPosition(new THREE.Vector3())).multiplyScalar(k);
    // into the bone's (unscaled) frame
    const q = a.getWorldQuaternion(new THREE.Quaternion()).invert();
    return d.applyQuaternion(q);
  };
  attach("head", new VRMSpringBoneColliderShapeSphere({ radius: 0.062 * size, offset: new THREE.Vector3(0, 0.05 * size, 0.005 * size) }));
  attach("neck", new VRMSpringBoneColliderShapeSphere({ radius: 0.03 * size }));
  // The torso, measured on her own mesh: at several heights, its width and depth around the body's middle line
  // (vertices that follow the spine bones). Each slice becomes spheres side by side filling that ellipse.
  const core = ["hips", "spine", "chest", "upperChest"].map((n) => H.getRawBoneNode(n as never)).filter((b): b is THREE.Object3D => !!b);
  const hipsY = core[0]?.getWorldPosition(new THREE.Vector3()).y ?? 0.8;
  const neckY = (H.getRawBoneNode("neck") ?? H.getRawBoneNode("head"))?.getWorldPosition(new THREE.Vector3()).y ?? hipsY + 0.5;
  const SL = 6;
  const slices: { xs: number[]; zs: number[] }[] = Array.from({ length: SL }, () => ({ xs: [], zs: [] }));
  const coreSet = new Set(core);
  vrm.scene.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  vrm.scene.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.visible) return;
    const pos = m.geometry.attributes.position, si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
    if (!si || !sw) return;
    for (let i = 0; i < pos.count; i += 2) {
      let best = 0;
      for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
      if (!coreSet.has(m.skeleton.bones[si.getComponent(i, best)])) continue;
      m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld);
      const f = (v.y - hipsY) / (neckY - hipsY);
      if (f < 0 || f >= 1) continue;
      const sl = slices[Math.floor(f * SL)];
      sl.xs.push(v.x);
      sl.zs.push(v.z);
    }
  });
  const pct = (a: number[], q: number) => [...a].sort((x, y) => x - y)[Math.floor(q * (a.length - 1))];
  const hipsBone = core[0];
  slices.forEach((sl, k) => {
    if (sl.xs.length < 20 || !hipsBone) return;
    const x0 = pct(sl.xs, 0.04), x1 = pct(sl.xs, 0.96), z0 = pct(sl.zs, 0.04), z1 = pct(sl.zs, 0.96);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
    const r = Math.min(hx, hz) * 1.05;
    const y = hipsY + ((k + 0.5) / SL) * (neckY - hipsY);
    const n = Math.max(1, Math.round(hx / r));
    // which bone carries this height (so the spheres bend with her)
    const bone = core.reduce((a, b) => (b.getWorldPosition(new THREE.Vector3()).y <= y ? b : a), core[0]);
    const bw = bone.getWorldPosition(new THREE.Vector3());
    const q = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
    for (let j = 0; j < n; j++) {
      const x = n === 1 ? cx : cx - hx + r + (j * (2 * hx - 2 * r)) / (n - 1);
      const offset = new THREE.Vector3(x, y, cz).sub(bw).applyQuaternion(q);
      const c = new VRMSpringBoneCollider(new VRMSpringBoneColliderShapeSphere({ radius: r, offset }));
      c.scale.setScalar(1 / (bone.getWorldScale(new THREE.Vector3()).x || 1));
      bone.add(c);
      out.push(c);
    }
  });
  attach("hips", new VRMSpringBoneColliderShapeSphere({ radius: 0.09 * size }));
  for (const s of ["left", "right"]) attach(`${s}UpperArm`, new VRMSpringBoneColliderShapeCapsule({ radius: 0.03 * size, tail: toward(`${s}UpperArm`, `${s}LowerArm`) }));
  return out;
}

/** Close-up for icons: the face, plus hat/ears when the model has them. */
export function faceFraming(vrm: VRM, headY: number, fovDeg: number): { y: number; dist: number } {
  const top = new THREE.Box3().setFromObject(vrm.scene).max.y;
  if (!Number.isFinite(top) || top - headY < 0.3) return { y: headY + 0.045, dist: 1.15 }; // ordinary head
  const hi = top + 0.02;
  const lo = headY - 0.07; // just under the chin
  return { y: (hi + lo) / 2, dist: (hi - lo) / 2 / Math.tan(THREE.MathUtils.degToRad(fovDeg / 2)) };
}

/**
 * Full-screen framing: from the top of the head (hat/ears included) down to the upper thighs, placed in the
 * upper part of the view so the controls at the bottom do not cover her. Works for any aspect ratio.
 */
export function fullFraming(vrm: VRM, fovDeg: number, aspect: number): { y: number; dist: number } {
  const box = new THREE.Box3().setFromObject(vrm.scene);
  const hips = vrm.humanoid.getNormalizedBoneNode("hips")?.getWorldPosition(new THREE.Vector3()).y ?? box.min.y + (box.max.y - box.min.y) * 0.5;
  const hi = box.max.y + 0.04;
  const lo = hips - 0.2;
  const visibleH = (hi - lo) / 0.7; // she fills the top ~70%, the controls take the rest
  const tan = Math.tan(THREE.MathUtils.degToRad(fovDeg / 2));
  const halfW = 0.42; // shoulders, arms and hair
  const dist = Math.max(visibleH / 2 / tan, halfW / (tan * Math.max(aspect, 0.3)));
  const visible = 2 * dist * tan;
  return { y: hi - visible / 2, dist };
}

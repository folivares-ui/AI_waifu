import type * as THREE from "three";

/**
 * "Parts" of a 3D model (hair, clothes, a weapon in her hand...), named after their material, so the user can
 * hide the ones they do not want (Ajustes > Partes del modelo).
 */
export function partName(material: string | undefined, mesh: string): string {
  const raw = (material || mesh || "parte").replace(/(_\d+)+$/, ""); // exporter suffixes: "_1_0_0"
  return raw.replace(/^\d+_/, "").replace(/^[+-]+/, "").replace(/^(mtl|mat|m)_/i, "").trim() || raw;
}

/** Things she should not hold or carry by default. */
const WEAPON = /weapon|wpn|whip|gun|rifle|pistol|revolver|sword|katana|blade|knife|dagger|spear|arrow|baton|hammer|grenade|ammo|holster|wp[A-Z_]/i;
/** Short words only count on their own ("Bow", "R_axe"), never inside others ("Elbow", "Combat", "Waxed"). */
const WEAPON_WORD = /(^|[^a-z])(bow|axe|bat|club)([^a-z]|$)/i;
export const looksLikeWeapon = (part: string) => WEAPON.test(part) || WEAPON_WORD.test(part);

/** The parts of a loaded model, and the meshes that make up each one. */
export function collectParts(root: THREE.Object3D): Map<string, THREE.Object3D[]> {
  const parts = new Map<string, THREE.Object3D[]>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    const name = partName(mat?.name, m.name);
    parts.set(name, [...(parts.get(name) ?? []), m]);
  });
  return parts;
}

/** Which parts to hide: what the user chose, or (never chosen) everything that looks like a weapon. */
export function hiddenOrDefault(saved: string[] | null | undefined, parts: string[]): string[] {
  return saved ?? parts.filter(looksLikeWeapon);
}

import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { describe, expect, it } from "vitest";
import { hideHelperMeshes } from "./avatarFixups";

describe("converted models: helper meshes", () => {
  it("hides meshes whose material is fully transparent (they would turn into solid white/black patches)", () => {
    const scene = new THREE.Group();
    const geo = new THREE.BoxGeometry();
    const tex = new THREE.Texture();
    const body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, name: "body" }));
    const ghost = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0, name: "fx" }));
    const glass = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, transparent: true, opacity: 0.5, name: "glass" }));
    scene.add(body, ghost, glass);
    const hidden = hideHelperMeshes({ scene } as unknown as VRM);
    expect(ghost.visible).toBe(false);
    expect(body.visible).toBe(true);
    expect(glass.visible).toBe(true);
    expect(hidden).toEqual(["fx (invisible)"]);
  });
});

describe("per-character brightness of converted models", () => {
  it("darkens only the converted toon materials, and can be set again later", async () => {
    const { toonify, setToonBrightness } = await import("./avatarFixups");
    const scene = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0xffffff, name: "skin" }));
    scene.add(mesh);
    const vrm = { scene } as unknown as VRM;
    toonify(vrm);
    const mat = mesh.material as unknown as { color: THREE.Color };
    expect(mat.color.r).toBeCloseTo(1);
    setToonBrightness(vrm, 0.78);
    expect(mat.color.r).toBeCloseTo(0.78);
    setToonBrightness(vrm, 1); // from the original colour, not compounded
    expect(mat.color.r).toBeCloseTo(1);
  });
});

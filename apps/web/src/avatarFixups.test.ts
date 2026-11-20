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

import { describe, expect, it } from "vitest";
import { hiddenOrDefault, looksLikeWeapon, partName } from "./modelParts";

describe("model parts", () => {
  it("gives readable names to converted materials", () => {
    expect(partName("5_-WeaponR_1_0_0", "Object_11")).toBe("WeaponR");
    expect(partName("5_+Mask_1_0_0", "Object_7")).toBe("Mask");
    expect(partName("mtl_chr1032_00_hair", "x")).toBe("chr1032_00_hair");
    expect(partName(undefined, "Gun")).toBe("Gun");
  });
  it("hides weapons by default, but the user's choice wins", () => {
    const parts = ["Mask", "WhipHip", "WeaponR", "WhipHand", "Cloth", "HairFront", "Shotgun", "Bow", "Elbow"];
    expect(hiddenOrDefault(null, parts)).toEqual(["WhipHip", "WeaponR", "WhipHand", "Shotgun", "Bow"]);
    expect(hiddenOrDefault(["WeaponR"], parts)).toEqual(["WeaponR"]);
    expect(["Elbow", "Combat_suit", "Waxed", "Clubhouse"].some(looksLikeWeapon)).toBe(false);
    expect(["R_axe", "Bat", "club"].every(looksLikeWeapon)).toBe(true);
  });
});

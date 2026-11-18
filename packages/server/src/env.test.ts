import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnv } from "./env.js";

describe(".env loading", () => {
  it("reads values (Windows paths intact) without overriding the shell", () => {
    const f = join(mkdtempSync(join(tmpdir(), "env-")), ".env");
    writeFileSync(f, "WAIFU_T_A=C:\\Users\\ana\\Docs;D:\\P\n# comentario\nWAIFU_T_B=desde-archivo\nWAIFU_T_C=\nWAIFU_T_D=wav   # comentario\n");
    process.env.WAIFU_T_B = "desde-shell";
    expect(loadDotEnv(f)).toBe(true);
    expect(process.env.WAIFU_T_A).toBe("C:\\Users\\ana\\Docs;D:\\P");
    expect(process.env.WAIFU_T_B).toBe("desde-shell");
    expect(process.env.WAIFU_T_C).toBeUndefined();
    expect(process.env.WAIFU_T_D).toBe("wav");
    expect(loadDotEnv(f + ".nope")).toBe(false);
  });
});

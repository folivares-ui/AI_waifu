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

  it("is not fooled by spaces after '=' or Windows line endings (Notepad)", () => {
    const f = join(mkdtempSync(join(tmpdir(), "env-")), ".env");
    writeFileSync(f, "\uFEFFWAIFU_U_KEY= \r\nWAIFU_U_MODEL=claude-sonnet-5-5\r\nWAIFU_U_FB= \r\n# WAIFU_U_X=15\r\nWAIFU_U_PROV=mock  \r\n");
    loadDotEnv(f);
    expect(process.env.WAIFU_U_KEY).toBeUndefined();
    expect(process.env.WAIFU_U_MODEL).toBe("claude-sonnet-5-5");
    expect(process.env.WAIFU_U_FB).toBeUndefined();
    expect(process.env.WAIFU_U_PROV).toBe("mock");
  });
});

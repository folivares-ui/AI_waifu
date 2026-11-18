import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createToolFactory, onAllClientsGone } from "./index.js";

describe("only while the app is open", () => {
  it("closing the last window withdraws the file access the user granted", async () => {
    const base = mkdtempSync(join(tmpdir(), "life-"));
    const other = join(base, "Fotos");
    mkdirSync(other);
    writeFileSync(join(other, "a.txt"), "hola");
    const make = createToolFactory({ TOOLS: "files", WORKSPACE_DIRS: join(base, "ws"), BACKUP_DIR: join(base, "bk"), SEARCH_DIRS: base })!;
    const tools = make({} as never);
    const t = (n: string) => tools.find((x) => x.def.name === n)!;
    await t("request_file_access").run({ path: other });
    expect(await t("read_document").run({ path: join(other, "a.txt") })).toContain("hola");
    await onAllClientsGone();
    await expect(t("read_document").run({ path: join(other, "a.txt") })).rejects.toThrow(/outside/);
  });
});

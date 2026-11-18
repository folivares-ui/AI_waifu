import { chmodSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBlenderTools, createOpenFileTool } from "./apps.js";
import { createFileTools, findFiles } from "./files.js";
import type { Tool } from "./types.js";
import { Workspace } from "./workspace.js";

const tmp = () => mkdtempSync(join(tmpdir(), "open-"));
const tool = (tools: Tool[], n: string) => tools.find((t) => t.def.name === n)!;

describe("file access outside the workspace", () => {
  it("is refused until the user approves request_file_access, then works until the app closes", async () => {
    const base = tmp();
    const ws = new Workspace([join(base, "ws")]);
    const other = join(base, "Proyectos");
    mkdirSync(other);
    writeFileSync(join(other, "notas.md"), "hola");
    const tools = createFileTools(ws);
    await expect(tool(tools, "read_document").run({ path: join(other, "notas.md") })).rejects.toThrow(/request_file_access/);
    const req = tool(tools, "request_file_access");
    expect(req.kind).toBe("write");
    expect(await req.describe!({ path: other })).toEqual({ summary: "Permitir que use la carpeta «Proyectos» (leer y editar, solo mientras la app este abierta)", details: other });
    await req.run({ path: other });
    expect(await tool(tools, "read_document").run({ path: join(other, "notas.md") })).toContain("hola");
    ws.clearGrants(); // what happens when the last window closes
    await expect(tool(tools, "read_document").run({ path: join(other, "notas.md") })).rejects.toThrow(/outside/);
  });

  it("never grants system/private places, relative paths or missing files", () => {
    const tools = createFileTools(new Workspace([join(tmp(), "ws")]));
    const req = tool(tools, "request_file_access");
    for (const p of ["C:\\\\Windows\\\\System32\\\\drivers\\\\etc\\\\hosts", "/etc/passwd", "/"]) expect(() => req.describe!({ path: p })).toThrow();
    expect(Workspace.forbidden("C:\\Windows\\System32")).toMatch(/system/);
    expect(Workspace.forbidden("C:\\Users\\ana\\AppData\\Roaming\\x")).toMatch(/system/);
    expect(Workspace.forbidden("/home/ana/.ssh/id_rsa")).toMatch(/system/);
    expect(Workspace.forbidden("D:\\Proyectos\\web")).toBeUndefined();
    expect(() => req.describe!({ path: "notas.md" })).toThrow(/full path/);
    expect(() => req.describe!({ path: "/no/existe/x.docx" })).toThrow(/Nothing exists/);
  });
});

describe("find_files", () => {
  it("finds by words of the name, accent/case-insensitive, newest first, skipping hidden and node_modules", () => {
    const d = tmp();
    mkdirSync(join(d, "a/b"), { recursive: true });
    mkdirSync(join(d, "node_modules"));
    mkdirSync(join(d, ".oculto"));
    writeFileSync(join(d, "a/Informe Ventas 2025.xlsx"), "x");
    writeFileSync(join(d, "a/b/informe-ventas-final.docx"), "x");
    writeFileSync(join(d, "node_modules/informe ventas.js"), "x");
    writeFileSync(join(d, ".oculto/informe ventas.txt"), "x");
    utimesSync(join(d, "a/Informe Ventas 2025.xlsx"), new Date(2020, 1, 1), new Date(2020, 1, 1));
    const hits = findFiles([d], "informe VENTAS");
    expect(hits.map((h) => h.path)).toEqual([join(d, "a/b/informe-ventas-final.docx"), join(d, "a/Informe Ventas 2025.xlsx")]);
    expect(findFiles([d], "canción")).toEqual([]);
  });
});

describe("open_file", () => {
  const setup = () => {
    const ws = new Workspace([join(tmp(), "ws")]);
    const opened: string[] = [];
    const t = createOpenFileTool(ws, { opener: async (p) => void opened.push(p), openCode: async (p) => `code:${p}`, openBlend: async (p) => `blender:${p}` });
    return { ws, t, opened, root: ws.roots[0] };
  };
  it("opens documents with their program, code in VS Code, .blend in Blender", async () => {
    const { t, opened, root } = setup();
    for (const f of ["tesis.docx", "main.py", "escena.blend", "foto.png"]) writeFileSync(join(root, f), "x");
    expect(t.kind).toBe("read");
    expect(await t.run({ path: "tesis.docx" })).toBe("Opened tesis.docx for the user.");
    expect(await t.run({ path: "main.py" })).toBe(`code:${join(root, "main.py")}`);
    expect(await t.run({ path: "escena.blend" })).toBe(`blender:${join(root, "escena.blend")}`);
    await t.run({ path: "foto.png" });
    expect(opened).toEqual([join(root, "tesis.docx"), join(root, "foto.png")]);
  });
  it("never runs executables, scripts or shortcuts", async () => {
    const { t, opened, root } = setup();
    for (const f of ["virus.exe", "x.lnk", "macro.vbs", "a.msi", "hoja.xlsm"]) {
      writeFileSync(join(root, f), "x");
      await expect(t.run({ path: f })).rejects.toThrow(/not opened/);
    }
    expect(opened).toEqual([]);
  });
});

describe("Blender in a window", () => {
  it("launches Blender visibly with the script (detached) and blender_open with a file", async () => {
    const dir = tmp();
    const ws = new Workspace([join(dir, "ws")]);
    writeFileSync(join(ws.roots[0], "escena.blend"), "x");
    const log = join(dir, "args.txt");
    const fake = join(dir, "fake-blender.sh");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${log}"\nfor a in "$@"; do case "$a" in *.py) cat "$a" >> "${log}";; esac; done\n`);
    chmodSync(fake, 0o755);
    const tools = createBlenderTools(ws, { BLENDER_PATH: fake }, "linux");
    expect(tool(tools, "blender_open").kind).toBe("read");
    expect(await tool(tools, "blender_run_script").run({ script: "print('cubo')", in_window: true })).toMatch(/open and running/);
    await new Promise((r) => setTimeout(r, 300));
    expect(await tool(tools, "blender_open").run({ path: "escena.blend" })).toBe("Blender is open with escena.blend.");
    await new Promise((r) => setTimeout(r, 300));
    const args = readFileSync(log, "utf8");
    expect(args).toMatch(/--python\n.*script\.py\nprint\('cubo'\)/);
    expect(args).not.toMatch(/--background/);
    expect(args.match(/--disable-autoexec/g)).toHaveLength(2); // both launches: embedded .blend scripts never run
    expect(args).toContain(join(ws.roots[0], "escena.blend"));
  });
});

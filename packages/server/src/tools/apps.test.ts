import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blenderCommand, createBlenderTools, createVSCodeTools, runProgram, vscodeCommand } from "./apps.js";
import type { Tool } from "./types.js";
import { Workspace } from "./workspace.js";

const tmp = () => mkdtempSync(join(tmpdir(), "apps-"));
const tool = (tools: Tool[], n: string) => tools.find((t) => t.def.name === n)!;

describe("runProgram", () => {
  it("never uses a shell (metacharacters are plain arguments) and enforces timeouts", async () => {
    const r = await runProgram("node", ["-e", "console.log(process.argv.slice(1).join('|'))", "a; rm -rf /", "$(whoami)"]);
    expect(r.stdout.trim()).toBe("a; rm -rf /|$(whoami)");
    const d = tmp();
    const pwd = await runProgram("node", ["-e", "console.log(process.cwd() + '|' + process.env.PWD)"], { cwd: d });
    expect(pwd.stdout.trim()).toBe(`${d}|${d}`); // $PWD follows cwd (Blender relies on it for relative paths)
    const slow = await runProgram("node", ["-e", "setTimeout(()=>{}, 5000)"], { timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
  });
});

describe("VS Code", () => {
  it("finds the CLI per platform", () => {
    expect(vscodeCommand({}, "linux")).toEqual({ bin: "code", viaCmd: false });
    expect(vscodeCommand({ LOCALAPPDATA: "C:\\nope" }, "win32")).toEqual({ bin: "code.cmd", viaCmd: true });
    expect(vscodeCommand({ VSCODE_CLI: "C:\\x\\code.cmd" }, "win32").viaCmd).toBe(true);
  });

  it("opens workspace files at a line with exact arguments; refuses paths outside", async () => {
    const dir = tmp();
    const ws = new Workspace([join(dir, "ws")]);
    writeFileSync(join(ws.roots[0], "main.py"), "print(1)");
    const log = join(dir, "args.txt");
    const fake = join(dir, "fake-code.sh");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`);
    chmodSync(fake, 0o755);
    const open = tool(createVSCodeTools(ws, { VSCODE_CLI: fake }, "linux"), "vscode_open");
    expect(open.kind).toBe("read");
    expect(await open.run({ path: "main.py", line: 3 })).toBe("Opened main.py at line 3 in VS Code.");
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["--reuse-window", "--goto", `${join(ws.roots[0], "main.py")}:3`]);
    await expect(open.run({ path: "/etc/passwd" })).rejects.toThrow(/outside/);
  });

  it("on Windows refuses paths that cmd.exe could misinterpret", async () => {
    const dir = tmp();
    const ws = new Workspace([join(dir, "ws")]);
    writeFileSync(join(ws.roots[0], "a&calc.py"), "");
    const open = tool(createVSCodeTools(ws, { VSCODE_CLI: "C:\\code.cmd" }, "win32"), "vscode_open");
    await expect(open.run({ path: "a&calc.py" })).rejects.toThrow(/cannot be passed safely/);
  });
});

describe("Blender command lookup", () => {
  it("prefers BLENDER_PATH, then platform defaults", () => {
    expect(blenderCommand({ BLENDER_PATH: "/opt/b/blender" }, "linux")).toBe("/opt/b/blender");
    expect(blenderCommand({ ProgramFiles: "C:\\nope" }, "win32")).toBe("blender.exe");
    expect(blenderCommand({}, "linux")).toBe("blender");
  });
});

let hasBlender = false;
try {
  execFileSync("blender", ["--version"], { stdio: "ignore", timeout: 30_000 });
  hasBlender = true;
} catch {
  /* not installed here */
}

(hasBlender ? describe : describe.skip)("Blender (real)", () => {
  const dir = tmp();
  const ws = new Workspace([join(dir, "ws")]);
  const tools = createBlenderTools(ws);
  const run = tool(tools, "blender_run_script");
  const inspect = tool(tools, "blender_inspect");

  it("asks with the full script and a clear warning; inspection is read-only", async () => {
    expect(run.kind).toBe("write");
    expect(inspect.kind).toBe("read");
    const info = await run.describe!({ script: "import bpy\nprint('hi')" });
    expect(info.summary).toMatch(/^Ejecutar un script de Python .*revisalo/);
    expect((await run.describe!({ script: "x", in_window: true })).summary).toMatch(/^Abrir Blender y ejecutar/);
    expect(info.details).toBe("import bpy\nprint('hi')");
    expect(() => run.describe!({ script: " " })).toThrow(/required/);
  });

  it("runs a script that builds and saves a scene, then inspects the saved file", async () => {
    const out = (await run.run({
      script: [
        "import bpy",
        "bpy.ops.wm.read_factory_settings(use_empty=True)",
        "bpy.ops.mesh.primitive_uv_sphere_add(location=(1, 2, 3))",
        "bpy.context.object.name = 'Luna'",
        "mat = bpy.data.materials.new('Plata'); bpy.context.object.data.materials.append(mat)",
        "bpy.context.scene.frame_end = 48",
        "bpy.ops.wm.save_as_mainfile(filepath='escena.blend')",
        "print('GUARDADO OK')",
      ].join("\n"),
    })) as string;
    expect(out).toContain("GUARDADO OK");
    expect(existsSync(join(ws.roots[0], "escena.blend"))).toBe(true);
    const info = JSON.parse(((await inspect.run({ path: "escena.blend" })) as string).split("\n").slice(1, -2).join("\n"));
    expect(info.frames).toEqual([1, 48]);
    expect(info.objects).toEqual([{ name: "Luna", type: "MESH", location: [1, 2, 3], materials: ["Plata"] }]);
    expect(info.materials).toContain("Plata");
  }, 120_000);

  it("reports Python errors in the script as a failure", async () => {
    await expect(run.run({ script: "import bpy\nraise ValueError('boom')" })).rejects.toThrow(/failed \(exit 1\)[\s\S]*boom/);
  }, 120_000);

  it("only accepts .blend files from the workspace", async () => {
    writeFileSync(join(ws.roots[0], "x.txt"), "");
    await expect(inspect.run({ path: "x.txt" })).rejects.toThrow(/\.blend/);
    await expect(inspect.run({ path: "/tmp/other.blend" })).rejects.toThrow(/outside|not found/);
  });
});

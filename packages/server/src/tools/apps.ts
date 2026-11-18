import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { untrusted, type Tool } from "./types.js";
import type { Workspace } from "./workspace.js";

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a program WITHOUT a shell (arguments are never interpreted), with a time limit and capped output. */
export function runProgram(bin: string, args: string[], opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; maxOutput?: number } = {}): Promise<RunResult> {
  const max = opts.maxOutput ?? 60_000;
  return new Promise((resolve, reject) => {
    // Some programs (Blender) resolve relative paths with $PWD, which spawn() does not update along with cwd.
    const env = opts.cwd ? { ...process.env, PWD: opts.cwd } : process.env;
    const p = spawn(bin, args, { cwd: opts.cwd, env, shell: false, windowsHide: true, signal: opts.signal });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, opts.timeoutMs ?? 120_000);
    p.stdout.on("data", (d) => (stdout = (stdout + d).slice(-max)));
    p.stderr.on("data", (d) => (stderr = (stderr + d).slice(-max)));
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Starts a desktop program for the user to see, without waiting for it (it keeps running after this call). */
export function launchDetached(bin: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, env: cwd ? { ...process.env, PWD: cwd } : process.env, shell: false, detached: true, stdio: "ignore", windowsHide: false });
    p.once("error", reject);
    p.once("spawn", () => {
      p.unref();
      resolve();
    });
  });
}

// ---------- VS Code ---------------------------------------------------------------------------------------------

/**
 * VS Code's command line. On Windows `code` is a .cmd script, which Node can only start through cmd.exe; to rule
 * out command injection, paths with cmd.exe metacharacters are refused there.
 */
export function vscodeCommand(env: NodeJS.ProcessEnv = process.env, platform = process.platform): { bin: string; viaCmd: boolean } {
  if (env.VSCODE_CLI) return { bin: env.VSCODE_CLI, viaCmd: platform === "win32" && /\.(cmd|bat)$/i.test(env.VSCODE_CLI) };
  if (platform === "win32") {
    const local = join(env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "bin", "code.cmd");
    return { bin: existsSync(local) ? local : "code.cmd", viaCmd: true };
  }
  return { bin: "code", viaCmd: false };
}

const CMD_META = /[&|<>^%!"()\r\n]/;

export function createVSCodeTools(ws: Workspace, env: NodeJS.ProcessEnv = process.env, platform = process.platform): Tool[] {
  const open: Tool = {
    kind: "read", // only shows a file to the user; edits go through write_text_file (with approval)
    def: {
      name: "vscode_open",
      description: "Open a file (optionally at a line) or a folder from the workspace in Visual Studio Code, to show the user something. To change code, use write_text_file.",
      input_schema: { type: "object", properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 } }, required: ["path"] },
    },
    async run(input, signal) {
      const i = input as { path: string; line?: number };
      const real = ws.resolve(String(i?.path ?? ""), { mustExist: true });
      const { bin, viaCmd } = vscodeCommand(env, platform);
      const target = i.line ? `${real}:${Math.floor(i.line)}` : real;
      if (viaCmd && CMD_META.test(target)) throw new Error("This path contains characters that cannot be passed safely to VS Code on Windows; rename it or open it by hand.");
      const args = ["--reuse-window", ...(i.line ? ["--goto", target] : [target])];
      const r = viaCmd
        ? await runProgram(env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${bin}" ${args.map((a) => `"${a}"`).join(" ")}`], { timeoutMs: 20_000, signal })
        : await runProgram(bin, args, { timeoutMs: 20_000, signal });
      if (r.code !== 0 && !r.timedOut) throw new Error(`VS Code did not open the file (exit ${r.code}): ${r.stderr.slice(0, 200) || "is VS Code installed and 'code' on the PATH? Set VSCODE_CLI."}`);
      return `Opened ${ws.display(real)}${i.line ? ` at line ${i.line}` : ""} in VS Code.`;
    },
  };
  return [open];
}

// ---------- Blender ---------------------------------------------------------------------------------------------

/** Finds blender: BLENDER_PATH, the newest "Blender Foundation" install on Windows, or "blender" on the PATH. */
export function blenderCommand(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.BLENDER_PATH) return env.BLENDER_PATH;
  if (platform === "win32") {
    const base = join(env.ProgramFiles ?? "C:\\Program Files", "Blender Foundation");
    if (existsSync(base)) {
      const versions = readdirSync(base).filter((d) => /^Blender/i.test(d)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      const newest = versions.at(-1);
      if (newest && existsSync(join(base, newest, "blender.exe"))) return join(base, newest, "blender.exe");
    }
    return "blender.exe";
  }
  if (platform === "darwin" && existsSync("/Applications/Blender.app/Contents/MacOS/Blender")) return "/Applications/Blender.app/Contents/MacOS/Blender";
  return "blender";
}

/** Read-only summary of a .blend file, printed between markers so Blender's own log lines can be ignored. */
const INSPECT_SCRIPT = `
import bpy, json
s = bpy.context.scene
info = {
  "scene": s.name, "frames": [s.frame_start, s.frame_end], "fps": s.render.fps,
  "render": {"engine": s.render.engine, "resolution": [s.render.resolution_x, s.render.resolution_y]},
  "objects": [{"name": o.name, "type": o.type, "location": [round(v, 3) for v in o.location],
               "materials": [m.name for m in getattr(o.data, "materials", []) if m] if o.data else []} for o in s.objects][:300],
  "materials": [m.name for m in bpy.data.materials][:200],
  "cameras": [c.name for c in bpy.data.cameras], "lights": [l.name for l in bpy.data.lights],
}
print("@@WAIFU_JSON@@" + json.dumps(info) + "@@END@@")
`;

function blenderOutput(r: RunResult): string {
  const log = (r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : "")).trim();
  if (r.timedOut) return `Blender was stopped after the time limit.\n${log.slice(-3000)}`;
  return log.slice(-8000) || "(no output)";
}

export function createBlenderTools(ws: Workspace, env: NodeJS.ProcessEnv = process.env, platform = process.platform): Tool[] {
  const bin = () => blenderCommand(env, platform);
  const blendPath = (p: unknown) => {
    const real = ws.resolve(String(p ?? ""), { mustExist: true });
    if (extname(real).toLowerCase() !== ".blend") throw new Error("Expected a .blend file.");
    return real;
  };

  const inspect: Tool = {
    kind: "read",
    def: {
      name: "blender_inspect",
      description: "Summarise a .blend file from the workspace (scene, frame range, render settings, objects, materials, cameras, lights) without changing it.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    async run(input, signal) {
      const real = blendPath((input as { path?: string })?.path);
      const dir = await mkdtemp(join(tmpdir(), "waifu-blender-"));
      try {
        const script = join(dir, "inspect.py");
        await writeFile(script, INSPECT_SCRIPT);
        // --disable-autoexec: never run scripts embedded in the user's .blend file.
        const r = await runProgram(bin(), ["--background", "--disable-autoexec", "--factory-startup", real, "--python", script], { timeoutMs: 120_000, signal });
        const m = r.stdout.match(/@@WAIFU_JSON@@([\s\S]*?)@@END@@/);
        if (!m) throw new Error(`Blender did not return the summary (exit ${r.code}).\n${blenderOutput(r).slice(-1500)}`);
        return untrusted(ws.display(real), JSON.stringify(JSON.parse(m[1]), null, 1));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };

  const run: Tool = {
    kind: "write",
    def: {
      name: "blender_run_script",
      description:
        "Run a Blender Python (bpy) script in the background, optionally on a .blend file from the workspace. To keep changes, the script must save explicitly (e.g. bpy.ops.wm.save_as_mainfile(filepath='name.blend'); relative paths are inside the user's workspace folder). Prints are returned. The user sees the whole script and must approve.",
      input_schema: {
        type: "object",
        properties: {
          script: { type: "string", description: "Python code using bpy" },
          blend_file: { type: "string", description: "Optional .blend file to open first" },
          in_window: { type: "boolean", description: "Open Blender visibly and run the script there, so the user sees the result (default: run in the background)" },
          timeout_s: { type: "integer", minimum: 5, maximum: 1800 },
        },
        required: ["script"],
      },
    },
    describe(input) {
      const i = input as { script?: string; blend_file?: string; in_window?: boolean };
      if (typeof i?.script !== "string" || !i.script.trim()) throw new Error("script is required.");
      const file = i.blend_file ? ws.display(blendPath(i.blend_file)) : undefined;
      return {
        summary: `${i.in_window ? "Abrir Blender y ejecutar" : "Ejecutar"} un script de Python${file ? ` sobre ${file}` : ""} (un script puede hacer cualquier cosa en tu equipo: revisalo)`,
        details: i.script,
      };
    },
    async run(input, signal) {
      const i = input as { script: string; blend_file?: string; timeout_s?: number; in_window?: boolean };
      if (i.in_window) {
        // Visible Blender: the user watches the script build the scene and keeps working in it.
        const dir = await mkdtemp(join(tmpdir(), "waifu-blender-"));
        const script = join(dir, "script.py");
        await writeFile(script, i.script);
        // --disable-autoexec: scripts embedded in the .blend never run, even if auto-run was enabled in Preferences.
        await launchDetached(bin(), ["--disable-autoexec", ...(i.blend_file ? [blendPath(i.blend_file)] : []), "--python", script], ws.roots[0]);
        setTimeout(() => void rm(dir, { recursive: true, force: true }), 120_000).unref(); // Blender has read it by then
        return "Blender is open and running the script in its window.";
      }
      const dir = await mkdtemp(join(tmpdir(), "waifu-blender-"));
      try {
        const script = join(dir, "script.py");
        await writeFile(script, i.script);
        const args = ["--background", "--disable-autoexec", ...(i.blend_file ? [blendPath(i.blend_file)] : ["--factory-startup"]), "--python-exit-code", "1", "--python", script];
        const r = await runProgram(bin(), args, { cwd: ws.roots[0], timeoutMs: (i.timeout_s ?? 300) * 1000, signal });
        const out = blenderOutput(r);
        if (r.code !== 0) throw new Error(`The script failed (exit ${r.code}).\n${out}`);
        return untrusted("blender output", out);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };

  const open: Tool = {
    kind: "read",
    def: {
      name: "blender_open",
      description: "Open Blender visibly for the user, with a .blend file from the workspace or an empty scene (to model or animate, use blender_run_script with in_window).",
      input_schema: { type: "object", properties: { path: { type: "string" } } },
    },
    async run(input) {
      const path = (input as { path?: string })?.path;
      const real = path ? blendPath(path) : undefined;
      await launchDetached(bin(), ["--disable-autoexec", ...(real ? [real] : [])], ws.roots[0]);
      return `Blender is open${real ? ` with ${ws.display(real)}` : ""}.`;
    },
  };

  return [inspect, run, open];
}

// ---------- opening files with their program ---------------------------------------------------------------------

/** Opened with the program the user has for them (Word, Excel, a PDF viewer...). Never executables or scripts. */
const DOC_EXTS = new Set([".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".pdf", ".txt", ".md", ".csv", ".rtf", ".odt", ".ods", ".odp", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".mp3", ".wav", ".ogg", ".flac", ".mp4", ".mov", ".mkv", ".avi", ".webm"]);
/** Code is shown in VS Code: opening it "with its program" could run it. */
const CODE_EXTS = new Set([".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".html", ".htm", ".css", ".json", ".xml", ".yaml", ".yml", ".toml", ".ini", ".sql", ".sh", ".ps1", ".bat", ".cmd", ".c", ".cpp", ".h", ".hpp", ".cs", ".java", ".go", ".rs", ".php", ".rb", ".lua", ".kt", ".swift", ".dart", ".vue", ".svelte", ".svg"]); // .svg can contain scripts: shown as text

export function defaultOpener(platform = process.platform, env: NodeJS.ProcessEnv = process.env): (path: string) => Promise<void> {
  if (platform === "win32") {
    return async (path) => {
      if (CMD_META.test(path)) throw new Error("This path contains characters that cannot be passed safely on Windows; rename it or open it by hand.");
      await launchDetached(env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `start "" "${path}"`]);
    };
  }
  return (path) => launchDetached(platform === "darwin" ? "open" : "xdg-open", [path]);
}

export function createOpenFileTool(ws: Workspace, opts: { opener?: (path: string) => Promise<void>; openCode?: (path: string) => Promise<string>; openBlend?: (path: string) => Promise<string> } = {}): Tool {
  const opener = opts.opener ?? defaultOpener();
  return {
    kind: "read", // only shows the file to the user; any change still goes through an approval card
    def: {
      name: "open_file",
      description:
        "Open a file for the user in its program: documents in Word/Excel/PowerPoint/PDF viewer, images, audio/video; code files in VS Code; .blend files in Blender. Use find_files to locate a file by name. Executables and scripts are never run. Note: a document that is open in Word/Excel cannot be edited with the file tools until the user closes it.",
      input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
    async run(input) {
      const real = ws.resolve(String((input as { path?: string })?.path ?? ""), { mustExist: true });
      const ext = extname(real).toLowerCase();
      if (ext === ".blend") {
        if (!opts.openBlend) throw new Error("Blender is not enabled (TOOLS=blender).");
        return opts.openBlend(real);
      }
      if (CODE_EXTS.has(ext)) {
        if (!opts.openCode) throw new Error("Code files open in VS Code, which is not enabled (TOOLS=vscode).");
        return opts.openCode(real);
      }
      if (!DOC_EXTS.has(ext)) throw new Error(`For safety, "${ext || "this type of"}" files are not opened (no executables, scripts or shortcuts).`);
      await opener(real);
      return `Opened ${ws.display(real)} for the user.`;
    },
  };
}

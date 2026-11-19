import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Starts VoiceStudio by itself when Rice starts (if it is not already running), so you do not have to open it.
 * Its location comes from VOICESTUDIO_PATH, or a few usual install folders are tried.
 */
export function findVoiceStudio(env: NodeJS.ProcessEnv = process.env, platform = process.platform, exists: (p: string) => boolean = existsSync): string | undefined {
  const set = env.VOICESTUDIO_PATH?.trim().replace(/^"|"$/g, "");
  if (set) return exists(set) ? set : undefined;
  const candidates: string[] = [];
  if (platform === "win32") {
    for (const base of [env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs"), env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (!base) continue;
      for (const dir of ["VoiceStudio", "voicestudio", "Voice Studio"]) candidates.push(join(base, dir, "VoiceStudio.exe"));
    }
  } else if (platform === "darwin") {
    candidates.push("/Applications/VoiceStudio.app/Contents/MacOS/VoiceStudio");
  }
  return candidates.find((p) => exists(p));
}

/**
 * The environment VoiceStudio gets: like opening it by hand. Node/npm/tsx settings of this server (NODE_OPTIONS
 * with a TypeScript loader, ELECTRON_RUN_AS_NODE, npm_* ...) could stop an Electron app from starting normally.
 */
export function cleanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|TSX_.*|npm_.*|INIT_CWD|WAIFU_.*)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export async function isUp(root: string, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${root}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export type LaunchResult = { status: "running" } | { status: "started"; child: ChildProcess } | { status: "not-found" } | { status: "timeout"; child: ChildProcess };

/** Makes sure VoiceStudio answers at `root`, opening it if needed and waiting for it to be ready. */
export async function ensureVoiceStudio(
  root: string,
  opts: { exe?: string; timeoutMs?: number; log?: (msg: string) => void; up?: (root: string) => Promise<boolean>; launch?: (exe: string) => ChildProcess; sleep?: (ms: number) => Promise<void> } = {},
): Promise<LaunchResult> {
  const up = opts.up ?? isUp;
  if (await up(root)) return { status: "running" };
  const exe = opts.exe;
  if (!exe) return { status: "not-found" };
  const launch = opts.launch ?? ((p: string) => spawn(p, [], { cwd: dirname(p), env: cleanEnv(), detached: false, stdio: "ignore", windowsHide: false }));
  opts.log?.(`VoiceStudio is closed: opening ${exe} ...`);
  const child = launch(exe);
  child.on("error", (e) => opts.log?.(`could not open VoiceStudio (${e.message}). Check VOICESTUDIO_PATH in .env.`));
  child.on("exit", (code) => opts.log?.(`the VoiceStudio program the app opened has exited (code ${code}); if its window is not open, open it by hand and tell what happened.`));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (opts.timeoutMs ?? 120_000); // loading its voice models can take a while
  while (Date.now() < deadline) {
    await sleep(1500);
    if (await up(root)) return { status: "started", child };
  }
  return { status: "timeout", child };
}

/** Closes a VoiceStudio we opened (with its helper processes). Safe to call from process "exit". */
export function closeLaunched(child: ChildProcess | undefined, platform = process.platform) {
  if (!child?.pid || child.exitCode !== null) return;
  try {
    if (platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else child.kill();
  } catch {
    /* already gone */
  }
}

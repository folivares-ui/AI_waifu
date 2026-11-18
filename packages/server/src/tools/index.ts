import { resolve } from "node:path";
import { loadCatalog } from "./catalog.js";
import { createPublicApiTools, loadKeys } from "./public-apis.js";
import { homedir } from "node:os";
import { delimiter } from "node:path";
import { existsSync } from "node:fs";
import { createBlenderTools, createOpenFileTool, createVSCodeTools } from "./apps.js";
import { BrowserController, createBrowserTools } from "./browser.js";
import { DesktopClient, createDesktopTools } from "./desktop.js";
import { createFileTools } from "./files.js";
import { createScreenTool } from "./screen.js";
import { Workspace } from "./workspace.js";
import type { Tool, ToolContext } from "./types.js";

export type { Tool, ToolContext, ToolResult } from "./types.js";

import { userOrApp, userPath } from "../paths.js";

/**
 * Tools are OFF by default. Enable with TOOLS=public_apis,screen (comma separated).
 *  - public_apis: search/read/call the public-apis catalog (GET only)
 *  - screen:      look_at_screen (needs a vision-capable brain and the user sharing their screen in the client)
 * Returns a factory so every session gets its own tool state and its own screen channel.
 */
/** Closed when the server stops. */
export let browserForShutdown: BrowserController | undefined;
let workspaceForLifecycle: Workspace | undefined;

/**
 * She only acts on other programs while this app is open: when the last window/client goes away, her own Chrome
 * window is closed and every one-off file permission is withdrawn. (Turns in progress are cancelled by the session.)
 */
export async function onAllClientsGone() {
  workspaceForLifecycle?.clearGrants();
  await browserForShutdown?.close();
}

export function createToolFactory(env: NodeJS.ProcessEnv = process.env): ((ctx: ToolContext) => Tool[]) | undefined {
  const enabled = (env.TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (enabled.length === 0) return undefined;
  const KNOWN = ["public_apis", "screen", "files", "browser", "vscode", "blender", "desktop"];
  const unknown = enabled.filter((t) => !KNOWN.includes(t));
  if (unknown.length) throw new Error(`Unknown TOOLS entries: ${unknown.join(", ")} (known: ${KNOWN.join(", ")})`);
  let apis: { entries: import("./catalog.js").ApiEntry[]; keys: ReturnType<typeof loadKeys> } | undefined;
  if (enabled.includes("public_apis")) {
    const catalog = loadCatalog(userOrApp(env.PUBLIC_APIS_FILE ?? "data/public-apis.json"));
    const keys = loadKeys(env.API_KEYS_FILE ?? userPath("data/api-keys.json"));
    apis = { entries: catalog.entries, keys };
    console.log(`[tools] public_apis enabled: ${catalog.entries.length} APIs, ${Object.keys(keys).length} host key(s) configured`);
  }
  let workspace: Workspace | undefined;
  if (["files", "vscode", "blender"].some((t) => enabled.includes(t))) {
    // Folders she may read and edit. Default: Documents/AiWaifu in the user's home. Separate several with ";" on
    // Windows or ":" elsewhere.
    const dirs = (env.WORKSPACE_DIRS ?? resolve(homedir(), "Documents", "AiWaifu")).split(delimiter).map((d) => d.trim()).filter(Boolean);
    workspace = new Workspace(dirs, env.BACKUP_DIR ?? userPath("data/backups"));
    console.log(`[tools] files enabled in: ${workspace.roots.join(", ")} (backups in ${env.BACKUP_DIR ?? "data/backups"})`);
  }
  let browser: BrowserController | undefined;
  if (enabled.includes("browser")) {
    browser = new BrowserController({
      profileDir: env.BROWSER_PROFILE_DIR ?? userPath("data/browser-profile"),
      channel: env.BROWSER_CHANNEL,
      executablePath: env.BROWSER_EXECUTABLE,
      headless: env.BROWSER_HEADLESS === "1",
      allowPrivate: env.BROWSER_ALLOW_PRIVATE === "1",
    });
    browserForShutdown = browser;
    console.log(`[tools] browser enabled (own profile in ${env.BROWSER_PROFILE_DIR ?? "data/browser-profile"}; local addresses ${env.BROWSER_ALLOW_PRIVATE === "1" ? "ALLOWED" : "blocked"})`);
  }
  let desktop: DesktopClient | undefined;
  if (enabled.includes("desktop")) {
    // Provided by the desktop app (apps/desktop) when it starts this server; absent in a plain browser setup.
    if (env.WAIFU_DESKTOP_URL && env.WAIFU_DESKTOP_TOKEN) {
      desktop = new DesktopClient(env.WAIFU_DESKTOP_URL, env.WAIFU_DESKTOP_TOKEN);
      console.log("[tools] desktop control enabled (screen + mouse/keyboard; every action needs approval)");
    } else console.warn("[tools] desktop control requested, but the server was not started by the desktop app: skipped");
  }
  if (enabled.includes("screen")) console.log("[tools] screen enabled: she can look at your screen only while you share it in the client");
  workspaceForLifecycle = workspace;
  // Usual places where the user keeps files, for find_files (names only; using them still needs approval).
  const home = homedir();
  const searchDirs = (env.SEARCH_DIRS ? env.SEARCH_DIRS.split(delimiter) : ["Documents", "Desktop", "Downloads", "OneDrive/Documents", "OneDrive/Desktop", "Documentos", "Escritorio", "Descargas"].map((d) => resolve(home, d)))
    .map((d) => d.trim())
    .filter((d) => d && existsSync(d));
  return (ctx) => [
    ...(apis ? createPublicApiTools({ entries: apis.entries, keys: apis.keys, log: (m) => console.log(`[tools] ${m}`) }) : []),
    ...(enabled.includes("screen") ? [createScreenTool(ctx)] : []),
    ...(workspace ? createFileTools(workspace, searchDirs) : []),
    ...(browser ? createBrowserTools(browser) : []),
    ...(desktop ? createDesktopTools(desktop) : []),
    ...(workspace && enabled.includes("vscode") ? createVSCodeTools(workspace) : []),
    ...(workspace && enabled.includes("blender") ? createBlenderTools(workspace) : []),
    ...(workspace ? [openFileTool(workspace, enabled)] : []),
  ];
}

/** open_file routes code to VS Code and .blend files to Blender when those tools are enabled. */
function openFileTool(ws: Workspace, enabled: string[]): Tool {
  const viaTool = (tools: Tool[], name: string) => async (path: string) => String(await tools.find((t) => t.def.name === name)!.run({ path }));
  return createOpenFileTool(ws, {
    openCode: enabled.includes("vscode") ? viaTool(createVSCodeTools(ws), "vscode_open") : undefined,
    openBlend: enabled.includes("blender") ? viaTool(createBlenderTools(ws), "blender_open") : undefined,
  });
}

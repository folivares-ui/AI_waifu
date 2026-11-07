import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./catalog.js";
import { createPublicApiTools, loadKeys } from "./public-apis.js";
import { createScreenTool } from "./screen.js";
import type { Tool, ToolContext } from "./types.js";

export type { Tool, ToolContext, ToolResult } from "./types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Tools are OFF by default. Enable with TOOLS=public_apis,screen (comma separated).
 *  - public_apis: search/read/call the public-apis catalog (GET only)
 *  - screen:      look_at_screen (needs a vision-capable brain and the user sharing their screen in the client)
 * Returns a factory so every session gets its own tool state and its own screen channel.
 */
export function createToolFactory(env: NodeJS.ProcessEnv = process.env): ((ctx: ToolContext) => Tool[]) | undefined {
  const enabled = (env.TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (enabled.length === 0) return undefined;
  const unknown = enabled.filter((t) => t !== "public_apis" && t !== "screen");
  if (unknown.length) throw new Error(`Unknown TOOLS entries: ${unknown.join(", ")} (known: public_apis, screen)`);
  let apis: { entries: import("./catalog.js").ApiEntry[]; keys: ReturnType<typeof loadKeys> } | undefined;
  if (enabled.includes("public_apis")) {
    const catalog = loadCatalog(env.PUBLIC_APIS_FILE ?? resolve(root, "data/public-apis.json"));
    const keys = loadKeys(env.API_KEYS_FILE ?? resolve(root, "data/api-keys.json"));
    apis = { entries: catalog.entries, keys };
    console.log(`[tools] public_apis enabled: ${catalog.entries.length} APIs, ${Object.keys(keys).length} host key(s) configured`);
  }
  if (enabled.includes("screen")) console.log("[tools] screen enabled: she can look at your screen only while you share it in the client");
  return (ctx) => [
    ...(apis ? createPublicApiTools({ entries: apis.entries, keys: apis.keys, log: (m) => console.log(`[tools] ${m}`) }) : []),
    ...(enabled.includes("screen") ? [createScreenTool(ctx)] : []),
  ];
}

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "./catalog.js";
import { createPublicApiTools, loadKeys } from "./public-apis.js";
import type { Tool } from "./types.js";

export type { Tool } from "./types.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Tools are OFF by default. Enable with TOOLS=public_apis (comma separated for future tools).
 * Returns a factory so every session gets its own tool state.
 */
export function createToolFactory(env: NodeJS.ProcessEnv = process.env): (() => Tool[]) | undefined {
  const enabled = (env.TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (enabled.length === 0) return undefined;
  const unknown = enabled.filter((t) => t !== "public_apis");
  if (unknown.length) throw new Error(`Unknown TOOLS entries: ${unknown.join(", ")} (known: public_apis)`);
  const catalog = loadCatalog(env.PUBLIC_APIS_FILE ?? resolve(root, "data/public-apis.json"));
  const keys = loadKeys(env.API_KEYS_FILE ?? resolve(root, "data/api-keys.json"));
  console.log(`[tools] public_apis enabled: ${catalog.entries.length} APIs, ${Object.keys(keys).length} host key(s) configured`);
  return () => createPublicApiTools({ entries: catalog.entries, keys, log: (m) => console.log(`[tools] ${m}`) });
}

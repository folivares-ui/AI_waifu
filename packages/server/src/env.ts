import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

/**
 * Loads the repo's .env (if present) before anything reads process.env. Variables already set in the shell win,
 * so `LLM_PROVIDER=mock npm start` still overrides the file. Empty values (`KEY=`) count as "not set", so each
 * provider keeps its own default. Imported first by index.ts.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function loadDotEnv(file = resolve(repoRoot, ".env")): boolean {
  if (!existsSync(file)) return false;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (v !== "" && process.env[k] === undefined) process.env[k] = v;
  }
  return true;
}

// Relative paths in .env (souls/..., data/...) mean "from the repo folder", wherever the server was started from.
process.chdir(repoRoot);
if (loadDotEnv()) console.log("[env] loaded .env");

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { appDir, userDir } from "./paths.js";

/**
 * Loads your .env (in the user folder: the repo, or the installed app's data folder) before anything reads
 * process.env. Variables already set in the shell win, so `LLM_PROVIDER=mock npm start` still overrides the file.
 * Empty values (`KEY=`) count as "not set", so each provider keeps its own default. Imported first by index.ts.
 */
export function loadDotEnv(file = join(userDir, ".env")): boolean {
  if (!existsSync(file)) return false;
  // Trailing spaces are removed first: Node's parser reads "KEY= " (space after =) as if the NEXT line were its
  // value, an easy accident when editing in Notepad.
  const text = readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n");
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (v !== "" && process.env[k] === undefined) process.env[k] = v;
  }
  return true;
}

/** Installed app, first run: start from a copy of .env.example the user can edit. */
export function ensureUserEnv(): string | undefined {
  const file = join(userDir, ".env");
  // The installer ships it as "env.example" (no leading dot).
  const example = [".env.example", "env.example"].map((f) => join(appDir, f)).find((f) => existsSync(f));
  if (userDir === appDir || existsSync(file) || !example) return undefined;
  copyFileSync(example, file);
  return file;
}

// Relative paths in .env (data/..., souls/...) mean "from the user folder", wherever the server was started from.
mkdirSync(userDir, { recursive: true });
process.chdir(userDir);
const created = ensureUserEnv();
if (created) console.log(`[env] created ${created} (edit it to choose her brain, voice and tools)`);
if (loadDotEnv()) console.log(`[env] loaded ${join(userDir, ".env")}`);

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Two places:
 * - appDir: the program's own files (web app, souls, .env.example). Read-only when installed (e.g. Program Files).
 * - userDir: her memory, your .env, logs, backups, browser profile. Must be writable.
 * From the repository both are the repository folder. The installed app sets WAIFU_APP_DIR and WAIFU_HOME.
 */
export const appDir = resolve(process.env.WAIFU_APP_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
export const userDir = resolve(process.env.WAIFU_HOME ?? appDir);

export const appPath = (...p: string[]) => join(appDir, ...p);
export const userPath = (...p: string[]) => join(userDir, ...p);

/** For files you may customise: your copy in userDir wins over the one shipped with the app. */
export function userOrApp(p: string): string {
  if (isAbsolute(p)) return p;
  const mine = userPath(p);
  return existsSync(mine) ? mine : appPath(p);
}

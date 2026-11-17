import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
const norm = (p: string) => (caseInsensitive ? p.toLowerCase() : p);

/**
 * The folders she may read and change. Every path is resolved through the real filesystem (symlinks, junctions,
 * "..") and must end up inside one of these roots, so a document cannot trick her into touching other files.
 */
export class Workspace {
  readonly roots: string[];

  constructor(
    roots: string[],
    private backupDir?: string,
  ) {
    if (roots.length === 0) throw new Error("No workspace folders configured (WORKSPACE_DIRS).");
    this.roots = roots.map((r) => {
      const abs = resolve(r);
      mkdirSync(abs, { recursive: true });
      return realpathSync(abs);
    });
  }

  private inside(real: string): boolean {
    return this.roots.some((root) => {
      const rel = relative(norm(root), norm(real));
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(sep));
    });
  }

  /**
   * Resolves a user/model supplied path (absolute, or relative to the first workspace folder).
   * For files that do not exist yet, the closest existing parent folder is checked instead.
   */
  resolve(p: string, opts: { mustExist?: boolean } = {}): string {
    if (typeof p !== "string" || !p.trim()) throw new Error("A file path is required.");
    if (p.includes("\0")) throw new Error("Invalid path.");
    const abs = isAbsolute(p) ? resolve(p) : resolve(this.roots[0], p);
    let real: string;
    if (existsSync(abs)) real = realpathSync(abs);
    else {
      if (opts.mustExist) throw new Error(`File not found: ${p}`);
      // Walk up to the nearest existing folder, resolve it, then re-append the missing part.
      let existing = dirname(abs);
      const missing = [basename(abs)];
      while (!existsSync(existing)) {
        missing.unshift(basename(existing));
        const up = dirname(existing);
        if (up === existing) break;
        existing = up;
      }
      real = join(realpathSync(existing), ...missing);
    }
    if (!this.inside(real)) {
      throw new Error(`"${p}" is outside the folders she is allowed to use (${this.roots.join(", ")}).`);
    }
    return real;
  }

  /** Shows paths to the user relative to their workspace folder when possible. */
  display(real: string): string {
    for (const root of this.roots) {
      const rel = relative(root, real);
      if (!rel.startsWith("..") && !isAbsolute(rel)) return this.roots.length > 1 ? `${basename(root)}/${rel}` : rel || ".";
    }
    return real;
  }

  list(dir = ".", maxEntries = 300): string {
    const real = this.resolve(dir, { mustExist: true });
    if (!statSync(real).isDirectory()) throw new Error(`Not a folder: ${dir}`);
    const entries = readdirSync(real, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .slice(0, maxEntries)
      .map((e) => {
        if (e.isDirectory()) return `[carpeta] ${e.name}/`;
        const st = statSync(join(real, e.name));
        return `${e.name}  (${Math.ceil(st.size / 1024)} KB, ${st.mtime.toISOString().slice(0, 16).replace("T", " ")})`;
      });
    return `${this.display(real)}:\n${entries.join("\n") || "(vacia)"}`;
  }

  /** Copies a file before it is modified. Returns the backup path. */
  backup(real: string): string | undefined {
    if (!existsSync(real) || !this.backupDir) return undefined;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dest = join(this.backupDir, stamp, basename(real));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(real, dest);
    return dest;
  }
}

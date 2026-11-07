import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One row of https://github.com/public-apis/public-apis (MIT license, (c) public-apis authors). */
export interface ApiEntry {
  id: number;
  name: string;
  url: string;
  description: string;
  /** "No", "apiKey", "OAuth", "X-Mashape-Key", "User-Agent" */
  auth: string;
  https: boolean;
  /** "Yes" | "No" | "Unknown" */
  cors: string;
  category: string;
}

export interface Catalog {
  source: string;
  fetchedAt: string;
  entries: ApiEntry[];
}

const LINK = /^\[(.+?)\]\((\S+?)\)$/;

/** Parses the repository README: `### Category` headings followed by `| [Name](url) | desc | Auth | HTTPS | CORS |` rows. */
export function parseReadme(md: string): ApiEntry[] {
  const out: ApiEntry[] = [];
  let category = "";
  for (const raw of md.split("\n")) {
    const h = raw.match(/^###\s+(.+?)\s*$/);
    if (h) {
      category = h[1];
      continue;
    }
    if (!raw.startsWith("| [")) continue;
    const cells = raw.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.length !== 5) continue;
    const link = cells[0].match(LINK);
    if (!link) continue;
    const auth = cells[2].replace(/`/g, "");
    if (/[<\[]/.test(auth)) continue; // sponsored rows use images/links instead of the Auth value
    out.push({
      id: out.length,
      name: link[1],
      url: link[2],
      description: cells[1],
      auth,
      https: cells[3].toLowerCase() === "yes",
      cors: cells[4],
      category,
    });
  }
  return out;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
const tokens = (s: string) => norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 1);

export interface SearchOptions {
  query: string;
  category?: string;
  auth?: string;
  limit?: number;
}

/** Keyword ranking over name (x5), category (x3) and description (x1). */
export function searchCatalog(entries: ApiEntry[], o: SearchOptions): ApiEntry[] {
  const q = tokens(o.query);
  const cat = o.category ? norm(o.category) : undefined;
  const auth = o.auth ? norm(o.auth) : undefined;
  const scored: { e: ApiEntry; score: number }[] = [];
  for (const e of entries) {
    if (cat && !norm(e.category).includes(cat)) continue;
    if (auth && norm(e.auth) !== auth) continue;
    const name = norm(e.name);
    const category = norm(e.category);
    const desc = norm(e.description);
    let score = 0;
    for (const t of q) {
      if (name.includes(t)) score += 5;
      if (category.includes(t)) score += 3;
      if (desc.includes(t)) score += 1;
    }
    if (q.length === 0 || score > 0) scored.push({ e, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.e.id - b.e.id).slice(0, o.limit ?? 8).map((s) => s.e);
}

export function categories(entries: ApiEntry[]): string[] {
  return [...new Set(entries.map((e) => e.category))];
}

export function saveCatalog(path: string, cat: Catalog) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cat));
}

export function loadCatalog(path: string): Catalog {
  if (!existsSync(path)) {
    throw new Error(`Catalog not found at ${path}. Run: npm run apis:update -w @waifu/server`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Catalog;
}

import { existsSync, readFileSync } from "node:fs";
import { searchCatalog, type ApiEntry } from "./catalog.js";
import { htmlToText, safeGet, type SafeGetOptions } from "./safe-fetch.js";
import { untrusted, type Tool } from "./types.js";

/** Per-host credentials kept on the server; the model never sees them. */
export type KeyConfig = Record<string, { header?: string; query?: string; bearer?: string; value?: string }>;

export function loadKeys(path: string): KeyConfig {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as KeyConfig) : {};
}

const MAX_OUT = 6000;
const clip = (s: string, n = MAX_OUT) => (s.length > n ? s.slice(0, n) + `\n...[truncated, ${s.length - n} more chars]` : s);

/** "api.foo.co.uk" -> "foo.co.uk" (small suffix list; good enough to relate docs and API hosts). */
export function baseDomain(host: string): string {
  const parts = host.split(".");
  const second = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
  const keep = parts.length >= 3 && second.has(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-keep).join(".");
}

export interface PublicApisOptions {
  entries: ApiEntry[];
  keys?: KeyConfig;
  /** Test hooks. */
  fetchOpts?: Partial<SafeGetOptions>;
  log?: (msg: string) => void;
}

/**
 * Tools over the public-apis catalog. Create ONE instance per session: it remembers which hosts the model
 * legitimately learned about (catalog + documentation it read) and only lets it call those.
 */
export function createPublicApiTools(o: PublicApisOptions): Tool[] {
  const log = o.log ?? (() => {});
  const known = new Set<string>(); // base domains
  for (const e of o.entries) {
    try {
      known.add(baseDomain(new URL(e.url).hostname));
    } catch {
      /* ignore malformed catalog rows */
    }
  }
  const learned = new Set<string>(); // base domains seen in documentation the model read
  const hostAllowed = (host: string) => known.has(baseDomain(host)) || learned.has(baseDomain(host));

  const keyFor = (url: URL): { headers: Record<string, string>; url: URL } => {
    const k = o.keys?.[url.hostname] ?? o.keys?.[baseDomain(url.hostname)];
    const headers: Record<string, string> = {};
    if (!k) return { headers, url };
    if (k.bearer) headers.authorization = `Bearer ${k.bearer}`;
    if (k.header && k.value) headers[k.header] = k.value;
    if (k.query && k.value) url.searchParams.set(k.query, k.value);
    return { headers, url };
  };

  const search: Tool = {
    def: {
      name: "search_apis",
      description:
        "Search a catalog of ~2000 free public web APIs (weather, animals, books, games, finance, science, etc.). " +
        "Use ENGLISH keywords. Prefer entries with auth=No (usable immediately). Returns name, category, description, auth, doc URL.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "English keywords, e.g. 'cat facts' or 'currency exchange'" },
          category: { type: "string", description: "Optional category filter, e.g. 'Animals'" },
          auth: { type: "string", enum: ["No", "apiKey", "OAuth"], description: "Optional auth filter" },
          limit: { type: "integer", minimum: 1, maximum: 15 },
        },
        required: ["query"],
      },
    },
    async run(input) {
      const i = input as { query?: string; category?: string; auth?: string; limit?: number };
      if (!i?.query) throw new Error("query is required");
      const hits = searchCatalog(o.entries, { query: i.query, category: i.category, auth: i.auth, limit: Math.min(i.limit ?? 8, 15) });
      if (hits.length === 0) return "No APIs matched. Try different or broader English keywords.";
      return hits.map((e) => `- ${e.name} [${e.category}] auth=${e.auth} https=${e.https ? "yes" : "no"} :: ${e.description} :: docs ${e.url}`).join("\n");
    },
  };

  const readDocs: Tool = {
    def: {
      name: "read_api_docs",
      description:
        "Fetch the documentation page of an API found with search_apis (use its docs URL) and return its text, so you can learn the exact endpoints and parameters before calling it.",
      input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    async run(input, signal) {
      const url = (input as { url?: string })?.url;
      if (!url) throw new Error("url is required");
      log(`read_api_docs ${url}`);
      const r = await safeGet(url, { hostAllowed, signal, ...o.fetchOpts });
      const text = /html/i.test(r.contentType) ? htmlToText(r.body) : r.body;
      // Hosts mentioned in the docs (e.g. the real API base URL) become callable.
      for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) learned.add(baseDomain(m[1].toLowerCase()));
      return untrusted(r.finalUrl, `HTTP ${r.status}\n${clip(text)}`);
    },
  };

  const call: Tool = {
    def: {
      name: "call_api",
      description:
        "Make a read-only HTTP GET request to a public API endpoint (full https URL, e.g. built from the base URL in its docs). " +
        "Only for APIs from the catalog or ones whose docs you read. APIs that need a key only work if the user configured one.",
      input_schema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full https URL of the endpoint" },
          query: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] }, description: "Query-string parameters" },
        },
        required: ["url"],
      },
    },
    async run(input, signal) {
      const i = input as { url?: string; query?: Record<string, string | number | boolean> };
      if (!i?.url) throw new Error("url is required");
      const target = new URL(i.url);
      for (const [k, v] of Object.entries(i.query ?? {})) target.searchParams.set(k, String(v));
      const { headers, url } = keyFor(target);
      log(`call_api GET ${url.origin}${url.pathname}`); // never log query strings (may hold keys)
      const r = await safeGet(url.toString(), { headers, hostAllowed, signal, ...o.fetchOpts });
      let body = r.body;
      if (/json/i.test(r.contentType)) {
        try {
          body = JSON.stringify(JSON.parse(r.body), null, 1);
        } catch {
          /* keep raw */
        }
      }
      const hint = r.status === 401 || r.status === 403 ? "\n(This API probably needs an API key, which the user has not configured.)" : "";
      return untrusted(`${url.origin}${url.pathname}`, `HTTP ${r.status}${r.truncated ? " (response truncated)" : ""}\n${clip(body)}${hint}`);
    },
  };

  return [search, readDocs, call];
}

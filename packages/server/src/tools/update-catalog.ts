// Downloads the public-apis README and builds data/public-apis.json:  npm run apis:update -w @waifu/server
import { parseReadme, saveCatalog, categories } from "./catalog.js";

import { userPath } from "../paths.js";
const source = "https://raw.githubusercontent.com/public-apis/public-apis/master/README.md";
const res = await fetch(source);
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
const entries = parseReadme(await res.text());
if (entries.length < 500) throw new Error(`Parsed only ${entries.length} entries; the README format may have changed.`);
const out = process.env.PUBLIC_APIS_FILE ?? userPath("data/public-apis.json");
saveCatalog(out, { source, fetchedAt: new Date().toISOString(), entries });
const free = entries.filter((e) => e.auth === "No").length;
console.log(`Saved ${entries.length} APIs (${free} need no key) in ${categories(entries).length} categories -> ${out}`);

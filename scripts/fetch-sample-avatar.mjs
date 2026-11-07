// Downloads a sample anime-style VRM model into the web app.  Usage:
//   npm run avatar:sample                      (default: victoria-rubin)
//   npm run avatar:sample -- --model vita
//   npm run avatar:sample -- --list
// To use YOUR OWN character, just copy your .vrm to apps/web/public/avatars/default.vrm instead.
//
// Licenses: the "vroid-beta" models below declare CC0 in their embedded VRM metadata (checked when this script
// was written) and are described as CC0 in the madjin/vrm-samples README. "seed-san" requires credit to
// VirtualCast, Inc.; "twist" is (c) pixiv Inc. with redistribution allowed. Always re-check the license
// embedded in the file you end up using.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const M = "https://raw.githubusercontent.com/madjin/vrm-samples/master";
const CATALOG = {
  "victoria-rubin": { url: `${M}/vroid/beta/Victoria_Rubin.vrm`, note: "blonde idol style, CC0 (VRM0)" },
  vita: { url: `${M}/vroid/beta/Vita.vrm`, note: "white hair, sci-fi outfit, CC0 (VRM0)" },
  vivi: { url: `${M}/vroid/beta/Vivi.vrm`, note: "brown hair, cute dress, CC0 (VRM0)" },
  "sendagaya-shino": { url: `${M}/vroid/beta/Sendagaya_Shino.vrm`, note: "dark hair, school uniform, CC0 (VRM0)" },
  "hair-sample-female": { url: `${M}/vroid/beta/HairSample_Female.vrm`, note: "cat ears, CC0 (VRM0)" },
  "seed-san": { url: `${M}/Seed-san/vrm/Seed-san.vrm`, note: "VRM 1.0, credit to VirtualCast, Inc. required" },
  twist: {
    url: "https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm",
    note: "plain white t-shirt, VRM 1.0, (c) pixiv Inc.",
  },
};

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const [k, v] of Object.entries(CATALOG)) console.log(`${k.padEnd(20)} ${v.note}`);
  process.exit(0);
}
const name = args.includes("--model") ? args[args.indexOf("--model") + 1] : "victoria-rubin";
const entry = CATALOG[name];
if (!entry) {
  console.error(`Unknown model "${name}". Use --list.`);
  process.exit(1);
}
const dest = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/web/public/avatars/default.vrm");
if (existsSync(dest) && !args.includes("--force") && !args.includes("--model")) {
  console.log(`Already present: ${dest} (pass --model <name> or --force to replace)`);
  process.exit(0);
}
const res = await fetch(entry.url);
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
if (buf.subarray(0, 4).toString() !== "glTF") throw new Error("Downloaded file is not a GLB/VRM");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, buf);
console.log(`Saved "${name}" (${(buf.length / 1e6).toFixed(1)} MB) to ${dest}`);

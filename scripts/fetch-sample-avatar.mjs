// Downloads pixiv's sample anime-style VRM model (VRM1_Constraint_Twist_Sample) into the web app.
// Its embedded VRM license metadata at download time: redistribution + modification allowed, credit unnecessary,
// (c) 2022 pixiv Inc. -- check the license inside the file yourself (https://vrm.dev/licenses/1.0/) before relying on it.
// To use YOUR OWN character, just copy your .vrm to apps/web/public/avatars/default.vrm instead.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const URL_ =
  "https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm";
const dest = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/web/public/avatars/default.vrm");

if (existsSync(dest) && !process.argv.includes("--force")) {
  console.log(`Already present: ${dest} (use --force to replace)`);
  process.exit(0);
}
const res = await fetch(URL_);
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
const buf = Buffer.from(await res.arrayBuffer());
if (buf.subarray(0, 4).toString() !== "glTF") throw new Error("Downloaded file is not a GLB/VRM");
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, buf);
console.log(`Saved ${(buf.length / 1e6).toFixed(1)} MB to ${dest}`);

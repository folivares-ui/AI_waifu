// Prepares everything the standalone desktop installer contains, in apps/desktop/src-tauri/standalone/app/:
//   node/node(.exe)          Node.js runtime downloaded from nodejs.org (SHA-256 checked against SHASUMS256.txt)
//   server/index.mjs         the server bundled into one file (no TypeScript, no npm install needed)
//   server/node_modules/playwright-core   (kept as-is: it loads its own files at runtime)
//   apps/web/dist/           the built web app (run `npm run build` first)
//   souls/, env.example, data/public-apis.json (if built)
// Your .env, memory, logs and voice clips are NEVER copied: the installed app keeps those in its own data folder.
//
//   node scripts/bundle-app.mjs [--target win-x64|linux-x64|darwin-arm64|darwin-x64] [--node v22.x.y]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const hostTarget = `${{ win32: "win", darwin: "darwin", linux: "linux" }[process.platform]}-${process.arch}`;
const target = opt("target", hostTarget);
const nodeVersion = opt("node", process.version);
const out = join(root, "apps/desktop/src-tauri/standalone/app");
const step = (m) => console.log(`[bundle] ${m}`);

const webIndex = join(root, "apps/web/dist/index.html");
if (!existsSync(webIndex)) throw new Error("apps/web/dist is missing: run `npm run build` first.");

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "server"), { recursive: true });

// 1. Server -> one ESM file. CommonJS dependencies inside it still get `require`, `__dirname` and `__filename`.
step("bundling the server");
const esbuild = await import("esbuild");
await esbuild.build({
  entryPoints: [join(root, "packages/server/src/index.ts")],
  outfile: join(out, "server/index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["playwright-core"],
  logLevel: "warning",
  banner: {
    js: [
      'import { createRequire as __cr } from "node:module";',
      'import { fileURLToPath as __fu } from "node:url";',
      'import { dirname as __dn, join as __jn } from "node:path";',
      "const require = __cr(import.meta.url);",
      "const __filename = __fu(import.meta.url);",
      "const __dirname = __dn(__filename);",
      // The program's files are one folder up from server/ (the desktop app also sets this explicitly).
      "process.env.WAIFU_APP_DIR ??= __jn(__dirname, '..');",
    ].join("\n"),
  },
});
cpSync(join(root, "node_modules/playwright-core"), join(out, "server/node_modules/playwright-core"), { recursive: true });

// 2. Web app, souls, example settings, API catalog.
step("copying the web app and souls");
cpSync(join(root, "apps/web/dist"), join(out, "apps/web/dist"), { recursive: true });
mkdirSync(join(out, "souls"));
for (const f of readdirSync(join(root, "souls")).filter((f) => f.endsWith(".soul.json"))) cpSync(join(root, "souls", f), join(out, "souls", f));
// No leading dot: installers and globs may skip hidden files.
cpSync(join(root, ".env.example"), join(out, "env.example"));
if (existsSync(join(root, "data/public-apis.json"))) {
  mkdirSync(join(out, "data"));
  cpSync(join(root, "data/public-apis.json"), join(out, "data/public-apis.json"));
}

// 3. Node.js runtime for the target system.
step(`downloading Node.js ${nodeVersion} for ${target}`);
const base = `https://nodejs.org/dist/${nodeVersion}`;
const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  return Buffer.from(await res.arrayBuffer());
};
const sums = (await get(`${base}/SHASUMS256.txt`)).toString("utf8");
const expectSha = (name, buf) => {
  const line = sums.split("\n").find((l) => l.trim().endsWith(`  ${name}`));
  if (!line) throw new Error(`${name} is not listed in SHASUMS256.txt for ${nodeVersion}`);
  const got = createHash("sha256").update(buf).digest("hex");
  if (got !== line.split(/\s+/)[0]) throw new Error(`Checksum mismatch for ${name}: refusing to use it.`);
};
mkdirSync(join(out, "node"));
if (target.startsWith("win")) {
  const name = `${target}/node.exe`;
  const exe = await get(`${base}/${name}`);
  expectSha(name, exe);
  writeFileSync(join(out, "node/node.exe"), exe);
} else {
  const ext = target.startsWith("linux") ? "tar.xz" : "tar.gz";
  const name = `node-${nodeVersion}-${target}.${ext}`;
  const tgz = await get(`${base}/${name}`);
  expectSha(name, tgz);
  const tmp = mkdtempSync(join(tmpdir(), "node-"));
  writeFileSync(join(tmp, name), tgz);
  execFileSync("tar", ["-xf", join(tmp, name), "-C", tmp]);
  cpSync(join(tmp, `node-${nodeVersion}-${target}`, "bin/node"), join(out, "node/node"));
  chmodSync(join(out, "node/node"), 0o755);
  rmSync(tmp, { recursive: true, force: true });
}
step(`ready: ${out}`);

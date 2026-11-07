// Builds the app icons (PWA + desktop) from the face of the current avatar (apps/web/public/avatars/default.vrm).
//   1. start the web app, e.g. `npm run dev:web`   (or the server with a built web)
//   2. node scripts/make-icons.mjs [url]           default url: http://localhost:5173
//   3. (desktop) cd apps/desktop && npx tauri icon ../web/public/icons/icon-1024.png
// Needs Playwright with Chromium available (it renders the 3D model in a headless browser).
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const url = process.argv[2] ?? "http://localhost:5173";
const out = resolve(dirname(fileURLToPath(import.meta.url)), "../apps/web/public/icons");

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const req = createRequire(import.meta.url);
    const paths = [process.cwd(), ...(process.env.NODE_PATH ?? "").split(":").filter(Boolean)];
    try {
      return req(req.resolve("playwright", { paths }));
    } catch {
      throw new Error("Playwright is required: npm i -D playwright && npx playwright install chromium");
    }
  }
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 1100 }, deviceScaleFactor: 1 });
await page.goto(`${url}/?capture=face`);
await page.waitForSelector(".vrm canvas", { timeout: 60000 });
await page.waitForTimeout(4000); // let the model, pose and a neutral expression settle
const face = await page.locator(".vrm").screenshot({ omitBackground: true });

// Compose: app-palette rounded square (or full-bleed for maskable) + the face, drawn in a blank page.
const composer = await browser.newPage();
const sheets = await composer.evaluate(async (faceB64) => {
  const img = new Image();
  img.src = `data:image/png;base64,${faceB64}`;
  await img.decode();
  const draw = (size, maskable) => {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, 0, size);
    g.addColorStop(0, "#3a2f7a");
    g.addColorStop(1, "#17132b");
    x.fillStyle = g;
    if (maskable) x.fillRect(0, 0, size, size);
    else {
      x.beginPath();
      x.roundRect(0, 0, size, size, size * 0.2);
      x.fill();
      x.clip(); // keep the face inside the rounded corners
    }
    // Maskable icons are cropped by the OS (often to a circle): keep the face inside the central safe zone and let
    // the shoulders run off the bottom edge instead of ending in a visible cut.
    const s = size * (maskable ? 0.8 : 1.0);
    x.drawImage(img, (size - s) / 2, maskable ? size - s + size * 0.02 : (size - s) / 2, s, s);
    return c.toDataURL("image/png").split(",")[1];
  };
  return { 1024: draw(1024, false), 512: draw(512, false), 192: draw(192, false), 180: draw(180, false), m512: draw(512, true) };
}, face.toString("base64"));
await browser.close();

mkdirSync(out, { recursive: true });
const w = (name, b64) => writeFileSync(resolve(out, name), Buffer.from(b64, "base64"));
w("icon-1024.png", sheets[1024]);
w("icon-512.png", sheets[512]);
w("icon-192.png", sheets[192]);
w("apple-touch-icon.png", sheets[180]);
w("icon-maskable-512.png", sheets.m512);
console.log(`Icons written to ${out}`);

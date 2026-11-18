// Puts the hand-gesture model and MediaPipe's WebAssembly runtime inside the web app, so camera gestures work
// offline and the camera images never leave the device.   npm run setup:gestures
// Model: MediaPipe Gesture Recognizer (Apache-2.0), https://ai.google.dev/edge/mediapipe/solutions/vision/gesture_recognizer
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pub = resolve(root, "apps/web/public");
const model = resolve(pub, "models/gesture_recognizer.task");
const wasmSrc = resolve(root, "node_modules/@mediapipe/tasks-vision/wasm");
const wasmDst = resolve(pub, "mediapipe/wasm");
const quiet = process.argv.includes("--quiet");
const URL_ = "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task";

try {
  if (existsSync(wasmSrc)) {
    mkdirSync(wasmDst, { recursive: true });
    cpSync(wasmSrc, wasmDst, { recursive: true });
  } else throw new Error("@mediapipe/tasks-vision is not installed (run npm install)");
  if (!existsSync(model)) {
    const res = await fetch(URL_);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(model), { recursive: true });
    writeFileSync(model, buf);
    console.log(`Gesture model saved (${(buf.length / 1e6).toFixed(1)} MB).`);
  } else if (!quiet) console.log("Gesture model already present.");
} catch (e) {
  // Never break the build: the camera button will explain what is missing.
  console.warn(`[gestures] not set up: ${e instanceof Error ? e.message : e}. Camera gestures will be unavailable.`);
}

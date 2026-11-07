// Quick check of your TTS configuration:  npm run tts:test -w @waifu/server -- "Hola, soy tu companera"
// Reads the same TTS_* variables as the server, writes the audio to data/tts-test.<ext> so you can listen to it.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSoul } from "./soul.js";
import { createTTS } from "./tts/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tts = createTTS();
if (!tts) {
  console.error("TTS_PROVIDER is not set (or is 'none'). See .env.example.");
  process.exit(1);
}
const soul = loadSoul(process.env.SOUL_FILE ?? resolve(root, "souls/default.soul.json"));
const text = process.argv.slice(2).join(" ") || "Hola, soy tu companera. Esta es una prueba de mi voz.";
const t0 = Date.now();
const { audio, mime } = await tts.synthesize(text, { voice: soul.voice.ttsVoice, lang: soul.voice.lang });
const ext = mime.includes("mpeg") ? "mp3" : mime.includes("wav") ? "wav" : mime.split("/")[1] ?? "bin";
const out = resolve(root, `data/tts-test.${ext}`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, audio);
console.log(`OK ${tts.name}: ${audio.length} bytes ${mime} in ${Date.now() - t0} ms -> ${out}`);

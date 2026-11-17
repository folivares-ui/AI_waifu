// Creates (or lists) a cloned voice in VoiceStudio running on this computer.
//   npm run voice:create -- --file data/voices/rice-shower/rice-ref-2.wav --name "Rice Shower"
//   npm run voice:create -- --list
// Options: --url http://localhost:3900  --text "transcript of the clip" (optional; VoiceStudio can transcribe it)
// Then use the voice with TTS_PROVIDER=voicestudio and "ttsVoice": "<name>" in souls/default.soul.json.
// Only clone voices you are allowed to use; keep cloned voices private.
import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const url = (opt("url", process.env.VOICESTUDIO_URL ?? "http://localhost:3900")).replace(/\/$/, "");

async function call(path, init) {
  let res;
  try {
    res = await fetch(url + path, init);
  } catch {
    throw new Error(`Cannot reach VoiceStudio at ${url}: open the VoiceStudio app first.`);
  }
  const body = await res.text();
  if (!res.ok) throw new Error(`VoiceStudio ${res.status}: ${body.slice(0, 400)}`);
  return JSON.parse(body);
}

if (args.includes("--list")) {
  const list = await call("/profiles");
  for (const p of list) console.log(`${p.id}  ${p.name}  (${p.kind ?? "clone"}, ${p.language ?? "Auto"})`);
  if (!list.length) console.log("(no saved voices)");
  process.exit(0);
}

const file = opt("file");
const name = opt("name", "Rice Shower");
if (!file || !existsSync(file)) {
  console.error("Usage: npm run voice:create -- --file <reference.wav> [--name \"Rice Shower\"] [--text \"...\"]");
  process.exit(1);
}
const existing = (await call("/profiles")).find((p) => String(p.name).toLowerCase() === name.toLowerCase());
if (existing) {
  console.log(`A voice named "${name}" already exists (id ${existing.id}). Delete or rename it in VoiceStudio to recreate it.`);
  process.exit(0);
}
const form = new FormData();
form.append("name", name);
form.append("kind", "clone");
form.append("language", opt("language", "Auto"));
form.append("ref_text", opt("text", ""));
form.append("ref_audio", new Blob([readFileSync(file)], { type: "audio/wav" }), basename(file));
const profile = await call("/profiles", { method: "POST", body: form });
console.log(`Created voice "${profile.name}" (id ${profile.id}).`);
console.log(`Set "ttsVoice": "${profile.name}" in souls/default.soul.json and start the server with TTS_PROVIDER=voicestudio.`);

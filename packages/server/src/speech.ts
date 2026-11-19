import { complete, type LLMProvider } from "./llm/index.js";
import type { Soul } from "./soul.js";

const LANG_NAMES: Record<string, string> = { ja: "Japanese", en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", ko: "Korean", zh: "Chinese" };

/** The language she speaks aloud: the user's choice in the app > SPEECH_LANG (env) > soul.voice.speechLang > the text language. */
export function speechLangOf(soul: Soul, chosen?: string, env: NodeJS.ProcessEnv = process.env): string {
  return chosen || env.SPEECH_LANG?.trim() || soul.voice.speechLang || soul.voice.lang;
}

/** True when what she says aloud is in another language than what is shown (subtitles). */
export function needsSpeechTranslation(soul: Soul, lang: string): boolean {
  return lang.slice(0, 2).toLowerCase() !== soul.voice.lang.slice(0, 2).toLowerCase();
}

/** Accepts "ja", "ja-JP", "es-419"... */
export const validLang = (l: unknown): l is string => typeof l === "string" && /^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/.test(l);

/**
 * Translates one of her lines into the spoken language, in character (e.g. Japanese with Rice's way of talking).
 * The text shown on screen stays in the original language, like subtitles.
 */
export async function translateForSpeech(llm: LLMProvider, soul: Soul, text: string, lang: string, signal?: AbortSignal, growthNote?: string): Promise<string> {
  const code = lang.slice(0, 2).toLowerCase();
  const name = LANG_NAMES[code] ?? lang;
  const ask = async (strict: boolean) => {
    const system = [
      "TRANSLATE_FOR_SPEECH",
      `Translate the line spoken by ${soul.name} into natural, spoken ${name}, as she would say it aloud.`,
      soul.voice.speechStyle ? `Her way of speaking: ${soul.voice.speechStyle}` : "",
      growthNote ? `She has grown since then, so adapt that style to her current personality (e.g. fewer hesitations if she is more confident): ${growthNote}` : "",
      "Keep the meaning, tone and names. Output ONLY the translation: no quotes, no romanization, no notes, no explanations.",
      strict ? `Your previous answer was not in ${name}. Every word must be in ${name}${code === "ja" ? " (kana/kanji; Spanish or romaji words such as \"arigatou\" or \"Onii-sama\" must be written in Japanese: ありがとう, お兄さま)" : ""}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const out = (await complete(llm, { system, messages: [{ role: "user", content: text }], signal, maxTokens: 300 })).trim();
    return cleanTranslation(out);
  };
  let out = await ask(false);
  if (!looksLike(out, code)) out = await ask(true);
  if (!looksLike(out, code)) throw new Error(`the translation is not in ${name}: ${out.slice(0, 80)}`);
  return out;
}

/** Removes quotes and stray emotion tags the model may add. */
export function cleanTranslation(s: string): string {
  return s
    .replace(/\[[a-z_]+:[^\]]*\]/gi, "")
    .trim()
    .replace(/^["“「『]+|["”」』]+$/g, "")
    .trim();
}

/** Is this really in the target language? (Only checkable for scripts like Japanese; others are trusted.) */
export function looksLike(raw: string, code: string): boolean {
  const s = cleanTranslation(raw);
  if (!s) return false;
  if (code !== "ja") return true;
  const jp = (s.match(/[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/g) ?? []).length;
  const latin = (s.match(/[A-Za-zÀ-ÿ]/g) ?? []).length;
  return jp > 0 && jp >= latin;
}

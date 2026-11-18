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
export async function translateForSpeech(llm: LLMProvider, soul: Soul, text: string, lang: string, signal?: AbortSignal): Promise<string> {
  const name = LANG_NAMES[lang.slice(0, 2).toLowerCase()] ?? lang;
  const system = [
    "TRANSLATE_FOR_SPEECH",
    `Translate the line spoken by ${soul.name} into natural, spoken ${name}, as she would say it aloud.`,
    soul.voice.speechStyle ? `Her way of speaking: ${soul.voice.speechStyle}` : "",
    "Keep the meaning, tone and names. Output ONLY the translation: no quotes, no romanization, no notes, no explanations.",
  ]
    .filter(Boolean)
    .join("\n");
  const out = (await complete(llm, { system, messages: [{ role: "user", content: text }], signal, maxTokens: 300 })).trim();
  if (!out) throw new Error("empty translation");
  return out.replace(/^["“「『]|["”」』]$/g, "").trim();
}

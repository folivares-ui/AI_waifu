/** Cleans LLM text so a TTS engine reads it naturally (no markdown, emoji, URLs or *stage directions*). */
export function prepareForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1") // **bold** keeps its words
    .replace(/\*[^*\n]{1,60}\*/g, " ") // *sonrie* is an action, not speech
    .replace(/https?:\/\/\S+/g, "enlace")
    .replace(/[`*_#>~|]+/g, "")
    .replace(/\p{Extended_Pictographic}|️|‍/gu, "")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\.{2,}\s*\./g, "...")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1") // "Dos ." (after an emoji was removed) -> "Dos."
    .trim();
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

/**
 * Guards against the soul "hearing herself": true when a transcript mostly consists of
 * words she said recently. Only used on utterances captured while/just after she spoke.
 */
export function looksLikeEcho(transcript: string, recentSpoken: string[]): boolean {
  const t = words(transcript);
  if (t.length === 0) return true;
  const spoken = new Set(recentSpoken.flatMap(words));
  const hits = t.filter((w) => spoken.has(w)).length;
  return hits / t.length >= 0.7;
}

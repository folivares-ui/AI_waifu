import { readFileSync } from "node:fs";
import { EMOTIONS, type VoiceHints } from "@waifu/core";

export interface Soul {
  name: string;
  language: string;
  voice: VoiceHints;
  persona: string;
  boundaries: string;
}

export function loadSoul(path: string): Soul {
  const s = JSON.parse(readFileSync(path, "utf8")) as Partial<Soul>;
  if (!s.name || !s.persona) throw new Error(`Soul file ${path} needs at least "name" and "persona"`);
  return {
    name: s.name,
    language: s.language ?? "en-US",
    voice: s.voice ?? { lang: s.language ?? "en-US", pitch: 1, rate: 1 },
    persona: s.persona,
    boundaries: s.boundaries ?? "",
  };
}

export function buildSystemPrompt(soul: Soul, memories: string[]): string {
  const mem = memories.length
    ? `\nThings you remember about the user and past conversations:\n${memories.map((m) => `- ${m}`).join("\n")}\n`
    : "";
  return [
    soul.persona,
    soul.boundaries,
    `Your name is ${soul.name}. Reply in the user's language (default: ${soul.language}).`,
    `Before each sentence whose mood changes you may put a tag like [emotion:happy]. Allowed emotions: ${EMOTIONS.join(", ")}. Tags are never spoken aloud.`,
    "Keep replies short (1-3 sentences) unless asked for detail, because they are spoken aloud.",
    mem,
  ]
    .filter(Boolean)
    .join("\n");
}

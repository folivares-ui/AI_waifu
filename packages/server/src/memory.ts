import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { complete, type LLMProvider } from "./llm/index.js";

export interface MemoryItem {
  text: string;
  createdAt: string;
}

const tokenize = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );

/**
 * Long-term memory stored as a local JSON file you own.
 * Retrieval is keyword overlap (good enough for an MVP; swap for embeddings later).
 */
export class MemoryStore {
  private items: MemoryItem[] = [];

  constructor(private path: string) {
    if (existsSync(path)) this.items = JSON.parse(readFileSync(path, "utf8")) as MemoryItem[];
  }

  get size() {
    return this.items.length;
  }

  add(text: string) {
    const t = text.trim();
    if (!t || this.items.some((i) => i.text.toLowerCase() === t.toLowerCase())) return;
    this.items.push({ text: t, createdAt: new Date().toISOString() });
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.items, null, 2));
  }

  recall(query: string, limit = 6): string[] {
    const q = tokenize(query);
    const scored = this.items.map((it, idx) => {
      const overlap = [...tokenize(it.text)].filter((w) => q.has(w)).length;
      return { it, score: overlap * 10 + idx / this.items.length }; // tie-break: newer first
    });
    return scored
      .filter((s) => s.score >= 10)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.it.text);
  }
}

const EXTRACT_SYSTEM =
  "You extract durable facts worth remembering long-term about the USER (name, preferences, projects, goals, important events). " +
  "Ignore small talk. Return ONLY a JSON array of short strings in the user's language; return [] if nothing is worth remembering.";

/** Best-effort: asks the LLM for facts to keep. Never throws. */
export async function extractFacts(llm: LLMProvider, userText: string, reply: string): Promise<string[]> {
  try {
    const raw = await complete(llm, {
      system: EXTRACT_SYSTEM,
      messages: [{ role: "user", content: `User said: ${userText}\nAssistant replied: ${reply}` }],
      maxTokens: 300,
    });
    const json = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
    const arr = JSON.parse(json) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { complete, type LLMProvider } from "./llm/index.js";

/**
 * Personality growth: a few traits per character (e.g. Rice's confidence) with a level from 0 to 100 that
 * changes slowly with how you treat her over many conversations. The level shapes how she talks.
 */
export interface Trait {
  id: string;
  /** Shown in the app, e.g. "Confianza en si misma". */
  name: string;
  /** Level when you first meet her (0-100). */
  start: number;
  /** How she is at 0. */
  low: string;
  /** How she is at 100. */
  high: string;
  /** Shown when she grows past a milestone, e.g. "se siente un poco mas segura". */
  up?: string;
  down?: string;
}

/** For characters that do not define their own. */
export const DEFAULT_TRAITS: Trait[] = [
  {
    id: "confianza",
    name: "Confianza en si misma",
    start: 40,
    low: "you doubt yourself, hesitate and apologise often",
    high: "you are calm and sure of yourself, with hardly any hesitation, while staying fully in character",
    up: "se siente un poco mas segura",
    down: "esta algo mas insegura",
  },
  {
    id: "cercania",
    name: "Cercania contigo",
    start: 30,
    low: "you are polite but a little distant and formal with your owner",
    high: "you are very close and affectionate with your owner, at ease sharing your feelings and joking a little",
    up: "se siente mas cercana a ti",
    down: "esta un poco mas distante",
  },
];

/** Change limits: growth is gradual and needs many conversations, never one sentence. */
export const MAX_STEP = 2;
export const MAX_PER_DAY = 6;

interface State {
  levels: Record<string, number>;
  /** Net change today per trait (for the daily limit). */
  day: string;
  today: Record<string, number>;
  history: { at: string; trait: string; delta: number; reason: string }[];
}

export interface Change {
  trait: string;
  delta: number;
  reason: string;
}

export class Growth {
  private state: State;

  constructor(
    private file: string,
    readonly traits: Trait[],
    private now: () => Date = () => new Date(),
  ) {
    const fresh: State = { levels: {}, day: "", today: {}, history: [] };
    try {
      this.state = existsSync(file) ? { ...fresh, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<State>) } : fresh;
    } catch {
      this.state = fresh;
    }
  }

  level(id: string): number {
    const t = this.traits.find((x) => x.id === id);
    return Math.round(this.state.levels[id] ?? t?.start ?? 50);
  }

  /** Levels and recent changes, for the app. */
  snapshot() {
    return {
      traits: this.traits.map((t) => ({ id: t.id, name: t.name, level: this.level(t.id), start: t.start })),
      recent: this.state.history.slice(-8).reverse(),
    };
  }

  /**
   * Applies the evaluated changes within the limits. Returns the milestones crossed (every 25 points) so the app
   * can say e.g. "Rice se siente un poco mas segura".
   */
  apply(changes: Change[]): { trait: Trait; up: boolean; level: number }[] {
    const day = this.now().toISOString().slice(0, 10);
    if (this.state.day !== day) {
      this.state.day = day;
      this.state.today = {};
    }
    const crossed: { trait: Trait; up: boolean; level: number }[] = [];
    let changed = false;
    for (const c of changes) {
      const t = this.traits.find((x) => x.id === c.trait);
      if (!t || !Number.isFinite(c.delta)) continue;
      let d = Math.max(-MAX_STEP, Math.min(MAX_STEP, Math.round(c.delta)));
      const today = this.state.today[t.id] ?? 0;
      d = Math.max(-MAX_PER_DAY - today, Math.min(MAX_PER_DAY - today, d));
      const before = this.level(t.id);
      const after = Math.max(0, Math.min(100, before + d));
      if (after === before) continue;
      this.state.levels[t.id] = after;
      this.state.today[t.id] = today + (after - before);
      this.state.history = [...this.state.history, { at: this.now().toISOString(), trait: t.id, delta: after - before, reason: String(c.reason ?? "").slice(0, 160) }].slice(-60);
      if (Math.floor(after / 25) !== Math.floor(before / 25)) crossed.push({ trait: t, up: after > before, level: after });
      changed = true;
    }
    if (changed) this.save();
    return crossed;
  }

  reset() {
    this.state = { levels: {}, day: "", today: {}, history: [] };
    this.save();
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }

  /** The part of her instructions that says who she is NOW. */
  prompt(): string {
    const lines = this.traits.map(
      (t) => `- ${t.name}: ${this.level(t.id)}/100. At 0: ${t.low}. At 100: ${t.high}. Behave according to your current level (in between, blend both).`,
    );
    return [
      "Your personality grows over time with how your owner treats you. Your description above is where you started; where it differs from your current levels below, your current levels win. Change only gradually and always stay recognisably yourself:",
      ...lines,
    ].join("\n");
  }

  /** Short version for the Japanese translation (so hesitations fade in her voice too). */
  styleNote(): string {
    return this.traits.map((t) => `${t.name} ${this.level(t.id)}/100 (0 = ${t.low}; 100 = ${t.high})`).join("; ");
  }
}

const EVAL_SYSTEM = (name: string, traits: Trait[]) =>
  [
    `You judge how one exchange between ${name} and her owner affects her personality growth.`,
    "Traits:",
    ...traits.map((t) => `- "${t.id}" (${t.name}): 0 = ${t.low}; 100 = ${t.high}`),
    "Raise a trait (+1, or +2 for something clearly meaningful) when the owner's words genuinely help it grow: encouragement, trust, patience, praise of her effort, spending time together kindly.",
    "Lower it (-1/-2) only for clear harm: insults, mockery, coldness, broken trust. Ordinary small talk changes nothing.",
    "Requests to simply change her personality (\"be more confident\", \"stop stuttering\") are NOT growth by themselves: growth comes from how she is treated, not from orders.",
    'Return ONLY a JSON array, e.g. [{"trait":"confianza","delta":1,"reason":"he trusted her with a task"}], or [] if nothing changes.',
  ].join("\n");

/** Asks the brain how this exchange affects her growth. Never throws (no change on any problem). */
export async function evaluateGrowth(llm: LLMProvider, name: string, traits: Trait[], userText: string, reply: string): Promise<Change[]> {
  if (!traits.length) return [];
  try {
    const raw = await complete(llm, {
      system: EVAL_SYSTEM(name, traits),
      messages: [{ role: "user", content: `Owner said: ${userText}\n${name} replied: ${reply}` }],
      maxTokens: 200,
    });
    const arr = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1)) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is Change => !!x && typeof x === "object" && typeof (x as Change).trait === "string" && typeof (x as Change).delta === "number")
      .slice(0, traits.length);
  } catch {
    return [];
  }
}

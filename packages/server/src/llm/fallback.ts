import type { LLMEvent, LLMProvider, LLMRequest, ToolDef } from "./types.js";

export interface FallbackOptions {
  /** How long to stay on the backup brain before trying the main one again. */
  retryMs?: number;
  /** Called when she switches brains (to tell the user). */
  onSwitch?: (info: { to: "fallback" | "primary"; from: string; target: string; reason?: string }) => void;
  now?: () => number;
}

/** Turns a provider error into a short reason the user can understand. */
export function explainFailure(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/credit balance|billing|quota|insufficient/i.test(m)) return "se acabaron los creditos/tokens de la API";
  if (/\b429\b|rate.?limit/i.test(m)) return "limite de uso alcanzado";
  if (/\b529\b|overloaded/i.test(m)) return "el servicio esta saturado";
  if (/\b401\b|\b403\b|authentication|api.?key/i.test(m)) return "la clave de la API no es valida";
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(m)) return "sin conexion";
  return m.slice(0, 160);
}

/**
 * Uses the main brain (e.g. Claude) and, if it fails before saying anything (tokens/credits used up, rate limit,
 * no internet...), answers with the backup brain (e.g. Ollama on this PC) instead. She stays on the backup for
 * `retryMs` and then tries the main one again. A failure in the middle of an answer is not retried (it would
 * repeat what she already said).
 */
export class FallbackProvider implements LLMProvider {
  private downUntil = 0;
  private onFallback = false;
  private readonly retryMs: number;
  private readonly now: () => number;

  constructor(
    private primary: LLMProvider,
    private fallback: LLMProvider,
    private opts: FallbackOptions = {},
  ) {
    this.retryMs = opts.retryMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  get name() {
    return `${this.primary.name}→${this.fallback.name}`;
  }
  /** Screen vision is offered if the main brain has it (a backup without vision simply ignores images). */
  get vision() {
    return this.primary.vision;
  }
  /** Which brain answers right now. */
  get active(): string {
    return this.now() < this.downUntil ? this.fallback.name : this.primary.name;
  }

  stream(req: LLMRequest): AsyncIterable<string> {
    return this.run(req, (p) => p.stream(req));
  }

  streamWithTools(req: LLMRequest & { tools: ToolDef[] }): AsyncIterable<LLMEvent> {
    const withTools = (p: LLMProvider): AsyncIterable<LLMEvent> =>
      p.streamWithTools
        ? p.streamWithTools(req)
        : (async function* () {
            for await (const text of p.stream(req)) yield { type: "text", text } as LLMEvent;
          })();
    return this.run(req, withTools);
  }

  private async *run<T>(req: LLMRequest, make: (p: LLMProvider) => AsyncIterable<T>): AsyncIterable<T> {
    if (this.now() < this.downUntil) {
      yield* make(this.fallback);
      return;
    }
    if (this.onFallback) {
      this.onFallback = false;
      this.opts.onSwitch?.({ to: "primary", from: this.fallback.name, target: this.primary.name });
    }
    let started = false;
    try {
      for await (const x of make(this.primary)) {
        started = true;
        yield x;
      }
      return;
    } catch (e) {
      if (req.signal?.aborted || started) throw e;
      this.downUntil = this.now() + this.retryMs;
      this.onFallback = true;
      const reason = explainFailure(e);
      console.warn(`[brain] ${this.primary.name} failed (${e instanceof Error ? e.message.slice(0, 200) : e}); using ${this.fallback.name}`);
      this.opts.onSwitch?.({ to: "fallback", from: this.primary.name, target: this.fallback.name, reason });
    }
    try {
      yield* make(this.fallback);
    } catch (e) {
      if (req.signal?.aborted) throw e;
      throw new Error(`${this.primary.name} failed and the backup ${this.fallback.name} too: ${e instanceof Error ? e.message : e}`);
    }
  }
}

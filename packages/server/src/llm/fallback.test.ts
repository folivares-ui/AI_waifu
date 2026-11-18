import { describe, expect, it } from "vitest";
import { createLLM, FallbackProvider } from "./index.js";
import { explainFailure } from "./fallback.js";
import type { LLMEvent, LLMProvider, LLMRequest, ToolDef } from "./types.js";

class Fake implements LLMProvider {
  calls = 0;
  constructor(public name: string, private behaviour: "ok" | "fail" | "fail-midway", private error = "Anthropic 400: Your credit balance is too low") {}
  async *stream(): AsyncGenerator<string> {
    this.calls++;
    if (this.behaviour === "fail") throw new Error(this.error);
    yield `hola desde ${this.name}`;
    if (this.behaviour === "fail-midway") throw new Error("connection reset");
  }
  async *streamWithTools(_req: LLMRequest & { tools: ToolDef[] }): AsyncGenerator<LLMEvent> {
    for await (const t of this.stream()) yield { type: "text", text: t };
  }
}
const text = async (it: AsyncIterable<string | LLMEvent>) => { let s = ""; for await (const x of it) s += typeof x === "string" ? x : x.type === "text" ? x.text : ""; return s; };
const req = { system: "s", messages: [] };

describe("brain fallback (Claude → Ollama)", () => {
  it("answers with the backup when the main brain fails, tells the user, and goes back after the retry time", async () => {
    let t = 0;
    const main = new Fake("anthropic", "fail");
    const local = new Fake("ollama", "ok");
    const switches: any[] = [];
    const p = new FallbackProvider(main, local, { retryMs: 60_000, now: () => t, onSwitch: (s) => switches.push(s) });
    expect(await text(p.stream(req))).toBe("hola desde ollama");
    expect(switches).toEqual([{ to: "fallback", from: "anthropic", target: "ollama", reason: "se acabaron los creditos/tokens de la API" }]);
    expect(p.active).toBe("ollama");
    // while on the backup, the main one is not called at all (no wasted requests)
    expect(await text(p.streamWithTools({ ...req, tools: [] }))).toBe("hola desde ollama");
    expect(main.calls).toBe(1);
    // after the retry time, try Claude again
    t = 61_000;
    (main as any).behaviour = "ok";
    expect(await text(p.stream(req))).toBe("hola desde anthropic");
    expect(switches.at(-1)).toEqual({ to: "primary", from: "ollama", target: "anthropic" });
  });

  it("does not switch in the middle of an answer, nor when the user interrupted", async () => {
    const p = new FallbackProvider(new Fake("anthropic", "fail-midway"), new Fake("ollama", "ok"));
    await expect(text(p.stream(req))).rejects.toThrow(/connection reset/);
    const ac = new AbortController();
    ac.abort();
    const local = new Fake("ollama", "ok");
    await expect(text(new FallbackProvider(new Fake("anthropic", "fail"), local).stream({ ...req, signal: ac.signal }))).rejects.toThrow();
    expect(local.calls).toBe(0);
  });

  it("reports both failures when the backup fails too", async () => {
    const p = new FallbackProvider(new Fake("anthropic", "fail"), new Fake("ollama", "fail", "Cannot reach Ollama: is Ollama running?"));
    await expect(text(p.stream(req))).rejects.toThrow(/anthropic failed and the backup ollama too: Cannot reach Ollama/);
  });

  it("explains common failures in Spanish", () => {
    expect(explainFailure(new Error("Anthropic 429: rate_limit_error"))).toBe("limite de uso alcanzado");
    expect(explainFailure(new Error("Anthropic 529: overloaded_error"))).toBe("el servicio esta saturado");
    expect(explainFailure(new Error("Anthropic 401: authentication_error"))).toBe("la clave de la API no es valida");
    expect(explainFailure(new TypeError("fetch failed"))).toBe("sin conexion");
  });

  it("is configured with LLM_FALLBACK", () => {
    const p = createLLM({ LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "x", LLM_FALLBACK: "ollama" });
    expect(p.name).toBe("anthropic→ollama");
    expect(createLLM({ LLM_PROVIDER: "ollama" }).name).toBe("ollama");
    expect(createLLM({ LLM_PROVIDER: "ollama", LLM_FALLBACK: "ollama" }).name).toBe("ollama");
  });
});

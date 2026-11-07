import type { LLMProvider, LLMRequest } from "./types.js";

/** Offline echo brain so the whole pipeline (voice, avatar) can be tried with no API key. */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  async *stream(req: LLMRequest): AsyncIterable<string> {
    const last = req.messages.at(-1)?.content ?? "";
    // Memory-extraction calls ask for JSON; return an empty list.
    if (req.system.includes("Return ONLY a JSON array")) {
      yield "[]";
      return;
    }
    const reply = `[emotion:happy] Te escuche decir: ${last}. Soy el cerebro de prueba, configura un proveedor real para conversar de verdad.`;
    for (const word of reply.split(/(?<= )/)) {
      if (req.signal?.aborted) return;
      await new Promise((r) => setTimeout(r, 25));
      yield word;
    }
  }
}

import { asText, type LLMEvent, type LLMProvider, type LLMRequest, type ToolDef } from "./types.js";

/** Offline echo brain so the whole pipeline (voice, avatar) can be tried with no API key. */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  async *stream(req: LLMRequest): AsyncIterable<string> {
    const last = asText(req.messages.at(-1)?.content ?? "");
    // Memory-extraction calls ask for JSON; return an empty list.
    if (req.system.includes("Return ONLY a JSON array")) {
      yield "[]";
      return;
    }
    // Test aid: "emo:sad" in the message makes the mock answer with that emotion tag.
    const emo = last.match(/\bemo:([a-z]+)/)?.[1] ?? "happy";
    const reply = `[emotion:${emo}] Te escuche decir: ${last}. Soy el cerebro de prueba, configura un proveedor real para conversar de verdad.`;
    for (const word of reply.split(/(?<= )/)) {
      if (req.signal?.aborted) return;
      await new Promise((r) => setTimeout(r, 25));
      yield word;
    }
  }

  /**
   * Demo of tool use without an API key: "tool:search_apis <words>" in the user message triggers a search,
   * and the tool result is summarized back.
   */
  async *streamWithTools(req: LLMRequest & { tools: ToolDef[] }): AsyncIterable<LLMEvent> {
    const lastMsg = req.messages.at(-1)!;
    if (Array.isArray(lastMsg.content) && lastMsg.content[0]?.type === "tool_result") {
      const text = lastMsg.content[0].content.replace(/<[^>]+>/g, "").split("\n").filter((l) => l.startsWith("- ")).slice(0, 2).join(" | ");
      yield { type: "text", text: `[emotion:happy] Mira lo que encontre: ${text || "nada"}.` };
      return;
    }
    const m = asText(lastMsg.content).match(/tool:search_apis\s+(.+)/);
    if (m && req.tools.some((t) => t.name === "search_apis")) {
      yield { type: "text", text: "Dejame buscar eso. " };
      yield { type: "tool_use", id: "mock_1", name: "search_apis", input: { query: m[1].trim(), auth: "No", limit: 3 } };
      return;
    }
    for await (const t of this.stream(req)) yield { type: "text", text: t };
  }
}

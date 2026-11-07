import { asText, type LLMEvent, type LLMProvider, type LLMRequest, type ToolDef } from "./types.js";

/** Offline echo brain so the whole pipeline (voice, avatar) can be tried with no API key. */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  readonly vision = true;
  async *stream(req: LLMRequest): AsyncIterable<string> {
    const lastMsg0 = req.messages.at(-1);
    const img0 = Array.isArray(lastMsg0?.content) ? lastMsg0!.content.find((b) => b.type === "image") : undefined;
    if (img0 && img0.type === "image" && !req.system.includes("Return ONLY a JSON array")) {
      const kb = Math.round((img0.source.data.length * 3) / 4 / 1024);
      yield `[emotion:thinking] Veo tu pantalla, una imagen de unos ${kb} kilobytes. Soy el cerebro de prueba, asi que no puedo analizarla de verdad.`;
      return;
    }
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
    const afterTool = Array.isArray(lastMsg.content) && lastMsg.content[0]?.type === "tool_result";
    const img = !afterTool && Array.isArray(lastMsg.content) ? lastMsg.content.find((b) => b.type === "image") : undefined;
    if (img && img.type === "image") {
      const kb = Math.round((img.source.data.length * 3) / 4 / 1024);
      yield { type: "text", text: `[emotion:thinking] Veo tu pantalla, una imagen de unos ${kb} kilobytes. Soy el cerebro de prueba, asi que no puedo analizarla de verdad.` };
      return;
    }
    if (Array.isArray(lastMsg.content) && lastMsg.content[0]?.type === "tool_result" && lastMsg.content.some((b) => b.type === "image")) {
      yield { type: "text", text: "[emotion:happy] Ya la vi. Parece que todo esta en orden." };
      return;
    }
    if (Array.isArray(lastMsg.content) && lastMsg.content[0]?.type === "tool_result") {
      const text = lastMsg.content[0].content.replace(/<[^>]+>/g, "").split("\n").filter((l) => l.startsWith("- ")).slice(0, 2).join(" | ");
      yield { type: "text", text: `[emotion:happy] Mira lo que encontre: ${text || "nada"}.` };
      return;
    }
    const m = asText(lastMsg.content).match(/tool:search_apis\s+(.+)/);
    if (/tool:look/.test(asText(lastMsg.content)) && req.tools.some((t) => t.name === "look_at_screen")) {
      yield { type: "text", text: "Echo un vistazo. " };
      yield { type: "tool_use", id: "mock_2", name: "look_at_screen", input: {} };
      return;
    }
    if (m && req.tools.some((t) => t.name === "search_apis")) {
      yield { type: "text", text: "Dejame buscar eso. " };
      yield { type: "tool_use", id: "mock_1", name: "search_apis", input: { query: m[1].trim(), auth: "No", limit: 3 } };
      return;
    }
    for await (const t of this.stream(req)) yield { type: "text", text: t };
  }
}

import { asText, type LLMEvent, type LLMProvider, type LLMRequest, type ToolDef } from "./types.js";

/** Offline echo brain so the whole pipeline (voice, avatar) can be tried with no API key. */
export class MockProvider implements LLMProvider {
  readonly name = "mock";
  readonly vision = true;
  async *stream(req: LLMRequest): AsyncIterable<string> {
    // Spoken-language translation (speech.ts): the demo brain cannot translate. For Japanese it says a fixed
    // demo line (so the voice and the dialog box can be tried); for other languages it returns the line unchanged.
    if (req.system.startsWith("TRANSLATE_FOR_SPEECH")) {
      yield /spoken Japanese/.test(req.system) ? "（デモ）がんばります。" : asText(req.messages.at(-1)?.content ?? "");
      return;
    }
    // Demo reactions (no API key): petting and gestures. Neutral words, so they fit whichever character is
    // active (the demo brain does not read the character).
    const touch = asText(req.messages.at(-1)?.content ?? "").match(/^\[(Caricia con el cursor|Gesto con la mano ante la camara): ([^\]]+)\]/);
    if (touch) {
      const canned: Record<string, string> = {
        cabeza: "[emotion:happy] E-ehehe... me gusta mucho...",
        orejas: "[emotion:surprised] ¡Hyaa! Las orejas me dan cosquillas...",
        mejillas: "[emotion:shy] U-um... me estoy poniendo toda roja...",
        cara: "[emotion:surprised] ¿Eh? ¿Tengo algo en la cara?",
        pelo: "[emotion:happy] Hoy me peine con cuidado... ¿te gusta?",
        manos: "[emotion:shy] Tu mano es muy calida...",
        brazos: "[emotion:surprised] ¿Sí? ¿Puedo ayudarte en algo?",
        hombros: "[emotion:surprised] ¿Sí? ¿Puedo ayudarte en algo?",
        "saludo con la mano": "[emotion:happy] ¡Hola! Yo tambien te saludo.",
        "pulgar arriba": "[emotion:happy] ¡Gracias! Me esforzare aun mas.",
        "pulgar abajo": "[emotion:sad] Lo siento... lo hare mejor la proxima vez.",
        "signo de victoria (V)": "[emotion:happy] ¡Victoria!",
        "te quiero (mano)": "[emotion:shy] Y-yo tambien te quiero mucho...",
        "palma abierta": "[emotion:neutral] Sí... te espero.",
        "dedo hacia arriba": "[emotion:thinking] ¿Eh? ¿Hay algo arriba?",
        puño: "[emotion:surprised] ¡Animo! Yo tambien me esforzare.",
      };
      const fallback = touch[1].startsWith("Caricia") ? "[emotion:shy] E-eh... eso me da mucha verguenza..." : "[emotion:happy] Lo vi.";
      yield canned[touch[2]] ?? fallback;
      return;
    }
    const lastMsg0 = req.messages.at(-1);
    const img0 = Array.isArray(lastMsg0?.content) ? lastMsg0!.content.find((b) => b.type === "image") : undefined;
    if (img0 && img0.type === "image" && !req.system.includes("Return ONLY a JSON array")) {
      const kb = Math.round((img0.source.data.length * 3) / 4 / 1024);
      yield `[emotion:thinking] Veo tu pantalla, una imagen de unos ${kb} kilobytes. Soy el cerebro de prueba, asi que no puedo analizarla de verdad.`;
      return;
    }
    // user messages carry a "[texto]"/"[voz]" tag for the brain; the demo echo leaves it out
    const last = asText(req.messages.at(-1)?.content ?? "").replace(/^\[[^\]]*\]\s*/, "");
    // Memory-extraction calls ask for JSON; return an empty list.
    if (req.system.includes("Return ONLY a JSON array")) {
      yield "[]";
      return;
    }
    // Test aid: "emo:sad" in the message makes the mock answer with that emotion tag.
    const emo = last.match(/\bemo:([a-z]+)/)?.[1] ?? "happy";
    // (says who is answering: with no real brain every character answers the same way, which is not her personality)
    const who = req.system.match(/Your name is ([^.\n]+)\./)?.[1]?.trim();
    const reply = `[emotion:${emo}] ${who ? `(${who}, modo de prueba) ` : ""}Te escuche decir: ${last}. Soy el cerebro de prueba: sin un proveedor real todos los personajes responden igual. Configura uno (LLM_PROVIDER) para que hable con su propia personalidad.`;
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
      const first = lastMsg.content[0].content.replace(/<[^>]+>/g, "").trim().split("\n")[0].slice(0, 140);
      yield { type: "text", text: text ? `[emotion:happy] Mira lo que encontre: ${text}.` : `Resultado: ${first}` };
      return;
    }
    const m = asText(lastMsg.content).match(/tool:search_apis\s+(.+)/);
    if (/tool:look/.test(asText(lastMsg.content)) && req.tools.some((t) => t.name === "look_at_screen")) {
      yield { type: "text", text: "Echo un vistazo. " };
      yield { type: "tool_use", id: "mock_2", name: "look_at_screen", input: {} };
      return;
    }
    // Generic demo/test trigger: "tool:<name> {json input}" calls any available tool.
    const g = asText(lastMsg.content).match(/tool:([a-z_]+)\s+(\{[\s\S]*\})\s*$/);
    if (g && req.tools.some((t) => t.name === g[1])) {
      yield { type: "text", text: "Voy a hacerlo. " };
      yield { type: "tool_use", id: `mock_${Date.now()}`, name: g[1], input: JSON.parse(g[2]) };
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

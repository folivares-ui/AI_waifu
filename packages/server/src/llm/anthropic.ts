import { readLines, type LLMEvent, type LLMProvider, type LLMRequest, type ToolDef } from "./types.js";

/** Anthropic Messages API (streaming over SSE). Needs ANTHROPIC_API_KEY. */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  constructor(private apiKey: string, private model: string) {}

  async *stream(req: LLMRequest): AsyncIterable<string> {
    for await (const ev of this.events(req)) if (ev.type === "text") yield ev.text;
  }

  /** Streaming with native tool use (content_block_start/tool_use + input_json_delta events). */
  streamWithTools(req: LLMRequest & { tools: ToolDef[] }): AsyncIterable<LLMEvent> {
    return this.events(req, req.tools);
  }

  private async *events(req: LLMRequest, tools?: ToolDef[]): AsyncIterable<LLMEvent> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: req.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 1024,
        system: req.system,
        messages: req.messages,
        ...(tools?.length ? { tools } : {}),
        stream: true,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const pending = new Map<number, { id: string; name: string; json: string }>();
    for await (const line of readLines(res.body)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const evt = JSON.parse(data);
      if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use") {
        pending.set(evt.index, { id: evt.content_block.id, name: evt.content_block.name, json: "" });
      } else if (evt.type === "content_block_delta") {
        if (evt.delta?.type === "text_delta") yield { type: "text", text: evt.delta.text as string };
        else if (evt.delta?.type === "input_json_delta") {
          const p = pending.get(evt.index);
          if (p) p.json += evt.delta.partial_json as string;
        }
      } else if (evt.type === "content_block_stop") {
        const p = pending.get(evt.index);
        if (p) {
          pending.delete(evt.index);
          yield { type: "tool_use", id: p.id, name: p.name, input: p.json ? JSON.parse(p.json) : {} };
        }
      } else if (evt.type === "error") throw new Error(evt.error?.message ?? "Anthropic stream error");
    }
  }
}

import { readLines, type LLMProvider, type LLMRequest } from "./types.js";

/** Anthropic Messages API (streaming over SSE). Needs ANTHROPIC_API_KEY. */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  constructor(private apiKey: string, private model: string) {}

  async *stream(req: LLMRequest): AsyncIterable<string> {
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
        stream: true,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    for await (const line of readLines(res.body)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const evt = JSON.parse(data);
      if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") yield evt.delta.text as string;
      if (evt.type === "error") throw new Error(evt.error?.message ?? "Anthropic stream error");
    }
  }
}

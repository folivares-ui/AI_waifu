import { readLines, type LLMProvider, type LLMRequest } from "./types.js";

/** Local models through Ollama (default http://localhost:11434). Fully offline. */
export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  constructor(private model: string, private host = "http://localhost:11434") {}

  async *stream(req: LLMRequest): AsyncIterable<string> {
    const res = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      signal: req.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        messages: [{ role: "system", content: req.system }, ...req.messages],
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
    for await (const line of readLines(res.body)) {
      const evt = JSON.parse(line);
      if (evt.error) throw new Error(String(evt.error));
      if (evt.message?.content) yield evt.message.content as string;
      if (evt.done) return;
    }
  }
}

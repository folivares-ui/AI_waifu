import { asText, readLines, type LLMProvider, type LLMRequest } from "./types.js";

/** Local models through Ollama (default http://localhost:11434). Fully offline. */
export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  /** Only true if you configured a vision-capable model (OLLAMA_VISION=1), e.g. a llava-style model. */
  readonly vision: boolean;
  constructor(private model: string, private host = "http://localhost:11434", vision = false) {
    this.vision = vision;
  }

  async *stream(req: LLMRequest): AsyncIterable<string> {
    const res = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      signal: req.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        messages: [
          { role: "system", content: req.system },
          ...req.messages.map((m) => {
            const images = Array.isArray(m.content) ? m.content.filter((b) => b.type === "image").map((b) => (b as { source: { data: string } }).source.data) : [];
            return { role: m.role, content: asText(m.content), ...(images.length ? { images } : {}) };
          }),
        ],
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

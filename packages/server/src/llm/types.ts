export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMRequest {
  system: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  maxTokens?: number;
}

/** Any brain (cloud or local) implements this. Add new providers in ./index.ts. */
export interface LLMProvider {
  readonly name: string;
  stream(req: LLMRequest): AsyncIterable<string>;
}

export async function complete(llm: LLMProvider, req: LLMRequest): Promise<string> {
  let out = "";
  for await (const t of llm.stream(req)) out += t;
  return out;
}

/** Yields non-empty lines from a streaming fetch body. */
export async function* readLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line) yield line;
      }
    }
    if (buf.trim()) yield buf.trim();
  } finally {
    reader.releaseLock();
  }
}

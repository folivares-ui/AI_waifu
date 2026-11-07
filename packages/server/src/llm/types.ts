export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export type LLMEvent = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

/** Flattens message content to plain text (for providers without tool support). */
export function asText(c: string | ContentBlock[]): string {
  return typeof c === "string" ? c : c.map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : "")).join("\n");
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
  /** True if the model accepts image input (screen vision). */
  readonly vision?: boolean;
  stream(req: LLMRequest): AsyncIterable<string>;
  /** Optional native tool use. Providers without it simply never get tools. */
  streamWithTools?(req: LLMRequest & { tools: ToolDef[] }): AsyncIterable<LLMEvent>;
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

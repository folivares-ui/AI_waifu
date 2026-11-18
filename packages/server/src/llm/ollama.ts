import { readLines, type ChatMessage, type ContentBlock, type LLMEvent, type LLMProvider, type LLMRequest, type ToolDef } from "./types.js";

/** A message in Ollama's /api/chat format (see docs/api.md in the Ollama repository). */
export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
}

const blocks = (c: string | ContentBlock[]): ContentBlock[] => (typeof c === "string" ? [{ type: "text", text: c }] : c);
const textOf = (bs: ContentBlock[]) => bs.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
const imagesOf = (bs: ContentBlock[]) => bs.flatMap((b) => (b.type === "image" ? [b.source.data] : []));

/**
 * Converts the app's (Anthropic-style) history to Ollama's: tool_use blocks become `tool_calls` on the assistant
 * message, and each tool_result becomes its own `role: "tool"` message named after the tool that produced it.
 */
export function toOllamaMessages(system: string, messages: ChatMessage[], withImages: boolean): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: system }];
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    const bs = blocks(m.content);
    if (m.role === "assistant") {
      const calls = bs.flatMap((b) => (b.type === "tool_use" ? [b] : []));
      for (const c of calls) toolNames.set(c.id, c.name);
      out.push({ role: "assistant", content: textOf(bs), ...(calls.length ? { tool_calls: calls.map((c) => ({ function: { name: c.name, arguments: c.input ?? {} } })) } : {}) });
      continue;
    }
    for (const b of bs) {
      if (b.type === "tool_result") out.push({ role: "tool", content: (b.is_error ? "ERROR: " : "") + b.content, tool_name: toolNames.get(b.tool_use_id) ?? "tool" });
    }
    const text = textOf(bs);
    const images = withImages ? imagesOf(bs) : [];
    if (text || images.length) out.push({ role: "user", content: text, ...(images.length ? { images } : {}) });
  }
  return out;
}

/** Ollama wants OpenAI-style function definitions. */
export const toOllamaTools = (tools: ToolDef[]) =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));

/** Small local models sometimes send the arguments as a JSON string instead of an object. */
function parseArgs(a: unknown): unknown {
  if (typeof a !== "string") return a ?? {};
  try {
    return JSON.parse(a);
  } catch {
    return {};
  }
}

/** Local models through Ollama (default http://localhost:11434). Fully offline and free. */
export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  /** Only true if you configured a vision-capable model (OLLAMA_VISION=1). */
  readonly vision: boolean;
  private calls = 0;

  constructor(
    private model: string,
    private host = "http://localhost:11434",
    vision = false,
    /** Context window. Ollama's default (2048–4096 tokens) is too small for her persona + tool list. */
    private numCtx = 8192,
    /** OLLAMA_TOOLS=0 turns tool use off for models that do not support it. */
    private toolsEnabled = true,
  ) {
    this.vision = vision;
    // An own property shadows the method, so the session sees "no tool support".
    if (!toolsEnabled) (this as { streamWithTools?: unknown }).streamWithTools = undefined;
  }

  async *stream(req: LLMRequest): AsyncIterable<string> {
    for await (const ev of this.events(req)) if (ev.type === "text") yield ev.text;
  }

  streamWithTools(req: LLMRequest & { tools: ToolDef[] }): AsyncIterable<LLMEvent> {
    return this.events(req, req.tools);
  }

  private async *events(req: LLMRequest, tools?: ToolDef[]): AsyncIterable<LLMEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.host.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        signal: req.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          messages: toOllamaMessages(req.system, req.messages, this.vision),
          ...(tools?.length ? { tools: toOllamaTools(tools) } : {}),
          options: { num_ctx: this.numCtx, ...(req.maxTokens ? { num_predict: req.maxTokens } : {}) },
        }),
      });
    } catch (e) {
      if (req.signal?.aborted) throw e;
      throw new Error(`Cannot reach Ollama at ${this.host}: is Ollama running? (${(e as Error).message})`);
    }
    if (!res.ok || !res.body) {
      const body = await res.text();
      if (tools?.length && /does not support tools/i.test(body)) {
        throw new Error(`The model "${this.model}" cannot use tools. Pick one with tool support (e.g. qwen2.5) or set OLLAMA_TOOLS=0.`);
      }
      if (res.status === 404) throw new Error(`Ollama does not have the model "${this.model}": run  ollama pull ${this.model}`);
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 300)}`);
    }
    for await (const line of readLines(res.body)) {
      const evt = JSON.parse(line);
      if (evt.error) throw new Error(String(evt.error));
      if (evt.message?.content) yield { type: "text", text: evt.message.content as string };
      for (const c of evt.message?.tool_calls ?? []) {
        if (!c?.function?.name) continue;
        yield { type: "tool_use", id: `ollama_${++this.calls}`, name: String(c.function.name), input: parseArgs(c.function.arguments) };
      }
      if (evt.done) return;
    }
  }
}

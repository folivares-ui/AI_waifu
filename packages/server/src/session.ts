import { SentenceChunker, prepareForSpeech, type Capabilities, type ClientMessage, type Emotion, type ServerMessage } from "@waifu/core";
import type { ChatMessage, ContentBlock, LLMEvent, LLMProvider } from "./llm/index.js";
import type { Tool } from "./tools/index.js";
import { extractFacts, type MemoryStore } from "./memory.js";
import { buildSystemPrompt, type Soul } from "./soul.js";
import type { TTSProvider } from "./tts/index.js";

const MAX_HISTORY = 24; // messages kept in the short-term context window
const MAX_INPUT_CHARS = 4000;
const MAX_TOOL_ROUNDS = 4; // tool round-trips per user turn
const MAX_TOOL_CALLS = 8;

/** One connected client = one conversation with the soul. */
export class Session {
  private history: ChatMessage[] = [];
  private turnId = 0;
  private abort?: AbortController;

  constructor(
    private soul: Soul,
    private llm: LLMProvider,
    private memory: MemoryStore,
    private send: (m: ServerMessage) => void,
    private tts?: TTSProvider,
    private caps: Capabilities = { tts: !!tts, stt: false },
    private tools: Tool[] = [],
  ) {}

  hello() {
    this.send({ type: "ready", soul: { name: this.soul.name, voice: this.soul.voice }, caps: this.caps });
  }

  handle(msg: ClientMessage) {
    switch (msg.type) {
      case "hello":
        return this.hello();
      case "interrupt":
        return this.abort?.abort();
      case "user_text": {
        const text = String(msg.text ?? "").trim().slice(0, MAX_INPUT_CHARS);
        if (text) void this.runTurn(text);
      }
    }
  }

  close() {
    this.abort?.abort();
  }

  private async runTurn(userText: string) {
    this.abort?.abort(); // barge-in: a new utterance cancels the previous answer
    const abort = (this.abort = new AbortController());
    const turnId = ++this.turnId;
    const chunker = new SentenceChunker();
    let reply = "";

    // Sentences are synthesized in parallel but delivered strictly in order.
    let chain: Promise<void> = Promise.resolve();
    let seq = 0;
    const deliver = (text: string, emotion: Emotion) => {
      const spoken = prepareForSpeech(text);
      if (!this.tts || !spoken) {
        this.send({ type: "sentence", turnId, text, emotion });
        return;
      }
      const mySeq = seq++;
      const synth = this.tts.synthesize(spoken, { voice: this.soul.voice.ttsVoice, lang: this.soul.voice.lang }, abort.signal);
      synth.catch(() => {}); // handled in the chain below
      chain = chain.then(async () => {
        try {
          const { audio, mime } = await synth;
          if (!abort.signal.aborted) this.send({ type: "audio", turnId, seq: mySeq, text, emotion, mime, data: audio.toString("base64") });
        } catch (err) {
          if (abort.signal.aborted) return;
          // Degrade gracefully: the client speaks this sentence with its own voice.
          this.send({ type: "error", message: `TTS fallo: ${err instanceof Error ? err.message : err}` });
          this.send({ type: "sentence", turnId, text, emotion });
        }
      });
    };

    const emit = (parts: { text: string; emotion: Emotion }[]) => {
      for (const p of parts) {
        reply += (reply ? " " : "") + p.text;
        deliver(p.text, p.emotion);
      }
    };

    this.history.push({ role: "user", content: userText });
    try {
      const system = buildSystemPrompt(this.soul, this.memory.recall(userText), this.tools.length > 0);
      const working: ChatMessage[] = this.history.slice(-MAX_HISTORY);
      const toolDefs = this.tools.map((t) => t.def);
      let rounds = 0;
      let calls = 0;
      for (let iter = 0; iter < MAX_TOOL_ROUNDS + 2; iter++) {
        const events: AsyncIterable<LLMEvent> =
          toolDefs.length && this.llm.streamWithTools
            ? this.llm.streamWithTools({ system, messages: working, tools: toolDefs, signal: abort.signal })
            : (async function* (s: AsyncIterable<string>) {
                for await (const text of s) yield { type: "text", text } as LLMEvent;
              })(this.llm.stream({ system, messages: working, signal: abort.signal }));
        const uses: Extract<LLMEvent, { type: "tool_use" }>[] = [];
        let stepText = "";
        for await (const ev of events) {
          if (abort.signal.aborted) break;
          if (ev.type === "text") {
            stepText += ev.text;
            this.send({ type: "token", turnId, text: ev.text });
            emit(chunker.push(ev.text));
          } else uses.push(ev);
        }
        if (abort.signal.aborted || uses.length === 0) break;

        emit(chunker.flush()); // let her say "let me look that up" while the tool runs
        const results: ContentBlock[] = [];
        for (const u of uses) {
          const tool = this.tools.find((t) => t.def.name === u.name);
          let content: string;
          let ok = true;
          if (!tool) {
            content = `Unknown tool "${u.name}".`;
            ok = false;
          } else if (rounds >= MAX_TOOL_ROUNDS || calls >= MAX_TOOL_CALLS) {
            content = "Tool limit reached for this turn. Answer the user with what you already know.";
            ok = false;
          } else {
            calls++;
            this.send({ type: "tool", turnId, name: u.name, status: "start" });
            try {
              content = await tool.run(u.input, abort.signal);
            } catch (e) {
              content = `Error: ${e instanceof Error ? e.message : String(e)}`;
              ok = false;
            }
            this.send({ type: "tool", turnId, name: u.name, status: "end", ok });
          }
          results.push({ type: "tool_result", tool_use_id: u.id, content, ...(ok ? {} : { is_error: true }) });
        }
        rounds++;
        working.push({
          role: "assistant",
          content: [...(stepText ? [{ type: "text" as const, text: stepText }] : []), ...uses.map((u) => ({ type: "tool_use" as const, id: u.id, name: u.name, input: u.input }))],
        });
        working.push({ role: "user", content: results });
        if (abort.signal.aborted) break;
      }
      if (!abort.signal.aborted) emit(chunker.flush());
    } catch (err) {
      if (!abort.signal.aborted) {
        this.send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }

    await chain;
    const interrupted = abort.signal.aborted;
    if (reply) this.history.push({ role: "assistant", content: reply });
    else this.history.pop(); // nothing was said; drop the dangling user message
    this.send({ type: "done", turnId, interrupted });

    if (!interrupted && reply) {
      for (const fact of await extractFacts(this.llm, userText, reply)) this.memory.add(fact);
    }
  }
}

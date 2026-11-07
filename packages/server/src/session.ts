import { SentenceChunker, prepareForSpeech, type Capabilities, type ClientMessage, type Emotion, type ServerMessage } from "@waifu/core";
import type { ChatMessage, LLMProvider } from "./llm/index.js";
import { extractFacts, type MemoryStore } from "./memory.js";
import { buildSystemPrompt, type Soul } from "./soul.js";
import type { TTSProvider } from "./tts/index.js";

const MAX_HISTORY = 24; // messages kept in the short-term context window
const MAX_INPUT_CHARS = 4000;

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
      const system = buildSystemPrompt(this.soul, this.memory.recall(userText));
      for await (const token of this.llm.stream({
        system,
        messages: this.history.slice(-MAX_HISTORY),
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) break;
        this.send({ type: "token", turnId, text: token });
        emit(chunker.push(token));
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

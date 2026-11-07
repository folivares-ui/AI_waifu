import { EMOTIONS, type Emotion } from "./protocol.js";

const EMOTION_TAG = /\[emotion:\s*([a-z]+)\s*\]/gi;

/** Removes emotion tags from text and returns the last valid emotion found (if any). */
export function extractEmotion(text: string): { text: string; emotion?: Emotion } {
  let emotion: Emotion | undefined;
  const clean = text.replace(EMOTION_TAG, (_m, name: string) => {
    const e = name.toLowerCase() as Emotion;
    if ((EMOTIONS as readonly string[]).includes(e)) emotion = e;
    return "";
  });
  return { text: clean.replace(/\s{2,}/g, " ").trim(), emotion };
}

/**
 * Incrementally splits a token stream into sentences so TTS can start before the
 * LLM has finished. Emotion tags are consumed and attached to the sentence.
 * A tag split across chunks (e.g. "[emot" + "ion:happy]") is held back until complete.
 */
export class SentenceChunker {
  private buf = "";
  private emotion: Emotion = "neutral";

  push(chunk: string): { text: string; emotion: Emotion }[] {
    this.buf += chunk;
    return this.drain(false);
  }

  flush(): { text: string; emotion: Emotion }[] {
    return this.drain(true);
  }

  private drain(final: boolean): { text: string; emotion: Emotion }[] {
    const out: { text: string; emotion: Emotion }[] = [];
    // Hold back an unterminated tag so it is never emitted as speech.
    const open = this.buf.lastIndexOf("[");
    const hasOpenTag = open !== -1 && this.buf.indexOf("]", open) === -1;
    const limit = !final && hasOpenTag ? open : this.buf.length;
    let work = this.buf.slice(0, limit);
    const rest = this.buf.slice(limit);

    // A "." directly followed by a non-space char (3.14, e.g.) is not a sentence end.
    const re = /(?:[^.!?…\n]|\.(?=[^\s.!?…"')\]]))*[.!?…\n]+["')\]]*(?:\s+|$)/y;
    let consumed = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(work))) {
      // A trailing terminator at the very end may be mid-token ("3." of "3.14"): wait unless final.
      if (!final && m.index + m[0].length === work.length && !/\s$/.test(m[0])) break;
      const { text, emotion } = extractEmotion(m[0]);
      if (emotion) this.emotion = emotion;
      if (text) out.push({ text, emotion: this.emotion });
      consumed = m.index + m[0].length;
    }
    work = work.slice(consumed);
    if (final) {
      const { text, emotion } = extractEmotion(work + rest);
      if (emotion) this.emotion = emotion;
      if (text) out.push({ text, emotion: this.emotion });
      this.buf = "";
    } else {
      this.buf = work + rest;
    }
    return out;
  }
}

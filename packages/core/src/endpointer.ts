import { rms } from "./audio.js";

export interface EndpointerOptions {
  sampleRate: number;
  /** Absolute minimum RMS to be considered speech (guards against a silent-room floor of ~0). */
  minLevel?: number;
  /** Speech must exceed noise floor by this factor. */
  ratio?: number;
  /** Consecutive speech needed before `speech_start` fires (ms). */
  startMs?: number;
  /** Silence needed to close an utterance (ms). */
  hangoverMs?: number;
  /** Audio kept from before speech was confirmed (ms). */
  preRollMs?: number;
  /** Utterances shorter than this are dropped as clicks/noise (ms). */
  minUtteranceMs?: number;
  /** Safety cap (ms). */
  maxUtteranceMs?: number;
}

export type EndpointEvent =
  | { type: "speech_start" }
  | { type: "utterance"; samples: Float32Array; sampleRate: number; startedDuringBoost: boolean }
  | { type: "discarded" };

/**
 * Energy-based voice activity detection with an adaptive noise floor and hangover.
 * Pure logic (no browser APIs) so it is unit-tested. A neural VAD (Silero) is a drop-in upgrade.
 * `boost` multiplies the threshold (raise it while the soul is talking, to resist echo).
 */
export class Endpointer {
  boost = 1;
  private o: Required<EndpointerOptions>;
  private floor = 0.003;
  private speechMs = 0;
  private silenceMs = 0;
  private active = false;
  private startedDuringBoost = false;
  private pre: Float32Array[] = [];
  private preMs = 0;
  private cur: Float32Array[] = [];
  private curMs = 0;

  constructor(opts: EndpointerOptions) {
    this.o = { minLevel: 0.012, ratio: 3, startMs: 120, hangoverMs: 700, preRollMs: 250, minUtteranceMs: 300, maxUtteranceMs: 30000, ...opts };
  }

  push(frame: Float32Array): EndpointEvent[] {
    const ms = (frame.length / this.o.sampleRate) * 1000;
    const level = rms(frame);
    const threshold = Math.max(this.o.minLevel, this.floor * this.o.ratio) * this.boost;
    const isSpeech = level > threshold;
    const events: EndpointEvent[] = [];

    if (!isSpeech && !this.active) this.floor = this.floor * 0.95 + level * 0.05; // learn the room

    if (!this.active) {
      this.pre.push(frame);
      this.preMs += ms;
      while (this.preMs - (this.pre[0].length / this.o.sampleRate) * 1000 >= this.o.preRollMs) {
        this.preMs -= (this.pre.shift()!.length / this.o.sampleRate) * 1000;
      }
      this.speechMs = isSpeech ? this.speechMs + ms : 0;
      if (this.speechMs >= this.o.startMs) {
        this.active = true;
        this.startedDuringBoost = this.boost > 1;
        this.cur = [...this.pre];
        this.curMs = this.preMs;
        this.pre = [];
        this.preMs = 0;
        this.silenceMs = 0;
        events.push({ type: "speech_start" });
      }
      return events;
    }

    this.cur.push(frame);
    this.curMs += ms;
    this.silenceMs = isSpeech ? 0 : this.silenceMs + ms;
    if (this.silenceMs >= this.o.hangoverMs || this.curMs >= this.o.maxUtteranceMs) {
      const speechLen = this.curMs - this.silenceMs;
      if (speechLen >= this.o.minUtteranceMs) events.push({ type: "utterance", samples: concat(this.cur), sampleRate: this.o.sampleRate, startedDuringBoost: this.startedDuringBoost });
      else events.push({ type: "discarded" });
      this.active = false;
      this.cur = [];
      this.curMs = 0;
      this.speechMs = 0;
      this.silenceMs = 0;
    }
    return events;
  }
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

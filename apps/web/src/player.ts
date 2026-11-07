import type { Emotion } from "@waifu/core";

export interface Clip {
  data: ArrayBuffer;
  emotion: Emotion;
  text: string;
}

/**
 * Plays server-synthesized speech clips back to back. Exposes a live loudness level
 * (for lip-sync) and lets the caller cut everything instantly (barge-in).
 * Audio goes through the page's own AudioContext, which lets the browser's echo
 * canceller treat it as the reference signal for the microphone.
 */
export class ClipPlayer {
  private ctx = new AudioContext();
  private analyser = this.ctx.createAnalyser();
  private buf = new Uint8Array(1024);
  private queue: { buffer: AudioBuffer; clip: Clip }[] = [];
  private decoding: Promise<void> = Promise.resolve();
  private current?: AudioBufferSourceNode;
  private generation = 0;
  playing = false;
  /** Timestamp (ms) when playback last ended; used to ignore echo tails. */
  lastEnded = 0;

  constructor(private cb: { onStart: (c: Clip) => void; onIdle: () => void }) {
    this.analyser.fftSize = 1024;
    this.analyser.connect(this.ctx.destination);
  }

  /** Must be called from a user gesture at least once (autoplay policy). */
  async unlock() {
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  enqueue(clip: Clip) {
    const gen = this.generation;
    // Decode in order so clips can never overtake each other.
    this.decoding = this.decoding.then(async () => {
      try {
        const buffer = await this.ctx.decodeAudioData(clip.data.slice(0));
        if (gen !== this.generation) return;
        this.queue.push({ buffer, clip });
        if (!this.playing) this.next();
      } catch (e) {
        console.warn("Could not decode audio clip", e);
      }
    });
  }

  private next() {
    const item = this.queue.shift();
    if (!item) {
      this.playing = false;
      this.lastEnded = performance.now();
      this.current = undefined;
      this.cb.onIdle();
      return;
    }
    this.playing = true;
    const src = this.ctx.createBufferSource();
    src.buffer = item.buffer;
    src.connect(this.analyser);
    src.onended = () => {
      if (this.current === src) this.next();
    };
    this.current = src;
    this.cb.onStart(item.clip);
    src.start();
  }

  /** Loudness 0..1 of what is playing right now. */
  level(): number {
    if (!this.playing) return 0;
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (const b of this.buf) sum += ((b - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 4);
  }

  stop() {
    this.generation++;
    this.queue = [];
    const src = this.current;
    this.current = undefined;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
    }
    if (this.playing) {
      this.playing = false;
      this.lastEnded = performance.now();
      this.cb.onIdle();
    }
  }
}

export const b64ToBuffer = (b64: string): ArrayBuffer => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

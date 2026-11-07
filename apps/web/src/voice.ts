import type { VoiceHints } from "@waifu/core";

/** Minimal typing for the (still vendor-prefixed) Web Speech recognition API. */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: any) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: any) => void) | null;
  start(): void;
  stop(): void;
}

const RecognitionCtor: (new () => Recognition) | undefined =
  (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;

export const sttSupported = !!RecognitionCtor;

/** Continuous speech-to-text. `onInterim` fires as soon as the user starts talking (for barge-in). */
export class Listener {
  private rec?: Recognition;
  private wanted = false;

  constructor(
    private lang: string,
    private cb: { onInterim: () => void; onFinal: (text: string) => void; onError: (msg: string) => void },
  ) {}

  start() {
    if (!RecognitionCtor || this.wanted) return;
    this.wanted = true;
    this.spawn();
  }

  stop() {
    this.wanted = false;
    this.rec?.stop();
  }

  private spawn() {
    const rec = new RecognitionCtor!();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const text = String(r[0].transcript).trim();
          if (text) this.cb.onFinal(text);
        } else {
          this.cb.onInterim();
        }
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.wanted = false;
        this.cb.onError("Permiso de microfono denegado.");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        this.cb.onError(`Error de reconocimiento: ${e.error}`);
      }
    };
    // The browser ends sessions on silence; restart while the user wants to keep listening.
    rec.onend = () => {
      if (this.wanted) this.spawn();
    };
    this.rec = rec;
    rec.start();
  }
}

/** Queue-based speech output; resolves state callbacks so the avatar can lip-sync. */
export class Speaker {
  private pending = 0;
  get busy() {
    return this.pending > 0;
  }
  constructor(
    private voice: VoiceHints,
    private onSpeaking: (speaking: boolean) => void,
  ) {}

  setVoice(v: VoiceHints) {
    this.voice = v;
  }

  speak(text: string) {
    if (!("speechSynthesis" in globalThis)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = this.voice.lang;
    u.pitch = this.voice.pitch;
    u.rate = this.voice.rate;
    const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith(this.voice.lang.slice(0, 2)));
    if (voice) u.voice = voice;
    this.pending++;
    const done = () => {
      this.pending = Math.max(0, this.pending - 1);
      if (this.pending === 0) this.onSpeaking(false);
    };
    u.onstart = () => this.onSpeaking(true);
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  }

  /** Immediately silence everything (barge-in). */
  cancel() {
    this.pending = 0;
    speechSynthesis.cancel();
    this.onSpeaking(false);
  }
}

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

/** The system voice, if this browser/webview has one (some desktop webviews do not). */
const synth = (): SpeechSynthesis | undefined =>
  typeof SpeechSynthesisUtterance === "undefined" ? undefined : ((globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis ?? undefined);

/** Female and natural/online voices sound closer to her; male voices are avoided. */
const GOOD = /natural|online|neural|google|nanami|haruka|ayumi|mayu|aoi|shiori|kyoko|o-ren|elvira|helena|laura|lucia|monica|paulina|sabina|dalia|elena/i;
const MALE = /ichiro|keita|daichi|naoki|otoya|hattori|alvaro|pablo|raul|jorge|diego|jose|gonzalo|male\b/i;

/**
 * Picks the best voice for a language (e.g. a female Japanese voice for "ja-JP").
 * Privacy: "online" voices (Edge's "Natural", Chrome's "Google ...") send every sentence to Microsoft/Google.
 * They are only used when `allowOnline` is true (a setting the user turns on); by default only voices that run
 * on this computer (`localService`) are used.
 */
export function pickVoice(voices: SpeechSynthesisVoice[], lang: string, allowOnline = false): SpeechSynthesisVoice | undefined {
  const want = lang.toLowerCase();
  const prefix = want.slice(0, 2);
  const score = (v: SpeechSynthesisVoice) =>
    (v.lang.toLowerCase().replace("_", "-") === want ? 2 : 0) + (GOOD.test(v.name) ? 3 : 0) - (MALE.test(v.name) ? 5 : 0);
  return voices
    .filter((v) => v.lang.toLowerCase().replace("_", "-").startsWith(prefix))
    .filter((v) => allowOnline || v.localService !== false)
    .sort((a, b) => score(b) - score(a))[0];
}

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

  /** Online voices send the text to Microsoft/Google: off unless the user allows it. */
  allowOnline = false;

  /**
   * Speaks a line with the system voice, in `lang` (default: her text language). Returns false when this
   * browser/Windows has no voice for that language (the caller can tell the user once).
   */
  speak(text: string, lang = this.voice.lang, onStart?: () => void): boolean {
    const tts = synth();
    if (!tts) return false;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.pitch = this.voice.pitch;
    u.rate = this.voice.rate;
    const voice = pickVoice(tts.getVoices(), lang, this.allowOnline);
    // No allowed voice: stay silent rather than let the browser pick an online one by itself.
    if (!voice && tts.getVoices().length > 0) return false;
    if (voice) u.voice = voice;
    this.pending++;
    const done = () => {
      this.pending = Math.max(0, this.pending - 1);
      if (this.pending === 0) this.onSpeaking(false);
    };
    u.onstart = () => {
      this.onSpeaking(true);
      onStart?.();
    };
    u.onend = done;
    u.onerror = done;
    tts.speak(u);
    // getVoices() can be empty until the browser has loaded them: only report "missing" once they are known.
    return !!voice || tts.getVoices().length === 0;
  }

  /** Immediately silence everything (barge-in). */
  cancel() {
    this.pending = 0;
    synth()?.cancel();
    this.onSpeaking(false);
  }
}

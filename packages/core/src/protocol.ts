/** Wire protocol between any client (web, desktop, mobile) and the soul server. */

export type Emotion = "neutral" | "happy" | "sad" | "angry" | "surprised" | "thinking" | "shy";
export const EMOTIONS: readonly Emotion[] = ["neutral", "happy", "sad", "angry", "surprised", "thinking", "shy"];

export type ClientMessage =
  | { type: "user_text"; text: string }
  /** User started speaking / sent new input while the soul is talking: stop current turn. */
  | { type: "interrupt" }
  | { type: "hello" };

export type ServerMessage =
  | { type: "ready"; soul: { name: string; voice: VoiceHints }; caps: Capabilities }
  /** Streaming token (for text display). */
  | { type: "token"; turnId: number; text: string }
  /**
   * A complete sentence. Sent when the server has NO audio for it (TTS disabled or failed), so the
   * client should speak it itself (browser TTS). Otherwise the sentence arrives as an `audio` message.
   */
  | { type: "sentence"; turnId: number; text: string; emotion: Emotion }
  /** Synthesized speech for one sentence, in order. `data` is base64. Emotion applies while it plays. */
  | { type: "audio"; turnId: number; seq: number; text: string; emotion: Emotion; mime: string; data: string }
  | { type: "done"; turnId: number; interrupted: boolean }
  | { type: "error"; message: string };

export interface Capabilities {
  /** Server synthesizes speech (`audio` messages). */
  tts: boolean;
  /** Server transcribes speech via POST /stt. */
  stt: boolean;
}

export interface VoiceHints {
  /** BCP-47 language tag used for browser STT/TTS, e.g. "es-ES". */
  lang: string;
  pitch: number;
  rate: number;
  /** Voice name/id for the server TTS engine (engine specific). */
  ttsVoice?: string;
}

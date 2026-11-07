/** Wire protocol between any client (web, desktop, mobile) and the soul server. */

export type Emotion = "neutral" | "happy" | "sad" | "angry" | "surprised" | "thinking" | "shy";
export const EMOTIONS: readonly Emotion[] = ["neutral", "happy", "sad", "angry", "surprised", "thinking", "shy"];

export type ClientMessage =
  | { type: "user_text"; text: string }
  /** User started speaking / sent new input while the soul is talking: stop current turn. */
  | { type: "interrupt" }
  | { type: "hello" };

export type ServerMessage =
  | { type: "ready"; soul: { name: string; voice: VoiceHints } }
  /** Streaming token (for text display). */
  | { type: "token"; turnId: number; text: string }
  /** A complete sentence, ready to be sent to TTS. Emotion applies from this sentence on. */
  | { type: "sentence"; turnId: number; text: string; emotion: Emotion }
  | { type: "done"; turnId: number; interrupted: boolean }
  | { type: "error"; message: string };

export interface VoiceHints {
  /** BCP-47 language tag used for browser STT/TTS, e.g. "es-ES". */
  lang: string;
  pitch: number;
  rate: number;
}

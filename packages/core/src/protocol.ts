/** Wire protocol between any client (web, desktop, mobile) and the soul server. */

export type Emotion = "neutral" | "happy" | "sad" | "angry" | "surprised" | "thinking" | "shy";
export const EMOTIONS: readonly Emotion[] = ["neutral", "happy", "sad", "angry", "surprised", "thinking", "shy"];

/** A screenshot shared by the user (JPEG/PNG/WebP, base64 without the data: prefix). */
export interface ScreenImage {
  data: string;
  mime: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
}

export type ClientMessage =
  | { type: "user_text"; text: string; /** Screenshot the user explicitly attached to this message. */ image?: ScreenImage }
  /** Reply to `screen_request`. `error: "not_sharing"` when the user has not enabled screen sharing. */
  | { type: "screen_frame"; requestId: string; image?: ScreenImage; error?: "not_sharing" | "failed" }
  /** Periodic frame sent only while the user has "continuous observation" switched on. */
  | { type: "screen_watch"; image: ScreenImage }
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
  /** The soul is running a tool (e.g. querying a public API). For UI feedback only. */
  | { type: "tool"; turnId: number; name: string; status: "start" | "end"; ok?: boolean }
  /** The soul wants to look at the screen (tool call). Client answers with `screen_frame`. */
  | { type: "screen_request"; requestId: string }
  | { type: "done"; turnId: number; interrupted: boolean }
  | { type: "error"; message: string };

export interface Capabilities {
  /** Server synthesizes speech (`audio` messages). */
  tts: boolean;
  /** Server transcribes speech via POST /stt. */
  stt: boolean;
  /** The brain can see images (screen sharing features are offered). */
  vision: boolean;
}

export interface VoiceHints {
  /** BCP-47 language tag used for browser STT/TTS, e.g. "es-ES". */
  lang: string;
  pitch: number;
  rate: number;
  /** Voice name/id for the server TTS engine (engine specific). */
  ttsVoice?: string;
}

/**
 * Turns started by the soul herself (screen observation) are numbered from this base so they never
 * collide with turns started by the user (turn n = the user's n-th `user_text`).
 */
export const PROACTIVE_TURN_BASE = 1_000_000;

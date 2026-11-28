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
  | {
      type: "user_text";
      text: string;
      /** Screenshot the user explicitly attached to this message. */
      image?: ScreenImage;
      /** "text" = typed by the owner; "voice" = heard through the microphone (may be someone else). Default "text". */
      source?: "text" | "voice";
    }
  /** Reply to `screen_request`. `error: "not_sharing"` when the user has not enabled screen sharing. */
  | { type: "screen_frame"; requestId: string; image?: ScreenImage; error?: "not_sharing" | "failed" }
  /** Periodic frame sent only while the user has "continuous observation" switched on. */
  | { type: "screen_watch"; image: ScreenImage }
  /** The user stroked part of her body with the cursor (she answers with a short in-character reaction). */
  | { type: "touch"; region: TouchRegion }
  /** The user made a hand gesture in front of the camera (recognised on the device; no images are sent). */
  | { type: "gesture"; gesture: Gesture }
  /** The language she should speak aloud from now on (e.g. "ja-JP" with Spanish subtitles); null = the soul's default. */
  | { type: "speech_lang"; lang: string | null }
  /** The user's answer to an `approval_request`. Only answers to pending requests are accepted. */
  | {
      type: "approval_response";
      id: string;
      approved: boolean;
      /**
       * "Darle el control": also approve her next screen actions (clicks, typing, keys) until the activity she is
       * doing now ends. Only honoured on a request marked `controllable`; risky actions still ask.
       */
      control?: boolean;
    }
  /** Takes back the control given with `approval_response.control` (her next screen action asks again). */
  | { type: "control_revoke" }
  /** User started speaking / sent new input while the soul is talking: stop current turn. */
  | { type: "interrupt" }
  | { type: "hello" };

export type ServerMessage =
  | { type: "ready"; soul: { name: string; voice: VoiceHints; names?: import("./names.js").NameConfig; motion?: MotionStyle; look?: LookStyle }; caps: Capabilities }
  /** Streaming token (for text display). */
  | { type: "token"; turnId: number; text: string }
  /**
   * A complete sentence. Sent when the server has NO audio for it (TTS disabled or failed), so the
   * client should speak it itself (browser TTS). Otherwise the sentence arrives as an `audio` message.
   */
  | { type: "sentence"; turnId: number; text: string; emotion: Emotion; /** What to say aloud, if not `text` (e.g. Japanese). */ speech?: string; speechLang?: string }
  /** Synthesized speech for one sentence, in order. `data` is base64. Emotion applies while it plays. */
  | { type: "audio"; turnId: number; seq: number; text: string; emotion: Emotion; mime: string; data: string; /** The words spoken, if not `text` (e.g. Japanese). */ speech?: string }
  /** The soul is running a tool (e.g. querying a public API). For UI feedback only. */
  | { type: "tool"; turnId: number; name: string; status: "start" | "end"; ok?: boolean }
  /** The soul wants to look at the screen (tool call). Client answers with `screen_frame`. */
  | { type: "screen_request"; requestId: string }
  /**
   * The soul wants to do something that changes things outside the conversation (save a file, click, type...).
   * Nothing happens unless the user approves. `details` is plain text (e.g. a diff or a script) to show verbatim.
   */
  | { type: "approval_request"; id: string; tool: string; summary: string; details?: string; preview?: ScreenImage; /** The user may give her control of the screen from this card. */ controllable?: boolean }
  /** She has (or no longer has) control of the screen for the current activity. */
  | { type: "control"; active: boolean }
  /** A pending approval expired or its turn was cancelled: hide it. */
  | { type: "approval_cancel"; id: string }
  | { type: "done"; turnId: number; interrupted: boolean }
  /** Informational message for the user (e.g. "switched to the local brain"); not an error. */
  | { type: "notice"; message: string }
  | { type: "error"; message: string };

export interface Capabilities {
  /** Server synthesizes speech (`audio` messages). */
  tts: boolean;
  /** Server transcribes speech via POST /stt. */
  stt: boolean;
  /** The brain can see images (screen sharing features are offered). */
  vision: boolean;
  /**
   * PRIVACY=local: nothing may leave this computer, so the app must not use the browser's own speech
   * recognition (audio goes to Google/Microsoft) or online browser voices (text goes to them).
   */
  privateMode?: boolean;
}

/**
 * How lively a character's body is (1 = the default, calm). energy: size of sways and gestures; tempo: speed;
 * bounce: 0..1 rocking on the knees even when idle; fidget: 0..1 small spontaneous moves (hand on hip,
 * shoulder roll, torso twist...).
 */
/** How a character's model is drawn. brightness: lit-side brightness of models converted from PBR (1 = as is). */
export interface LookStyle {
  brightness?: number;
}

export interface MotionStyle {
  energy?: number;
  tempo?: number;
  bounce?: number;
  fidget?: number;
  /** 0..1: arms that hang loosely (elbows a little bent, forearms swaying) instead of straight. */
  armRelax?: number;
  /** How much the hips sway and turn (0..1, default 1). Low for a long skirt or coat that would swing around the legs. */
  hipSway?: number;
  /**
   * Her own standing pose (replaces the neutral one): rotation of each body bone from the T-pose, Euler XYZ in
   * radians, VRM 1.0 normalized frame (e.g. converted from a pose file). Breathing, sways and gestures go on top.
   */
  idlePose?: Partial<Record<IdlePoseBone, [number, number, number]>>;
}

export const IDLE_POSE_BONES = [
  "hips", "spine", "chest", "leftShoulder", "rightShoulder", "leftUpperArm", "rightUpperArm", "leftLowerArm", "rightLowerArm",
  "leftHand", "rightHand", "leftUpperLeg", "rightUpperLeg", "leftLowerLeg", "rightLowerLeg",
] as const;
export type IdlePoseBone = (typeof IDLE_POSE_BONES)[number];

export interface VoiceHints {
  /** BCP-47 language tag used for browser STT/TTS, e.g. "es-ES". */
  lang: string;
  pitch: number;
  rate: number;
  /** Voice name/id for the server TTS engine (engine specific). */
  ttsVoice?: string;
  /**
   * Language she SPEAKS in, when different from `lang` (the language of the text and of what she hears).
   * E.g. "ja-JP": she speaks Japanese and her Spanish text is shown as subtitles.
   */
  speechLang?: string;
  /** How to phrase her lines in `speechLang` (character voice notes for the translation). */
  speechStyle?: string;
}

/**
 * Turns started by the soul herself (screen observation) are numbered from this base so they never
 * collide with turns started by the user (turn n = the user's n-th `user_text`).
 */
export const PROACTIVE_TURN_BASE = 1_000_000;

/** Parts of her body the user can stroke with the cursor (or a finger on touch screens). */
export type TouchRegion =
  | "head" | "ears" | "cheeks" | "face" | "hair" | "hands" | "arms" | "shoulders"
  | "chest" | "belly" | "hips" | "legs" | "tail";
export const TOUCH_REGIONS: readonly TouchRegion[] = ["head", "ears", "cheeks", "face", "hair", "hands", "arms", "shoulders", "chest", "belly", "hips", "legs", "tail"];
/** Private areas: she reacts flustered and asks politely to stop (always wholesome). */
export const SENSITIVE_REGIONS: readonly TouchRegion[] = ["chest", "belly", "hips", "legs", "tail"];

/** Hand gestures recognised from the (opt-in) camera. */
export type Gesture = "wave" | "thumbs_up" | "thumbs_down" | "victory" | "love" | "open_palm" | "fist" | "pointing_up";
export const GESTURES: readonly Gesture[] = ["wave", "thumbs_up", "thumbs_down", "victory", "love", "open_palm", "fist", "pointing_up"];

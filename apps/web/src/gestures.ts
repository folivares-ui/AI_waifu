import type { Gesture } from "@waifu/core";

/** MediaPipe's built-in gesture names -> ours. */
export const CANNED: Record<string, Gesture> = {
  Thumb_Up: "thumbs_up",
  Thumb_Down: "thumbs_down",
  Victory: "victory",
  ILoveYou: "love",
  Open_Palm: "open_palm",
  Closed_Fist: "fist",
  Pointing_Up: "pointing_up",
};

export const GESTURE_EMOJI: Record<Gesture, string> = {
  wave: "👋",
  thumbs_up: "👍",
  thumbs_down: "👎",
  victory: "✌️",
  love: "🤟",
  open_palm: "✋",
  fist: "✊",
  pointing_up: "☝️",
};

/**
 * Turns noisy per-frame recognitions into deliberate gestures:
 *  - a gesture counts once it is the top result in most of the recent frames (held ~0.4 s);
 *  - an open hand moving side to side (3+ direction changes) is a wave;
 *  - holding a gesture counts once: it must be released (gone for a moment) before it can count again,
 *    and there is also a short cooldown between gestures.
 */
export class GestureDebouncer {
  private recent: { label?: Gesture; x?: number; t: number }[] = [];
  private lastFired = new Map<Gesture, number>();
  private lastAny = -Infinity;
  /** Gestures fired and still being held (not yet released). */
  private held = new Set<Gesture>();
  private absent = new Map<Gesture, number>();

  constructor(private o = { window: 8, needed: 6, minScore: 0.6, cooldown: 3.5, globalCooldown: 1.2 }) {}

  /** One video frame: the top gesture (if any), its score, the wrist x (0..1) and the time in seconds. */
  push(name: string | undefined, score: number, wristX: number | undefined, t: number): Gesture | undefined {
    const label = name && score >= this.o.minScore ? CANNED[name] : undefined;
    this.recent.push({ label, x: wristX, t });
    // A held gesture is re-armed after ~5 frames without it.
    for (const g of [...this.held]) {
      const n = label === g ? 0 : (this.absent.get(g) ?? 0) + 1;
      this.absent.set(g, n);
      if (n >= 5) this.held.delete(g);
    }
    this.recent = this.recent.filter((f) => t - f.t <= 1.6).slice(-40);

    const wave = this.wave();
    if (wave) return this.fire("wave", t);

    const last = this.recent.slice(-this.o.window);
    if (last.length < this.o.window) return undefined;
    const counts = new Map<Gesture, number>();
    for (const f of last) if (f.label) counts.set(f.label, (counts.get(f.label) ?? 0) + 1);
    for (const [g, n] of counts) if (n >= this.o.needed) return this.fire(g, t);
    return undefined;
  }

  /** Open hand swinging left-right. */
  private wave(): boolean {
    const xs = this.recent.filter((f) => f.label === "open_palm" && f.x !== undefined).map((f) => f.x!);
    if (xs.length < 6) return false;
    if (Math.max(...xs) - Math.min(...xs) < 0.06) return false;
    let reversals = 0;
    let dir = 0;
    for (let i = 1; i < xs.length; i++) {
      const d = xs[i] - xs[i - 1];
      if (Math.abs(d) < 0.01) continue;
      const s = Math.sign(d);
      if (dir && s !== dir) reversals++;
      dir = s;
    }
    return reversals >= 3;
  }

  private fire(g: Gesture, t: number): Gesture | undefined {
    if (this.held.has(g) || (g === "wave" && this.held.has("open_palm"))) return undefined;
    if (t - this.lastAny < this.o.globalCooldown) return undefined;
    if (t - (this.lastFired.get(g) ?? -Infinity) < this.o.cooldown) return undefined;
    this.lastFired.set(g, t);
    this.lastAny = t;
    this.held.add(g === "wave" ? "open_palm" : g);
    this.absent.set(g === "wave" ? "open_palm" : g, 0);
    this.recent = []; // a gesture is consumed
    return g;
  }
}

type Recognizer = {
  recognizeForVideo(v: HTMLVideoElement, ts: number): { gestures: { categoryName: string; score: number }[][]; landmarks: { x: number }[][] };
  close(): void;
};

/**
 * The camera, ONLY while the user has switched it on. Frames are analysed on this device (WebAssembly) and never
 * sent anywhere; only the name of a recognised gesture leaves this module.
 */
export class GestureCamera {
  private stream?: MediaStream;
  private video = document.createElement("video");
  private recognizer?: Recognizer;
  private raf = 0;
  private debouncer = new GestureDebouncer();
  readonly preview = this.video;

  get active() {
    return !!this.stream?.active;
  }

  async start(onGesture: (g: Gesture) => void, onEnded: () => void) {
    // Load the model first, so a missing model never leaves the camera on for nothing.
    if (!this.recognizer) {
      const { FilesetResolver, GestureRecognizer } = await import("@mediapipe/tasks-vision");
      const head = await fetch("/models/gesture_recognizer.task", { method: "HEAD" }).catch(() => undefined);
      if (!head?.ok || head.headers.get("content-type")?.includes("text/html")) {
        throw new Error("Falta el modelo de gestos: ejecuta 'npm run setup:gestures'.");
      }
      const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
      this.recognizer = (await GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "/models/gesture_recognizer.task", delegate: "CPU" },
        runningMode: "VIDEO",
        numHands: 1,
      })) as unknown as Recognizer;
    }
    this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    void this.video.play().catch(() => {});
    this.stream.getVideoTracks()[0].addEventListener("ended", () => {
      this.stop();
      onEnded();
    });
    let lastTs = -1;
    let lastRun = 0;
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (now - lastRun < 66 || this.video.readyState < 2 || !this.recognizer) return; // ~15 analyses per second
      lastRun = now;
      const ts = Math.max(now, lastTs + 1);
      lastTs = ts;
      const r = this.recognizer.recognizeForVideo(this.video, ts);
      const top = r.gestures[0]?.[0];
      const g = this.debouncer.push(top?.categoryName, top?.score ?? 0, r.landmarks[0]?.[0]?.x, now / 1000);
      if (import.meta.env.DEV) {
        const w = window as unknown as { __gestLog?: unknown[] };
        (w.__gestLog ??= []).push({ t: Math.round(now), top: top?.categoryName, score: Number((top?.score ?? 0).toFixed(2)), fired: g });
        if (w.__gestLog.length > 300) w.__gestLog.shift();
      }
      if (g) onGesture(g);
    };
    loop();
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.video.srcObject = null;
  }
}

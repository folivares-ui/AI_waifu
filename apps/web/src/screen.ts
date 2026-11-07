import type { ScreenImage } from "@waifu/core";

/**
 * User-initiated screen sharing through the browser's own picker (getDisplayMedia).
 * The browser/OS shows its sharing indicator and the user chooses the window or screen; we never capture
 * anything unless `start()` was called from a click. Frames live only in memory and are sent to the soul server.
 * Tip for users: share a single WINDOW, not the whole screen, to keep other apps (mail, passwords) out of view.
 */
export class ScreenShare {
  private stream?: MediaStream;
  private video = document.createElement("video");
  private canvas = document.createElement("canvas");
  private thumb = document.createElement("canvas");
  private lastThumb?: Uint8ClampedArray;

  get active(): boolean {
    return !!this.stream?.active;
  }

  static get supported(): boolean {
    return !!navigator.mediaDevices?.getDisplayMedia;
  }

  async start(onEnded: () => void): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    this.stream = stream;
    this.video.srcObject = stream;
    this.video.muted = true;
    // Do not await: playback only resolves once the first frame arrives, and sharing is already granted.
    void this.video.play().catch(() => {});
    // The user can stop sharing from the browser's own bar: reflect that in the UI.
    stream.getVideoTracks()[0].addEventListener("ended", () => {
      this.stop();
      onEnded();
    });
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.video.srcObject = null;
    this.lastThumb = undefined;
  }

  /** Current frame as a downscaled JPEG (long side <= maxSide). Undefined if not sharing / no frame yet. */
  capture(maxSide = 1280, quality = 0.7): ScreenImage | undefined {
    if (!this.active || !this.video.videoWidth) return undefined;
    const scale = Math.min(1, maxSide / Math.max(this.video.videoWidth, this.video.videoHeight));
    const w = Math.round(this.video.videoWidth * scale);
    const h = Math.round(this.video.videoHeight * scale);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.getContext("2d")!.drawImage(this.video, 0, 0, w, h);
    const url = this.canvas.toDataURL("image/jpeg", quality);
    return { data: url.slice(url.indexOf(",") + 1), mime: "image/jpeg", width: w, height: h };
  }

  /**
   * True when the screen changed noticeably since the last call (mean luminance difference on a 48x27 thumbnail).
   * Keeps continuous observation from sending (and paying for) identical frames.
   */
  changed(threshold = 6): boolean {
    if (!this.active || !this.video.videoWidth) return false;
    this.thumb.width = 48;
    this.thumb.height = 27;
    const ctx = this.thumb.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(this.video, 0, 0, 48, 27);
    const px = ctx.getImageData(0, 0, 48, 27).data;
    const prev = this.lastThumb;
    this.lastThumb = px;
    if (!prev) return true; // first frame always counts
    let diff = 0;
    for (let i = 0; i < px.length; i += 4) diff += Math.abs(px[i] - prev[i]) + Math.abs(px[i + 1] - prev[i + 1]) + Math.abs(px[i + 2] - prev[i + 2]);
    return diff / (px.length / 4) / 3 > threshold;
  }
}

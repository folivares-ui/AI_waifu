import { Endpointer, type EndpointEvent } from "@waifu/core";

const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
    }
    return true;
  }
}
registerProcessor("tap", Tap);`;

export interface MicHandle {
  endpointer: Endpointer;
  stop(): void;
}

/**
 * Opens the microphone with the browser's echo cancellation / noise suppression and feeds
 * ~20 ms frames to the endpointer, which reports speech start and finished utterances.
 */
export async function startMic(onEvent: (e: EndpointEvent) => void): Promise<MicHandle> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
  } catch (e) {
    // Some system webviews reject advanced constraints: retry with the bare minimum (permission errors still propagate).
    if (e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "NotFoundError")) throw e;
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  const ctx = new AudioContext();
  const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "tap");
  const endpointer = new Endpointer({ sampleRate: ctx.sampleRate });
  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    for (const ev of endpointer.push(e.data)) onEvent(ev);
  };
  src.connect(node); // not connected to destination: we never play the mic back
  return {
    endpointer,
    stop() {
      node.port.onmessage = null;
      src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

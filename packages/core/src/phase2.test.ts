import { describe, expect, it } from "vitest";
import { Endpointer, encodeWav, looksLikeEcho, prepareForSpeech, resample } from "./index.js";

const SR = 16000;
const tone = (ms: number, amp: number) => {
  const n = (SR * ms) / 1000;
  return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / SR));
};
const feed = (ep: Endpointer, signal: Float32Array, frameMs = 20) => {
  const step = (SR * frameMs) / 1000;
  const ev = [];
  for (let i = 0; i + step <= signal.length; i += step) ev.push(...ep.push(signal.slice(i, i + step)));
  return ev;
};

describe("prepareForSpeech", () => {
  it("removes markdown, emoji, urls and stage directions", () => {
    expect(prepareForSpeech("**Hola** 😊 mira https://x.com/a *sonrie* ok")).toBe("Hola mira enlace ok");
  });
  it("turns newlines into pauses and drops code blocks", () => {
    expect(prepareForSpeech("uno\ndos ```code``` fin")).toBe("uno. dos fin");
  });
});

describe("looksLikeEcho", () => {
  it("flags transcripts made of her own words", () => {
    expect(looksLikeEcho("claro que si te ayudo", ["Claro que si, te ayudo con eso"])).toBe(true);
  });
  it("keeps genuinely new user speech", () => {
    expect(looksLikeEcho("para, cuentame otra cosa distinta", ["Claro que si, te ayudo con eso"])).toBe(false);
  });
});

describe("audio", () => {
  it("encodes a valid 16-bit mono WAV header", () => {
    const w = encodeWav(new Float32Array(100), 16000);
    const v = new DataView(w.buffer);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(40, true)).toBe(200);
    expect(w.length).toBe(244);
  });
  it("resamples to the expected length", () => {
    expect(resample(new Float32Array(48000), 48000, 16000).length).toBe(16000);
  });
});

describe("Endpointer", () => {
  it("emits start then one utterance after silence, with pre-roll", () => {
    const ep = new Endpointer({ sampleRate: SR });
    const sig = new Float32Array([...tone(1000, 0.001), ...tone(800, 0.2), ...tone(1200, 0.001)]);
    const ev = feed(ep, sig);
    expect(ev.map((e) => e.type)).toEqual(["speech_start", "utterance"]);
    const u = ev[1] as Extract<(typeof ev)[number], { type: "utterance" }>;
    expect(u.samples.length / SR).toBeGreaterThan(0.8);
    expect(u.samples.length / SR).toBeLessThan(2.2);
  });
  it("ignores short clicks", () => {
    const ep = new Endpointer({ sampleRate: SR });
    const ev = feed(ep, new Float32Array([...tone(500, 0.001), ...tone(60, 0.3), ...tone(1500, 0.001)]));
    expect(ev.filter((e) => e.type === "utterance")).toEqual([]);
  });
  it("boost raises the bar so quieter (echo-like) sound is ignored", () => {
    const ep = new Endpointer({ sampleRate: SR });
    ep.boost = 4;
    const ev = feed(ep, new Float32Array([...tone(500, 0.001), ...tone(800, 0.04), ...tone(1200, 0.001)]));
    expect(ev).toEqual([]);
  });
  it("marks utterances that started while boosted", () => {
    const ep = new Endpointer({ sampleRate: SR });
    ep.boost = 2;
    const ev = feed(ep, new Float32Array([...tone(500, 0.001), ...tone(800, 0.3), ...tone(1200, 0.001)]));
    expect((ev.find((e) => e.type === "utterance") as any).startedDuringBoost).toBe(true);
  });
});

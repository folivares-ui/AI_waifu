import { describe, expect, it } from "vitest";
import { decodeWav, encodeWav, evenOutSpeech } from "./wav.js";

const tone = (rate: number, seconds: number, amp: number) => Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * 220 * i) / rate));
const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

describe("evening out synthesized speech", () => {
  it("brings a shouted sentence and a quiet one to the same level, without clipping", () => {
    const rate = 24000;
    const loud = evenOutSpeech(encodeWav({ rate, channels: 1, data: tone(rate, 1, 0.98) }));
    const quiet = evenOutSpeech(encodeWav({ rate, channels: 1, data: tone(rate, 1, 0.05) }));
    const a = decodeWav(loud)!.data;
    const b = decodeWav(quiet)!.data;
    expect(Math.abs(rms(a) - rms(b))).toBeLessThan(0.02);
    expect(Math.max(...a.map(Math.abs))).toBeLessThanOrEqual(0.9);
  });
  it("trims the silence before and after the voice (so subtitles and lips start with it)", () => {
    const rate = 16000;
    const data = new Float32Array(rate * 2);
    data.set(tone(rate, 0.5, 0.3), rate * 0.8); // 0.8 s of silence first
    const out = decodeWav(evenOutSpeech(encodeWav({ rate, channels: 1, data })))!;
    expect(out.data.length / rate).toBeLessThan(0.65);
    expect(out.data.length / rate).toBeGreaterThan(0.5);
  });
  it("leaves anything that is not a PCM/float WAV unchanged", () => {
    const mp3 = Buffer.from("ID3 not a wav file at all, just some bytes................................");
    expect(evenOutSpeech(mp3)).toBe(mp3);
  });
});

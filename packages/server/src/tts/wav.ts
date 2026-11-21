/**
 * Evens out synthesized speech (WAV): voice-cloning engines sometimes return a sentence much louder than the rest
 * (it sounds like shouting) or with silence before it starts (the subtitle and the lips start before the voice).
 *
 * - silence at both ends is trimmed (a few ms are kept so words are not clipped);
 * - the loudness of the spoken part is brought to the same level for every sentence;
 * - peaks are softened by a limiter, so no sentence can blast.
 *
 * Handles PCM 16-bit and 32-bit float WAV, any channel count. Anything else is returned unchanged.
 */

const TARGET_RMS = 0.1; // about -20 dBFS: normal speaking level
const MAX_GAIN = 4; // never boost quiet audio more than this (noise)
const CEILING = 0.89; // about -1 dBFS
const SILENCE = 0.008; // below this (about -42 dBFS) counts as silence
const PAD_S = 0.04;

interface Wav {
  rate: number;
  channels: number;
  /** interleaved samples, -1..1 */
  data: Float32Array;
}

function readChunks(buf: Buffer): { fmt?: Buffer; data?: Buffer } {
  const out: { fmt?: Buffer; data?: Buffer } = {};
  let o = 12;
  while (o + 8 <= buf.length) {
    const id = buf.toString("latin1", o, o + 4);
    const size = buf.readUInt32LE(o + 4);
    const body = buf.subarray(o + 8, Math.min(buf.length, o + 8 + size));
    if (id === "fmt ") out.fmt = body;
    if (id === "data") out.data = body;
    o += 8 + size + (size % 2);
  }
  return out;
}

export function decodeWav(buf: Buffer): Wav | undefined {
  if (buf.length < 44 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE") return undefined;
  const { fmt, data } = readChunks(buf);
  if (!fmt || !data || fmt.length < 16) return undefined;
  let format = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const rate = fmt.readUInt32LE(4);
  const bits = fmt.readUInt16LE(14);
  if (format === 0xfffe && fmt.length >= 26) format = fmt.readUInt16LE(24); // WAVE_FORMAT_EXTENSIBLE: real format
  if (format === 1 && bits === 16) {
    const n = Math.floor(data.length / 2);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2) / 32768;
    return { rate, channels, data: out };
  }
  if (format === 3 && bits === 32) {
    const n = Math.floor(data.length / 4);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = data.readFloatLE(i * 4);
    return { rate, channels, data: out };
  }
  return undefined;
}

export function encodeWav(w: Wav): Buffer {
  const n = w.data.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8, "latin1");
  buf.write("fmt ", 12, "latin1");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(w.channels, 22);
  buf.writeUInt32LE(w.rate, 24);
  buf.writeUInt32LE(w.rate * w.channels * 2, 28);
  buf.writeUInt16LE(w.channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "latin1");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, w.data[i])) * 32767), 44 + i * 2);
  return buf;
}

/** Soft limiter: unchanged below the knee, then curves smoothly up to the ceiling (never past it). */
function limit(x: number): number {
  const knee = CEILING * 0.7;
  const a = Math.abs(x);
  if (a <= knee) return x;
  const over = a - knee;
  const room = CEILING - knee;
  return Math.sign(x) * (knee + room * Math.tanh(over / room));
}

export function evenOutSpeech(buf: Buffer): Buffer {
  const w = decodeWav(buf);
  if (!w || w.data.length < w.channels * 32) return buf;
  const { data, channels, rate } = w;
  const frames = data.length / channels;
  // loudness in 10 ms windows: where speech starts and ends, and how loud the spoken part is
  const win = Math.max(1, Math.round(rate * 0.01));
  const rms: number[] = [];
  for (let f = 0; f < frames; f += win) {
    let s = 0;
    let n = 0;
    for (let k = f; k < Math.min(frames, f + win); k++) for (let c = 0; c < channels; c++) {
      const v = data[k * channels + c];
      s += v * v;
      n++;
    }
    rms.push(Math.sqrt(s / (n || 1)));
  }
  const loud = rms.map((r) => r > SILENCE);
  const first = loud.indexOf(true);
  const last = loud.lastIndexOf(true);
  if (first < 0) return buf; // all silence: leave it
  const pad = Math.round(PAD_S * rate);
  const start = Math.max(0, first * win - pad);
  const end = Math.min(frames, (last + 1) * win + pad);
  // level of the spoken windows only (pauses between words would pull it down)
  const spoken = rms.filter((r) => r > SILENCE);
  const level = Math.sqrt(spoken.reduce((s, r) => s + r * r, 0) / spoken.length);
  const gain = Math.min(MAX_GAIN, TARGET_RMS / (level || TARGET_RMS));
  const out = new Float32Array((end - start) * channels);
  for (let i = 0; i < out.length; i++) out[i] = limit(data[start * channels + i] * gain);
  return encodeWav({ rate, channels, data: out });
}

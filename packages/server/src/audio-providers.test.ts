import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ServerMessage } from "@waifu/core";
import type { LLMProvider, LLMRequest } from "./llm/index.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import type { Soul } from "./soul.js";
import { OpenAICompatibleSTT } from "./stt/index.js";
import { CommandTTS, ElevenLabsTTS, OpenAICompatibleTTS, splitCommand, type TTSProvider } from "./tts/index.js";

const servers: Server[] = [];
const listen = (h: Parameters<typeof createServer>[1]) =>
  new Promise<string>((res) => {
    const s = createServer(h).listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${(s.address() as AddressInfo).port}`));
    servers.push(s);
  });
afterAll(() => servers.forEach((s) => s.close()));

describe("OpenAICompatibleTTS", () => {
  it("posts the documented JSON body and returns audio + mime", async () => {
    let seen: any;
    let auth: string | undefined;
    const base = await listen(async (req, res) => {
      auth = req.headers.authorization;
      let b = "";
      for await (const c of req) b += c;
      seen = { url: req.url, body: JSON.parse(b) };
      res.writeHead(200, { "content-type": "audio/mpeg" }).end(Buffer.from([1, 2, 3]));
    });
    const tts = new OpenAICompatibleTTS({ baseUrl: base, apiKey: "k", model: "m", voice: "v", format: "mp3" });
    const out = await tts.synthesize("hola", {});
    expect(seen).toEqual({ url: "/audio/speech", body: { model: "m", voice: "v", input: "hola", response_format: "mp3" } });
    expect(auth).toBe("Bearer k");
    expect(out).toEqual({ audio: Buffer.from([1, 2, 3]), mime: "audio/mpeg" });
  });
  it("throws on HTTP errors", async () => {
    const base = await listen((_q, r) => r.writeHead(500).end("boom"));
    await expect(new OpenAICompatibleTTS({ baseUrl: base, model: "m", voice: "v", format: "mp3" }).synthesize("x", {})).rejects.toThrow(/500/);
  });
});

describe("ElevenLabsTTS", () => {
  it("posts to /v1/text-to-speech/{voice} with xi-api-key and returns mpeg", async () => {
    let seen: any;
    const base = await listen(async (req, res) => {
      let b = "";
      for await (const c of req) b += c;
      seen = { url: req.url, key: req.headers["xi-api-key"], body: JSON.parse(b) };
      res.writeHead(200, { "content-type": "audio/mpeg" }).end(Buffer.from([9, 9]));
    });
    const tts = new ElevenLabsTTS({ apiKey: "KEY", model: "m1", voice: "vA", baseUrl: base, outputFormat: "mp3_44100_128" });
    const out = await tts.synthesize("hola", { voice: "vB" });
    expect(seen.url).toBe("/v1/text-to-speech/vB?output_format=mp3_44100_128");
    expect(seen.key).toBe("KEY");
    expect(seen.body).toMatchObject({ text: "hola", model_id: "m1" });
    expect(out.mime).toBe("audio/mpeg");
  });
  it("requires a voice id", async () => {
    const tts = new ElevenLabsTTS({ apiKey: "k", model: "m", baseUrl: "http://127.0.0.1:1", outputFormat: "x" });
    await expect(tts.synthesize("x", {})).rejects.toThrow(/voice id/);
  });
});

describe("OpenAICompatibleSTT", () => {
  it("sends multipart file/model/language and parses text", async () => {
    let ct = "";
    let raw = "";
    const base = await listen(async (req, res) => {
      ct = String(req.headers["content-type"]);
      for await (const c of req) raw += c.toString("latin1");
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: " hola mundo " }));
    });
    const text = await new OpenAICompatibleSTT({ baseUrl: base, model: "whisper-x" }).transcribe(Buffer.from("RIFFxxxx"), "audio/wav", { lang: "es-ES" });
    expect(text).toBe("hola mundo");
    expect(ct).toMatch(/^multipart\/form-data/);
    expect(raw).toContain('name="model"');
    expect(raw).toContain("whisper-x");
    expect(raw).toContain('name="language"');
    expect(raw).toMatch(/\r\nes\r\n/);
    expect(raw).toContain('filename="audio.wav"');
  });
});

describe("CommandTTS", () => {
  it("splits quoted arguments", () => {
    expect(splitCommand('piper --model "/a b/c.onnx" --output_file {out}')).toEqual(["piper", "--model", "/a b/c.onnx", "--output_file", "{out}"]);
  });
  it("feeds text on stdin and reads the wav written to {out}", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fake-"));
    const script = join(dir, "fake tts.sh"); // space in path on purpose
    writeFileSync(script, '#!/bin/sh\nout="$1"\ncat > "$out.txt"\nprintf "RIFFfake:" > "$out"\ncat "$out.txt" >> "$out"\n');
    chmodSync(script, 0o755);
    const r = await new CommandTTS(`"${script}" {out}`).synthesize("hola", {});
    expect(r.mime).toBe("audio/wav");
    expect(r.audio.toString()).toBe("RIFFfake:hola\n");
  });
  it("reports non-zero exit codes", async () => {
    await expect(new CommandTTS("false").synthesize("x", {})).rejects.toThrow(/exited 1/);
  });
});

// ---- Session audio ordering / fallback ------------------------------------------------------
const soul: Soul = { name: "T", language: "es-ES", voice: { lang: "es-ES", pitch: 1, rate: 1, ttsVoice: "vv" }, persona: "p", boundaries: "" };
class Scripted implements LLMProvider {
  name = "s";
  constructor(private text: string) {}
  async *stream(req: LLMRequest): AsyncGenerator<string> {
    if (req.system.includes("Return ONLY a JSON array")) return yield "[]";
    yield this.text;
  }
}
const mem = () => new MemoryStore(join(mkdtempSync(join(tmpdir(), "mem-")), "m.json"));
const doneOf = (out: ServerMessage[]) => out.some((m) => m.type === "done");
const until = async (c: () => boolean) => { for (let i = 0; i < 300 && !c(); i++) await new Promise((r) => setTimeout(r, 10)); };

describe("Session with TTS", () => {
  it("delivers audio in sentence order even if later sentences synthesize faster, and cleans text", async () => {
    const calls: { text: string; voice?: string }[] = [];
    const tts: TTSProvider = {
      name: "fake",
      async synthesize(text, opts) {
        calls.push({ text, voice: opts.voice });
        await new Promise((r) => setTimeout(r, text.startsWith("Uno") ? 80 : 5)); // first is slowest
        return { audio: Buffer.from(text), mime: "audio/wav" };
      },
    };
    const out: ServerMessage[] = [];
    const s = new Session(soul, new Scripted("Uno **grande**. Dos 😊. Tres."), mem(), (m) => out.push(m), tts);
    s.handle({ type: "user_text", text: "x" });
    await until(() => doneOf(out));
    const audios = out.filter((m) => m.type === "audio") as Extract<ServerMessage, { type: "audio" }>[];
    expect(audios.map((a) => a.seq)).toEqual([0, 1, 2]);
    expect(audios.map((a) => Buffer.from(a.data, "base64").toString())).toEqual(["Uno grande.", "Dos.", "Tres."]);
    expect(calls.every((c) => c.voice === "vv")).toBe(true);
    expect(out.findIndex((m) => m.type === "done")).toBeGreaterThan(out.findLastIndex((m) => m.type === "audio"));
  });

  it("falls back to a plain sentence (browser voice) when TTS fails", async () => {
    const tts: TTSProvider = { name: "bad", synthesize: async () => { throw new Error("down"); } };
    const out: ServerMessage[] = [];
    new Session(soul, new Scripted("Hola."), mem(), (m) => out.push(m), tts).handle({ type: "user_text", text: "x" });
    await until(() => doneOf(out));
    expect(out.some((m) => m.type === "error")).toBe(true);
    expect(out.filter((m) => m.type === "sentence")).toHaveLength(1);
    expect(out.some((m) => m.type === "audio")).toBe(false);
  });

  it("advertises capabilities in ready", () => {
    const out: ServerMessage[] = [];
    new Session(soul, new Scripted(""), mem(), (m) => out.push(m), undefined, { tts: false, stt: true }).hello();
    expect(out[0]).toMatchObject({ type: "ready", caps: { tts: false, stt: true } });
  });
});

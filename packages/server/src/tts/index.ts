import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TTSOptions {
  voice?: string;
  lang?: string;
}
export interface TTSResult {
  audio: Buffer;
  mime: string;
}
export interface TTSProvider {
  readonly name: string;
  synthesize(text: string, opts: TTSOptions, signal?: AbortSignal): Promise<TTSResult>;
}

/**
 * Any server exposing the OpenAI-style `POST {base}/audio/speech` endpoint
 * (OpenAI itself, or local servers that copy that API). Quality = whatever engine is behind it.
 */
export class OpenAICompatibleTTS implements TTSProvider {
  readonly name = "openai-compatible";
  constructor(
    private o: { baseUrl: string; apiKey?: string; model: string; voice: string; format: "mp3" | "wav" | "opus" | "flac" },
  ) {}

  async synthesize(text: string, opts: TTSOptions, signal?: AbortSignal): Promise<TTSResult> {
    const res = await fetch(`${this.o.baseUrl.replace(/\/$/, "")}/audio/speech`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.o.model, voice: opts.voice ?? this.o.voice, input: text, response_format: this.o.format }),
    });
    if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const mimes = { mp3: "audio/mpeg", wav: "audio/wav", opus: "audio/ogg", flac: "audio/flac" } as const;
    return { audio: Buffer.from(await res.arrayBuffer()), mime: mimes[this.o.format] };
  }
}

/**
 * ElevenLabs text-to-speech: POST {base}/v1/text-to-speech/{voice_id}?output_format=... with an `xi-api-key` header.
 * Written from my recollection of their public API; I could not reach their docs from the dev sandbox, so run
 * `npm run tts:test -w @waifu/server` with your key and check their current docs if anything is rejected.
 * The voice id comes from your ElevenLabs voice library (TTS_VOICE or soul.voice.ttsVoice).
 */
export class ElevenLabsTTS implements TTSProvider {
  readonly name = "elevenlabs";
  constructor(
    private o: { apiKey: string; model: string; voice?: string; baseUrl: string; outputFormat: string; stability?: number; similarity?: number },
  ) {}

  async synthesize(text: string, opts: TTSOptions, signal?: AbortSignal): Promise<TTSResult> {
    const voice = opts.voice ?? this.o.voice;
    if (!voice) throw new Error("ElevenLabs needs a voice id: set TTS_VOICE or soul.voice.ttsVoice");
    const url = `${this.o.baseUrl.replace(/\/$/, "")}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${encodeURIComponent(this.o.outputFormat)}`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "xi-api-key": this.o.apiKey },
      body: JSON.stringify({
        text,
        model_id: this.o.model,
        voice_settings: { stability: this.o.stability ?? 0.5, similarity_boost: this.o.similarity ?? 0.75 },
      }),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return { audio: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg" };
  }
}

/** Splits a command line into argv, honoring simple "double quotes". */
export function splitCommand(cmd: string): string[] {
  return [...cmd.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

/**
 * Runs a local program that reads text on stdin and writes a WAV file to the path substituted for `{out}`.
 * Fits local engines such as Piper. Example:
 *   TTS_COMMAND='piper --model "/models/es_ES-davefx-medium.onnx" --output_file {out}'
 * (exact flags depend on your engine/version: check its docs). No shell is used.
 */
export class CommandTTS implements TTSProvider {
  readonly name = "command";
  constructor(private command: string) {}

  async synthesize(text: string, _opts: TTSOptions, signal?: AbortSignal): Promise<TTSResult> {
    const dir = await mkdtemp(join(tmpdir(), "tts-"));
    const out = join(dir, "out.wav");
    try {
      const [bin, ...args] = splitCommand(this.command).map((a) => a.replaceAll("{out}", out));
      await new Promise<void>((resolve, reject) => {
        const p = spawn(bin, args, { stdio: ["pipe", "ignore", "pipe"], signal });
        let err = "";
        p.stderr.on("data", (d) => (err += d));
        p.on("error", reject);
        p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`TTS command exited ${code}: ${err.slice(-200)}`))));
        p.stdin.on("error", () => {});
        p.stdin.end(text + "\n");
      });
      return { audio: await readFile(out), mime: "audio/wav" };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export function createTTS(env: NodeJS.ProcessEnv = process.env): TTSProvider | undefined {
  const kind = env.TTS_PROVIDER ?? "none";
  switch (kind) {
    case "none":
      return undefined; // client falls back to the browser's built-in voices
    case "openai":
      return new OpenAICompatibleTTS({
        baseUrl: env.TTS_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: env.TTS_API_KEY,
        model: env.TTS_MODEL ?? "tts-1",
        voice: env.TTS_VOICE ?? "alloy",
        format: (env.TTS_FORMAT as "mp3") ?? "mp3",
      });
    case "elevenlabs":
      if (!env.TTS_API_KEY) throw new Error("TTS_PROVIDER=elevenlabs requires TTS_API_KEY");
      return new ElevenLabsTTS({
        apiKey: env.TTS_API_KEY,
        model: env.TTS_MODEL ?? "eleven_multilingual_v2",
        voice: env.TTS_VOICE,
        baseUrl: env.TTS_BASE_URL ?? "https://api.elevenlabs.io",
        outputFormat: env.TTS_FORMAT ?? "mp3_44100_128",
      });
    case "command":
      if (!env.TTS_COMMAND) throw new Error("TTS_PROVIDER=command requires TTS_COMMAND");
      return new CommandTTS(env.TTS_COMMAND);
    default:
      throw new Error(`Unknown TTS_PROVIDER "${kind}" (use none | openai | elevenlabs | command)`);
  }
}

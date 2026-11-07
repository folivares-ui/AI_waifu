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
    case "command":
      if (!env.TTS_COMMAND) throw new Error("TTS_PROVIDER=command requires TTS_COMMAND");
      return new CommandTTS(env.TTS_COMMAND);
    default:
      throw new Error(`Unknown TTS_PROVIDER "${kind}" (use none | openai | command)`);
  }
}

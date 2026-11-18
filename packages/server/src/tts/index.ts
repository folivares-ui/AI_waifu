import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Turns Node's bare "fetch failed" into something a person can act on. */
export function reachError(url: string, e: unknown): Error {
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  return new Error(`cannot reach ${new URL(url).origin}${code ? ` (${code})` : ""}: is the voice server (e.g. VoiceStudio) running?`);
}

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
  readonly name: string;
  constructor(
    private o: {
      baseUrl: string;
      apiKey?: string;
      model: string;
      voice: string;
      format: "mp3" | "wav" | "opus" | "flac";
      /**
       * Extra `language` field (ISO 639-1). Not part of OpenAI's spec, but servers such as VoiceStudio accept it.
       * "auto" = the soul's language; a code = that language; undefined = not sent.
       */
      language?: string;
      /** Optional voice-style instructions (`instructions` field), e.g. "warm, shy, soft-spoken". */
      instructions?: string;
      name?: string;
    },
  ) {
    this.name = o.name ?? "openai-compatible";
  }

  async synthesize(text: string, opts: TTSOptions, signal?: AbortSignal): Promise<TTSResult> {
    const url = `${this.o.baseUrl.replace(/\/$/, "")}/audio/speech`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", ...(this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.o.model,
        voice: opts.voice ?? this.o.voice,
        input: text,
        response_format: this.o.format,
        ...(this.language(opts) ? { language: this.language(opts) } : {}),
        ...(this.o.instructions ? { instructions: this.o.instructions } : {}),
      }),
    }).catch((e) => {
      throw signal?.aborted ? e : reachError(url, e);
    });
    if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const mimes = { mp3: "audio/mpeg", wav: "audio/wav", opus: "audio/ogg", flac: "audio/flac" } as const;
    return { audio: Buffer.from(await res.arrayBuffer()), mime: mimes[this.o.format] };
  }

  private language(opts: TTSOptions): string | undefined {
    if (!this.o.language) return undefined;
    return (this.o.language === "auto" ? opts.lang : this.o.language)?.slice(0, 2).toLowerCase() || undefined;
  }
}

/**
 * ElevenLabs text-to-speech: POST {base}/v1/text-to-speech/{voice_id}?output_format=... with an `xi-api-key` header.
 * Written from my recollection of their public API; I could not reach their docs from the dev sandbox, so run
 * `npm run tts:test -w @waifu/server` with your key and check their current docs if anything is rejected.
 * The voice id comes from your ElevenLabs voice library (TTS_VOICE or soul.voice.ttsVoice).
 */
/**
 * VoiceStudio: its speech endpoint expects a saved voice PROFILE ID, while the soul names the voice ("Rice Shower").
 * The name is looked up in GET /profiles (cached for a minute, so a voice created later is found). An unknown name
 * is reported clearly instead of silently getting VoiceStudio's default voice.
 */
export class VoiceStudioTTS extends OpenAICompatibleTTS {
  private profiles?: { at: number; list: { id: string; name: string }[] | undefined };
  constructor(
    private vs: ConstructorParameters<typeof OpenAICompatibleTTS>[0],
    private fetchProfiles: (root: string) => Promise<{ id: string; name: string }[] | undefined> = defaultProfiles,
    private now: () => number = Date.now,
  ) {
    super(vs);
  }

  private async list() {
    if (!this.profiles || this.now() - this.profiles.at > 60_000) {
      this.profiles = { at: this.now(), list: await this.fetchProfiles(this.root()).catch(() => undefined) };
    }
    return this.profiles.list;
  }

  async resolveVoice(voice: string | undefined): Promise<string | undefined> {
    if (!voice || voice === "default") return voice;
    const list = await this.list();
    if (!list) return voice; // this VoiceStudio version has no /profiles: send it as given
    const found = list.find((p) => String(p.id) === voice) ?? list.find((p) => String(p.name).toLowerCase() === voice.toLowerCase());
    if (found) return String(found.id);
    const names = list.map((p) => `"${p.name}"`).join(", ") || "ninguna";
    throw new Error(
      `VoiceStudio no tiene una voz llamada "${voice}" (voces guardadas: ${names}). Carga su muestra .wav en Ajustes > "Voz de..." de la app y se creara sola.`,
    );
  }

  /**
   * Makes sure VoiceStudio has a cloned voice called `name`, creating it from `wav` if missing (POST /profiles,
   * the same fields as scripts/voicestudio-voice.mjs). An existing voice with that name is never replaced.
   */
  async ensureProfile(name: string, wav: Buffer, opts: { refText?: string; language?: string } = {}): Promise<{ status: "exists" | "created"; id: string } | { status: "unreachable" }> {
    this.profiles = undefined;
    const list = await this.list();
    if (!list) return { status: "unreachable" };
    const found = list.find((p) => String(p.name).toLowerCase() === name.toLowerCase());
    if (found) return { status: "exists", id: String(found.id) };
    const form = new FormData();
    form.append("name", name);
    form.append("kind", "clone");
    form.append("language", opts.language ?? "Auto");
    form.append("ref_text", opts.refText ?? "");
    form.append("ref_audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice-ref.wav");
    const res = await fetch(`${this.root()}/profiles`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`VoiceStudio no pudo crear la voz (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const created = (await res.json()) as { id: string };
    this.profiles = undefined;
    return { status: "created", id: String(created.id) };
  }

  private root() {
    return this.vs.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  }

  async synthesize(text: string, opts: TTSOptions, signal?: AbortSignal): Promise<TTSResult> {
    const voice = await this.resolveVoice(opts.voice ?? this.vs.voice);
    return super.synthesize(text, { ...opts, voice }, signal);
  }
}

async function defaultProfiles(root: string): Promise<{ id: string; name: string }[] | undefined> {
  const res = await fetch(`${root}/profiles`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) return undefined;
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as { id: string; name: string }[]) : undefined;
}

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
        language: env.TTS_LANGUAGE,
        instructions: env.TTS_INSTRUCTIONS,
      });
    case "voicestudio":
      // VoiceStudio (https://github.com/debpalash/VoiceStudio) running on this machine: its OpenAI-compatible API.
      // Loopback calls need no key; "tts-1" is an alias for its active engine; "default" = its default voice
      // (set TTS_VOICE or soul.voice.ttsVoice to a saved VoiceStudio voice profile ID or name).
      return new VoiceStudioTTS({
        name: "voicestudio",
        baseUrl: env.TTS_BASE_URL ?? "http://localhost:3900/v1",
        apiKey: env.TTS_API_KEY,
        model: env.TTS_MODEL ?? "tts-1",
        voice: env.TTS_VOICE ?? "default",
        format: (env.TTS_FORMAT as "wav") ?? "wav",
        language: env.TTS_LANGUAGE ?? "auto",
        instructions: env.TTS_INSTRUCTIONS,
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
      throw new Error(`Unknown TTS_PROVIDER "${kind}" (use none | voicestudio | openai | elevenlabs | command)`);
  }
}

import { reachError } from "../tts/index.js";

export interface STTProvider {
  readonly name: string;
  /** `prompt`: words to help spell names right (Whisper-style "prompt"). */
  transcribe(audio: Buffer, mime: string, opts: { lang?: string; prompt?: string }, signal?: AbortSignal): Promise<string>;
}

/**
 * OpenAI-style `POST {base}/audio/transcriptions` (multipart: file, model, language).
 * Works with OpenAI or any local Whisper server that implements the same endpoint.
 */
export class OpenAICompatibleSTT implements STTProvider {
  readonly name: string;
  constructor(private o: { baseUrl: string; apiKey?: string; model: string; name?: string }) {
    this.name = o.name ?? "openai-compatible";
  }

  async transcribe(audio: Buffer, mime: string, opts: { lang?: string; prompt?: string }, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), mime.includes("wav") ? "audio.wav" : "audio.webm");
    form.append("model", this.o.model);
    if (opts.lang) form.append("language", opts.lang.slice(0, 2)); // ISO-639-1
    if (opts.prompt) form.append("prompt", opts.prompt.slice(0, 400));
    const url = `${this.o.baseUrl.replace(/\/$/, "")}/audio/transcriptions`;
    const res = await fetch(url, {
      method: "POST",
      signal,
      headers: this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {},
      body: form,
    }).catch((e) => {
      throw signal?.aborted ? e : reachError(url, e);
    });
    if (!res.ok) throw new Error(`STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = (await res.json()) as { text?: string };
    return (json.text ?? "").trim();
  }
}

export function createSTT(env: NodeJS.ProcessEnv = process.env): STTProvider | undefined {
  const kind = env.STT_PROVIDER ?? "none";
  switch (kind) {
    case "none":
      return undefined; // client falls back to the browser's Web Speech API
    case "openai":
      return new OpenAICompatibleSTT({
        baseUrl: env.STT_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: env.STT_API_KEY,
        model: env.STT_MODEL ?? "whisper-1",
      });
    case "voicestudio":
      // VoiceStudio's OpenAI-compatible transcription on this machine ("whisper-1" = its active speech-to-text engine).
      return new OpenAICompatibleSTT({
        name: "voicestudio",
        baseUrl: env.STT_BASE_URL ?? "http://localhost:3900/v1",
        apiKey: env.STT_API_KEY,
        model: env.STT_MODEL ?? "whisper-1",
      });
    default:
      throw new Error(`Unknown STT_PROVIDER "${kind}" (use none | voicestudio | openai)`);
  }
}

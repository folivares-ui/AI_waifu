export interface STTProvider {
  readonly name: string;
  transcribe(audio: Buffer, mime: string, opts: { lang?: string }, signal?: AbortSignal): Promise<string>;
}

/**
 * OpenAI-style `POST {base}/audio/transcriptions` (multipart: file, model, language).
 * Works with OpenAI or any local Whisper server that implements the same endpoint.
 */
export class OpenAICompatibleSTT implements STTProvider {
  readonly name = "openai-compatible";
  constructor(private o: { baseUrl: string; apiKey?: string; model: string }) {}

  async transcribe(audio: Buffer, mime: string, opts: { lang?: string }, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), mime.includes("wav") ? "audio.wav" : "audio.webm");
    form.append("model", this.o.model);
    if (opts.lang) form.append("language", opts.lang.slice(0, 2)); // ISO-639-1
    const res = await fetch(`${this.o.baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST",
      signal,
      headers: this.o.apiKey ? { authorization: `Bearer ${this.o.apiKey}` } : {},
      body: form,
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
    default:
      throw new Error(`Unknown STT_PROVIDER "${kind}" (use none | openai)`);
  }
}

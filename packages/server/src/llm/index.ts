import { AnthropicProvider } from "./anthropic.js";
import { FallbackProvider, type FallbackOptions } from "./fallback.js";
import { MockProvider } from "./mock.js";
import { OllamaProvider } from "./ollama.js";
import type { LLMProvider } from "./types.js";

export * from "./types.js";
export { FallbackProvider } from "./fallback.js";

function createOne(kind: string, env: NodeJS.ProcessEnv): LLMProvider {
  switch (kind) {
    case "anthropic":
      if (!env.ANTHROPIC_API_KEY) throw new Error("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
      return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5");
    case "ollama":
      return new OllamaProvider(env.OLLAMA_MODEL ?? "qwen2.5:3b", env.OLLAMA_HOST, env.OLLAMA_VISION === "1", Number(env.OLLAMA_NUM_CTX ?? 8192), env.OLLAMA_TOOLS !== "0");
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`Unknown LLM provider "${kind}" (use anthropic | ollama | mock)`);
  }
}

/**
 * The brain from LLM_PROVIDER. With LLM_FALLBACK (e.g. LLM_PROVIDER=anthropic, LLM_FALLBACK=ollama) she switches
 * to the backup when the main one fails (tokens used up, rate limit, no internet) and retries the main one after
 * LLM_FALLBACK_RETRY_MIN minutes.
 */
export function createLLM(env: NodeJS.ProcessEnv = process.env, onSwitch?: FallbackOptions["onSwitch"]): LLMProvider {
  const kind = env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : "mock");
  const primary = createOne(kind, env);
  const backup = env.LLM_FALLBACK;
  if (!backup || backup === kind) return primary;
  return new FallbackProvider(primary, createOne(backup, env), { retryMs: Number(env.LLM_FALLBACK_RETRY_MIN ?? 15) * 60_000, onSwitch });
}

import { AnthropicProvider } from "./anthropic.js";
import { MockProvider } from "./mock.js";
import { OllamaProvider } from "./ollama.js";
import type { LLMProvider } from "./types.js";

export * from "./types.js";

export function createLLM(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const kind = env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : "mock");
  switch (kind) {
    case "anthropic":
      if (!env.ANTHROPIC_API_KEY) throw new Error("LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY");
      return new AnthropicProvider(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5");
    case "ollama":
      return new OllamaProvider(env.OLLAMA_MODEL ?? "llama3.1", env.OLLAMA_HOST);
    case "mock":
      return new MockProvider();
    default:
      throw new Error(`Unknown LLM_PROVIDER "${kind}" (use anthropic | ollama | mock)`);
  }
}

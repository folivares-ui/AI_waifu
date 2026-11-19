import { isLoopbackHost } from "./auth.js";

/**
 * PRIVACY=local: nothing you say, type, show or own leaves this computer.
 * Returns what is configured against that (empty = OK). The server refuses to start until it is fixed.
 */
export function privacyProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  if ((env.PRIVACY ?? "").toLowerCase() !== "local") return [];
  const out: string[] = [];
  const local = (url: string | undefined, fallback: string) => {
    try {
      return isLoopbackHost(new URL(url || fallback).host);
    } catch {
      return false;
    }
  };
  const brains = [env.LLM_PROVIDER ?? (env.ANTHROPIC_API_KEY ? "anthropic" : "mock"), env.LLM_FALLBACK].filter(Boolean) as string[];
  for (const b of brains) {
    if (b === "anthropic") out.push("El cerebro es Claude (en internet). Usa LLM_PROVIDER=ollama y deja LLM_FALLBACK vacio.");
    if (b === "ollama" && !local(env.OLLAMA_HOST, "http://localhost:11434")) out.push("OLLAMA_HOST no es este equipo.");
  }
  const tts = env.TTS_PROVIDER ?? "none";
  if (tts === "elevenlabs") out.push("La voz es ElevenLabs (en internet). Usa TTS_PROVIDER=voicestudio o none.");
  if ((tts === "openai" || tts === "voicestudio") && !local(env.TTS_BASE_URL, tts === "openai" ? "https://api.openai.com/v1" : "http://localhost:3900/v1")) out.push("TTS_BASE_URL no es este equipo.");
  const stt = env.STT_PROVIDER ?? "none";
  if ((stt === "openai" || stt === "voicestudio") && !local(env.STT_BASE_URL, stt === "openai" ? "https://api.openai.com/v1" : "http://localhost:3900/v1")) out.push("STT_BASE_URL no es este equipo.");
  const tools = (env.TOOLS ?? "").split(",").map((t) => t.trim());
  if (tools.includes("browser")) out.push("La herramienta browser abre paginas de internet. Quitala de TOOLS.");
  if (tools.includes("public_apis")) out.push("La herramienta public_apis consulta APIs de internet. Quitala de TOOLS.");
  const host = env.HOST ?? "127.0.0.1";
  if (!isLoopbackHost(host) ) out.push("HOST permite conexiones desde otros equipos. Usa HOST=127.0.0.1.");
  return out;
}

export const privateMode = (env: NodeJS.ProcessEnv = process.env) => (env.PRIVACY ?? "").toLowerCase() === "local";

import { describe, expect, it } from "vitest";
import { privacyProblems } from "./privacy.js";

describe("PRIVACY=local", () => {
  it("does nothing unless asked for", () => {
    expect(privacyProblems({ LLM_PROVIDER: "anthropic", TOOLS: "browser" })).toEqual([]);
  });
  it("accepts a fully local setup", () => {
    expect(privacyProblems({ PRIVACY: "local", LLM_PROVIDER: "ollama", TTS_PROVIDER: "voicestudio", STT_PROVIDER: "voicestudio", TOOLS: "files,vscode,blender,desktop,screen" })).toEqual([]);
  });
  it("lists everything that would send data outside this computer", () => {
    const p = privacyProblems({
      PRIVACY: "local",
      LLM_PROVIDER: "anthropic",
      LLM_FALLBACK: "ollama",
      OLLAMA_HOST: "http://192.168.1.20:11434",
      TTS_PROVIDER: "elevenlabs",
      STT_PROVIDER: "openai",
      TOOLS: "files,browser,public_apis",
      HOST: "0.0.0.0",
    });
    expect(p.join("\n")).toMatch(/Claude/);
    expect(p.join("\n")).toMatch(/OLLAMA_HOST/);
    expect(p.join("\n")).toMatch(/ElevenLabs/);
    expect(p.join("\n")).toMatch(/STT_BASE_URL/);
    expect(p.join("\n")).toMatch(/browser/);
    expect(p.join("\n")).toMatch(/public_apis/);
    expect(p.join("\n")).toMatch(/HOST/);
  });
  it("a VoiceStudio on another computer is not local", () => {
    expect(privacyProblems({ PRIVACY: "local", LLM_PROVIDER: "ollama", TTS_PROVIDER: "voicestudio", TTS_BASE_URL: "http://10.0.0.5:3900/v1" })).toEqual(["TTS_BASE_URL no es este equipo."]);
  });
});

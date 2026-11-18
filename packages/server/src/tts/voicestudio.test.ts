import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { VoiceStudioTTS } from "./index.js";

const base = { name: "voicestudio", baseUrl: "http://127.0.0.1:1/v1", model: "tts-1", voice: "default", format: "wav" as const };

describe("VoiceStudio voice by name", () => {
  it("turns the soul's voice name into the saved profile ID (any capitalisation)", async () => {
    const t = new VoiceStudioTTS(base, async () => [{ id: "p_42", name: "Rice Shower" }]);
    expect(await t.resolveVoice("rice shower")).toBe("p_42");
    expect(await t.resolveVoice("p_42")).toBe("p_42");
    expect(await t.resolveVoice("default")).toBe("default");
  });
  it("says clearly when the voice was never created, instead of using another voice", async () => {
    const t = new VoiceStudioTTS(base, async () => [{ id: "a1", name: "Narrador" }]);
    await expect(t.resolveVoice("Rice Shower")).rejects.toThrow(/no tiene una voz llamada "Rice Shower" \(voces guardadas: "Narrador"\).*voice:create/);
  });
  it("finds a voice created after start-up (list refreshed every minute)", async () => {
    let now = 0;
    let list = [] as { id: string; name: string }[];
    const t = new VoiceStudioTTS(base, async () => list, () => now);
    await expect(t.resolveVoice("Rice Shower")).rejects.toThrow();
    list = [{ id: "new", name: "Rice Shower" }];
    now = 61_000;
    expect(await t.resolveVoice("Rice Shower")).toBe("new");
  });
  it("sends the ID to /v1/audio/speech", async () => {
    const bodies: any[] = [];
    const srv = createServer((req, res) => {
      if (req.url === "/profiles") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{ id: "p_7", name: "Rice Shower" }]));
      let b = "";
      req.on("data", (c) => (b += c)).on("end", () => { bodies.push({ url: req.url, ...JSON.parse(b) }); res.writeHead(200).end("RIFF"); });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const t = new VoiceStudioTTS({ ...base, baseUrl: `http://127.0.0.1:${port}/v1` });
    await t.synthesize("Hola, Onii-sama", { voice: "Rice Shower", lang: "es-ES" });
    srv.close();
    expect(bodies[0]).toMatchObject({ url: "/v1/audio/speech", voice: "p_7", input: "Hola, Onii-sama" });
  });
});

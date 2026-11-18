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
    await expect(t.resolveVoice("Rice Shower")).rejects.toThrow(/no tiene una voz llamada "Rice Shower" \(voces guardadas: "Narrador"\).*Ajustes/);
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

describe("creating Rice's voice automatically", () => {
  it("creates the profile from the saved sample once, then reuses it", async () => {
    const profiles: { id: string; name: string }[] = [];
    let posted = "";
    const srv = createServer((req, res) => {
      if (req.url === "/profiles" && req.method === "GET") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(profiles));
      let b = "";
      req.setEncoding("latin1");
      req.on("data", (c) => (b += c)).on("end", () => {
        posted = b;
        profiles.push({ id: "p_new", name: "Rice Shower" });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "p_new", name: "Rice Shower" }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const t = new VoiceStudioTTS({ ...base, baseUrl: `http://127.0.0.1:${port}/v1` });
    const wav = Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt "), Buffer.alloc(64)]);
    expect(await t.ensureProfile("Rice Shower", wav)).toEqual({ status: "created", id: "p_new" });
    expect(posted).toMatch(/name="name"\r\n\r\nRice Shower/);
    expect(posted).toMatch(/name="kind"\r\n\r\nclone/);
    expect(posted).toMatch(/name="ref_audio"; filename="voice-ref.wav"/);
    expect(await t.ensureProfile("rice shower", wav)).toEqual({ status: "exists", id: "p_new" });
    expect(await t.resolveVoice("Rice Shower")).toBe("p_new");
    srv.close();
    expect(await new VoiceStudioTTS(base).ensureProfile("Rice Shower", wav)).toEqual({ status: "unreachable" });
  });
});

describe("a busy GPU (HTTP 429)", () => {
  it("sends one sentence at a time and retries when VoiceStudio is busy, keeping every sentence", async () => {
    let running = 0;
    let maxRunning = 0;
    let refusals = 0;
    const said: string[] = [];
    const srv = createServer((req, res) => {
      if (req.url === "/profiles") return void res.writeHead(404).end();
      let b = "";
      req.on("data", (c) => (b += c)).on("end", () => {
        const { input } = JSON.parse(b);
        if (refusals < 2 && input === "dos") {
          refusals++;
          return void res.writeHead(429, { "content-type": "application/json" }).end('{"error":{"message":"the local GPU worker pool is saturated"}}');
        }
        running++;
        maxRunning = Math.max(maxRunning, running);
        setTimeout(() => {
          running--;
          said.push(input);
          res.writeHead(200).end("RIFF");
        }, 30);
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const t = new VoiceStudioTTS({ ...base, baseUrl: `http://127.0.0.1:${port}/v1` });
    t.retryDelaysMs = [10, 10, 10];
    const all = await Promise.allSettled(["uno", "dos", "tres"].map((x) => t.synthesize(x, {})));
    srv.close();
    expect(all.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(maxRunning).toBe(1);
    expect(refusals).toBe(2);
    expect(said).toEqual(["uno", "dos", "tres"]);
  });
  it("gives up after the retries and reports the error (that sentence uses the browser voice)", async () => {
    const srv = createServer((req, res) => (req.url === "/profiles" ? res.writeHead(404).end() : res.writeHead(429).end("busy")));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const t = new VoiceStudioTTS({ ...base, baseUrl: `http://127.0.0.1:${(srv.address() as { port: number }).port}/v1` });
    t.retryDelaysMs = [5, 5];
    await expect(t.synthesize("x", {})).rejects.toThrow(/TTS 429/);
    srv.close();
  });
});

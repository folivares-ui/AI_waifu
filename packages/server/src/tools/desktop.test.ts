import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DesktopClient, createDesktopTools } from "./desktop.js";
import type { Tool } from "./types.js";

/** Fake of the desktop shell endpoint: a 2560x1440 monitor at x=1920 (second screen), sent at 1280x720. */
let server: Server;
let url = "";
const calls: { path: string; body?: any; auth?: string }[] = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    calls.push({ path: String(req.url), body: body ? JSON.parse(body) : undefined, auth: req.headers.authorization });
    if (req.headers.authorization !== "Bearer tok") return void res.writeHead(403).end("forbidden");
    if (req.url?.startsWith("/screen")) {
      res.writeHead(200, { "content-type": "image/jpeg", "x-image-size": "1280x720", "x-capture-size": "2560x1440", "x-origin": "1920,0" });
      return void res.end(Buffer.from([0xff, 0xd8, 0xff]));
    }
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"cursor":[0,0]}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
const tool = (tools: Tool[], n: string) => tools.find((t) => t.def.name === n)!;

describe("desktop tools", () => {
  it("classifies tools: looking and scrolling are free; click/type/keys need approval", () => {
    const tools = createDesktopTools(new DesktopClient(url, "tok"));
    expect(Object.fromEntries(tools.map((t) => [t.def.name, t.kind]))).toEqual({
      desktop_screenshot: "read", desktop_click: "write", desktop_type: "write", desktop_key: "write", desktop_scroll: "read",
    });
  });

  it("maps screenshot coordinates to real pixels (scale + monitor origin) and marks the click in the preview", async () => {
    calls.length = 0;
    const d = new DesktopClient(url, "tok");
    const tools = createDesktopTools(d);
    await expect(tool(tools, "desktop_click").describe!({ x: 1, y: 1 })).rejects.toThrow(/screenshot first/);
    const shot = (await tool(tools, "desktop_screenshot").run({})) as { text: string; images: { mime: string }[] };
    expect(shot.text).toContain("1280x720");
    expect(shot.images[0].mime).toBe("image/jpeg");
    const info = await tool(tools, "desktop_click").describe!({ x: 100.4, y: 50 });
    expect(info.summary).toBe("Clic en el punto marcado de tu pantalla (100, 50)");
    expect(calls.at(-1)!.path).toMatch(/\/screen\?max=1280&mx=100&my=50$/);
    await tool(tools, "desktop_click").run({ x: 100.4, y: 50, double: true });
    expect(calls.at(-1)).toMatchObject({ path: "/input", body: { action: "click", x: 1920 + 201, y: 100, button: "left", double: true }, auth: "Bearer tok" });
    await expect(tool(tools, "desktop_click").describe!({ x: 1281, y: 10 })).rejects.toThrow(/outside the screenshot/);
    await tool(tools, "desktop_scroll").run({ x: 640, y: 360, amount: 99 });
    expect(calls.at(-1)!.body).toEqual({ action: "scroll", x: 1920 + 1280, y: 720, amount: 20 });
  });

  it("shows typed text and key combos exactly, and refuses dangerous or malformed ones", async () => {
    const tools = createDesktopTools(new DesktopClient(url, "tok"));
    expect(tool(tools, "desktop_type").describe!({ text: "Hola Mundo" })).toEqual({ summary: "Escribir en la ventana activa de tu pantalla", details: "Hola Mundo" });
    expect(() => tool(tools, "desktop_type").describe!({ text: "" })).toThrow(/required/);
    expect((tool(tools, "desktop_key").describe!({ keys: ["ctrl", "s"] }) as { summary: string }).summary).toBe("Pulsar Ctrl+S");
    for (const keys of [["ctrl", "alt", "delete"], ["win", "l"], ["rm -rf"], [], ["a", "b", "c", "d", "e"]]) expect(() => tool(tools, "desktop_key").describe!({ keys })).toThrow();
  });

  it("explains a missing/forbidden desktop app", async () => {
    const bad = createDesktopTools(new DesktopClient(url, "wrong"));
    await expect(tool(bad, "desktop_screenshot").run({})).rejects.toThrow(/403/);
    const gone = createDesktopTools(new DesktopClient("http://127.0.0.1:1", "tok"));
    await expect(tool(gone, "desktop_screenshot").run({})).rejects.toThrow(/desktop app running/);
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createStaticHandler } from "./static.js";

const dir = mkdtempSync(join(tmpdir(), "web-"));
mkdirSync(join(dir, "assets"));
mkdirSync(join(dir, "avatars"));
writeFileSync(join(dir, "index.html"), "<html>app</html>");
writeFileSync(join(dir, "assets", "a.js"), "console.log(1)");
writeFileSync(join(dir, "avatars", "default.vrm"), "VRMDATA");
const secret = join(dir, "..", "secret.txt");
writeFileSync(secret, "TOP SECRET");

let authorized = false;
const serve = createStaticHandler(dir, (p) => p.startsWith("/avatars/"), () => authorized);
const srv: Server = createServer((req, res) => {
  const path = new URL(req.url ?? "", "http://x").pathname;
  if (!serve(req, res, path)) res.writeHead(404).end("nf");
});
const port = await new Promise<number>((r) => srv.listen(0, "127.0.0.1", () => r((srv.address() as AddressInfo).port)));
afterAll(() => srv.close());
const get = async (p: string) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: r.status, body: await r.text(), cache: r.headers.get("cache-control"), type: r.headers.get("content-type") };
};

describe("static handler", () => {
  it("serves files with types and cache policy", async () => {
    expect(await get("/")).toMatchObject({ status: 200, body: "<html>app</html>", cache: "no-cache" });
    expect(await get("/assets/a.js")).toMatchObject({ status: 200, cache: expect.stringContaining("immutable"), type: expect.stringContaining("javascript") });
  });
  it("falls back to index.html for app routes but 404s missing files", async () => {
    expect((await get("/some/route")).body).toBe("<html>app</html>");
    expect((await get("/assets/missing.js")).status).toBe(404);
  });
  it("blocks path traversal and never leaks files outside the web dir", async () => {
    for (const p of ["/..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/assets/..%2f..%2fsecret.txt", "/..%5csecret.txt"]) {
      const r = await get(p);
      expect(r.body).not.toContain("TOP SECRET");
    }
    expect((await get("/..%2fsecret.txt")).status).toBe(403);
    expect((await get("/%00")).status).toBe(400);
  });
  it("protects personal assets (avatar) behind authorization", async () => {
    expect((await get("/avatars/default.vrm")).status).toBe(403);
    authorized = true;
    expect(await get("/avatars/default.vrm")).toMatchObject({ status: 200, body: "VRMDATA" });
  });
});

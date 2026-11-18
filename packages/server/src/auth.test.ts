import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { isLoopbackHost, makeAuthorizer, sameSecret } from "./auth.js";

const req = (headers: Record<string, string>, url = "/ws") => ({ headers, url }) as unknown as IncomingMessage;
const origins = new Set(["http://localhost:8787"]);

describe("server access", () => {
  it("this-PC mode: only localhost hosts and allowed origins (blocks other websites and DNS rebinding)", () => {
    const ok = makeAuthorizer({ allowedOrigins: origins });
    expect(ok(req({ host: "localhost:8787", origin: "http://localhost:8787" }))).toBe(true);
    expect(ok(req({ host: "127.0.0.1:8787" }))).toBe(true); // a local program (no Origin)
    expect(ok(req({ host: "localhost:8787", origin: "https://evil.test" }))).toBe(false);
    expect(ok(req({ host: "evil.test:8787" }))).toBe(false); // rebinding: the page's own domain resolves to 127.0.0.1
    expect(ok(req({ host: "evil.test:8787", origin: "http://evil.test:8787" }))).toBe(false);
    expect(ok(req({}))).toBe(false);
  });
  it("token mode: only the exact token", () => {
    const ok = makeAuthorizer({ token: "s3cret-token", allowedOrigins: origins });
    expect(ok(req({ host: "192.168.1.5:8787" }, "/ws?token=s3cret-token"))).toBe(true);
    expect(ok(req({ host: "192.168.1.5:8787", authorization: "Bearer s3cret-token" }))).toBe(true);
    expect(ok(req({ host: "192.168.1.5:8787" }, "/ws?token=s3cret-tokeX"))).toBe(false);
    expect(ok(req({ host: "localhost:8787", origin: "http://localhost:8787" }))).toBe(false);
  });
  it("helpers", () => {
    expect(["localhost", "localhost:1", "127.0.0.1:8787", "[::1]:8787", "127.1.2.3"].every(isLoopbackHost)).toBe(true);
    expect(["localhost.evil.test", "127.0.0.1.evil.test", "0.0.0.0", "192.168.0.2"].some(isLoopbackHost)).toBe(false);
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abd", "abc")).toBe(false);
    expect(sameSecret("ab", "abc")).toBe(false);
    expect(sameSecret(undefined, "abc")).toBe(false);
  });
});

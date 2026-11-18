import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** "localhost:8787", "127.0.0.1", "[::1]:8787"... */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.replace(/:\d+$/, "");
  return name === "localhost" || name === "::1" || /^127(\.\d{1,3}){3}$/.test(name);
}

/** Compares secrets in constant time (no timing hints about how many characters matched). */
export function sameSecret(given: string | null | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Who may use the server.
 * - With AUTH_TOKEN (phone/LAN mode): only requests carrying the token.
 * - Without it (this PC only): the Host must be localhost/127.0.0.1, which defeats "DNS rebinding" (a website
 *   pointing its own domain at 127.0.0.1 to read your companion), and browsers must come from an allowed Origin
 *   (blocks other websites). Non-browser programs send no Origin.
 */
export function makeAuthorizer(opts: { token?: string; allowedOrigins: Set<string> }) {
  return (req: IncomingMessage): boolean => {
    if (opts.token) {
      const url = new URL(req.url ?? "", "http://x");
      const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
      return sameSecret(url.searchParams.get("token"), opts.token) || sameSecret(bearer, opts.token);
    }
    if (!isLoopbackHost(req.headers.host)) return false;
    const origin = req.headers.origin;
    return !origin || opts.allowedOrigins.has(origin);
  };
}

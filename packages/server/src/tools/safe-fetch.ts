import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses (IPv4/IPv6). */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    const mappedHex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const a = parseInt(mappedHex[1], 16);
      const b = parseInt(mappedHex[2], 16);
      return isPrivateAddress(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
    }
    return (
      l === "::" ||
      l === "::1" ||
      /^f[cd]/.test(l) || // fc00::/7 unique local
      /^fe[89ab]/.test(l) || // fe80::/10 link local
      /^ff/.test(l) || // multicast
      l.startsWith("64:ff9b:") || // NAT64
      l.startsWith("2001:db8") // documentation
    );
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true; // unparseable: refuse
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved
  );
}

export interface SafeGetOptions {
  headers?: Record<string, string>;
  /** Called for the initial URL and for every redirect hop. */
  hostAllowed: (host: string) => boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  /** TESTS ONLY: permits loopback/private targets and plain http. Never exposed through configuration. */
  _allowPrivateForTests?: boolean;
}

export interface SafeGetResult {
  status: number;
  contentType: string;
  body: string;
  truncated: boolean;
  finalUrl: string;
}

const TEXTUAL = /^(text\/|application\/(json|xml|xhtml|ld\+json|problem\+json|rss|atom|javascript|x-www-form-urlencoded)|[^;]*\+(json|xml))/i;

/** Validates the address at connect time, so DNS answers that change between check and use cannot bypass it. */
function guardedAgent(allowPrivate: boolean) {
  return new Agent({
    connect: {
      lookup(hostname: string, options: dns.LookupOptions, cb: (...a: any[]) => void) {
        dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
          if (err) return cb(err);
          const list = addrs as dns.LookupAddress[];
          if (!allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
            return cb(new Error(`blocked: ${hostname} resolves to a private/reserved address`));
          }
          if (options.all) cb(null, list);
          else cb(null, list[0].address, list[0].family);
        });
      },
    },
  });
}

/** Read-only HTTP GET with SSRF protection, redirect re-validation, size and time limits. */
export async function safeGet(rawUrl: string, o: SafeGetOptions): Promise<SafeGetResult> {
  const maxBytes = o.maxBytes ?? 200_000;
  const maxRedirects = o.maxRedirects ?? 3;
  const allowPrivate = o._allowPrivateForTests === true;
  const agent = guardedAgent(allowPrivate);
  const timeout = AbortSignal.timeout(o.timeoutMs ?? 10_000);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  try {
    let url = new URL(rawUrl);
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) throw new Error("only https URLs are allowed");
      if (url.username || url.password) throw new Error("credentials in URLs are not allowed");
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (net.isIP(host) && !allowPrivate && isPrivateAddress(host)) throw new Error("blocked: private/reserved address");
      if (!o.hostAllowed(host.toLowerCase())) throw new Error(`host "${host}" is not allowed (not in the API catalog or read documentation)`);

      const res = await undiciFetch(url, {
        method: "GET",
        redirect: "manual",
        signal,
        dispatcher: agent,
        headers: { "user-agent": "ai-waifu/0.1 (+personal companion)", accept: "application/json, text/*;q=0.9, */*;q=0.5", ...o.headers },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop >= maxRedirects) throw new Error("too many redirects");
        await res.body?.cancel();
        url = new URL(res.headers.get("location")!, url);
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!TEXTUAL.test(contentType) && contentType) {
        await res.body?.cancel();
        return { status: res.status, contentType, body: `[non-text content (${contentType}) omitted]`, truncated: false, finalUrl: url.toString() };
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          chunks.push(Buffer.from(value));
          if (size > maxBytes) {
            truncated = true;
            await reader.cancel();
            break;
          }
        }
      }
      return { status: res.status, contentType, body: Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8"), truncated, finalUrl: url.toString() };
    }
  } finally {
    await agent.close();
  }
}

/** Crude HTML to text for documentation pages (drops scripts/styles/tags, keeps URLs of links). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<\/(p|div|li|h\d|tr|pre|br)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

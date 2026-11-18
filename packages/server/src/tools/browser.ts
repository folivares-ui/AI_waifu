import { lookup } from "node:dns/promises";
import net from "node:net";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { isPrivateAddress } from "./safe-fetch.js";
import { describeEgress, untrusted, type Tool } from "./types.js";

export interface BrowserOptions {
  /** Dedicated profile folder: never the user's own Chrome profile (no history, passwords or cookies of theirs). */
  profileDir: string;
  /** "chrome" (installed Google Chrome, default), "msedge", or undefined with executablePath. */
  channel?: string;
  executablePath?: string;
  headless?: boolean;
  /** Allow localhost / LAN addresses (off by default: protects the router, local services and this app itself). */
  allowPrivate?: boolean;
}

interface Snapshot {
  title: string;
  url: string;
  text: string;
  elements: { ref: string; tag: string; type: string; label: string; value?: string; href?: string }[];
}

const MAX_TEXT = 9000;

/** Is this URL one she may open? (http/https only; no private/loopback hosts unless allowed). */
export async function checkUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Only http/https pages can be opened (not ${url.protocol}).`);
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : host === "localhost" || host.endsWith(".localhost") ? ["127.0.0.1"] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.some(isPrivateAddress)) throw new Error(`"${host}" is a local/private address; opening it is blocked for safety.`);
  return url;
}

/**
 * One visible browser window in its own profile, shared by her tools. Pages are read through a snapshot that
 * numbers the interactive elements (e1, e2...), so clicks/typing target exactly what the user approved.
 */
export class BrowserController {
  private ctx?: BrowserContext;
  private starting?: Promise<BrowserContext>;

  constructor(readonly o: BrowserOptions) {}

  private async context(): Promise<BrowserContext> {
    if (this.ctx) return this.ctx;
    this.starting ??= (async () => {
      const ctx = await chromium.launchPersistentContext(this.o.profileDir, {
        channel: this.o.executablePath ? undefined : (this.o.channel ?? "chrome"),
        executablePath: this.o.executablePath,
        headless: this.o.headless ?? false,
        acceptDownloads: false,
        viewport: this.o.headless ? { width: 1280, height: 860 } : null,
      });
      // Also stop navigations to private addresses triggered by links/redirects, not only by browser_open.
      if (!this.o.allowPrivate) {
        await ctx.route("**/*", async (route) => {
          const req = route.request();
          if (!req.isNavigationRequest()) return route.continue();
          try {
            await checkUrl(req.url(), false);
            return route.continue();
          } catch {
            return route.abort("blockedbyclient");
          }
        });
      }
      ctx.on("close", () => {
        this.ctx = undefined;
        this.starting = undefined;
      });
      this.ctx = ctx;
      return ctx;
    })();
    try {
      return await this.starting;
    } catch (e) {
      this.starting = undefined;
      const hint = this.o.executablePath ? "" : ` Is Google Chrome installed? (BROWSER_CHANNEL=${this.o.channel ?? "chrome"})`;
      throw new Error(`Could not start the browser: ${e instanceof Error ? e.message.split("\n")[0] : e}.${hint}`);
    }
  }

  async page(): Promise<Page> {
    const ctx = await this.context();
    const pages = ctx.pages();
    return pages.at(-1) ?? (await ctx.newPage());
  }

  async open(raw: string): Promise<Snapshot> {
    const url = await checkUrl(raw, !!this.o.allowPrivate);
    const page = await this.page();
    await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    return this.snapshot();
  }

  async snapshot(): Promise<Snapshot> {
    const page = await this.page();
    const data = await page.evaluate(() => {
      document.querySelectorAll("[data-waifu-ref]").forEach((e) => e.removeAttribute("data-waifu-ref"));
      const sel = "a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=checkbox],[role=tab],[contenteditable=true]";
      const els: { ref: string; tag: string; type: string; label: string; value?: string; href?: string }[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        if (r.width < 1 || r.height < 1 || st.visibility === "hidden" || st.display === "none") continue;
        if (els.length >= 150) break;
        const ref = `e${els.length + 1}`;
        el.setAttribute("data-waifu-ref", ref);
        const input = el as HTMLInputElement;
        const type = (el.getAttribute("type") || "").toLowerCase();
        const label = (
          el.getAttribute("aria-label") ||
          (input.labels && input.labels[0]?.innerText) ||
          el.innerText ||
          el.getAttribute("placeholder") ||
          el.getAttribute("name") ||
          el.getAttribute("title") ||
          (type === "submit" || type === "button" ? input.value : "") ||
          ""
        )
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
        const isField = ["input", "textarea", "select"].includes(el.tagName.toLowerCase());
        els.push({
          ref,
          tag: el.tagName.toLowerCase(),
          type,
          label,
          ...(isField && type !== "password" && input.value ? { value: String(input.value).slice(0, 60) } : {}),
          ...((el as HTMLAnchorElement).href ? { href: (el as HTMLAnchorElement).href.slice(0, 120) } : {}),
        });
      }
      return { title: document.title, url: location.href, text: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim(), els };
    });
    return { title: data.title, url: data.url, text: data.text, elements: data.els };
  }

  render(s: Snapshot): string {
    const els = s.elements.map((e) => `${e.ref} [${e.tag}${e.type ? ` ${e.type}` : ""}] ${e.label || "(sin texto)"}${e.value ? ` = "${e.value}"` : ""}${e.href && e.tag === "a" ? ` -> ${e.href}` : ""}`);
    const text = s.text.length > MAX_TEXT ? s.text.slice(0, MAX_TEXT) + "\n...[texto truncado]" : s.text;
    return `Titulo: ${s.title}\nURL: ${s.url}\n\n${text}\n\nElementos interactivos:\n${els.join("\n") || "(ninguno)"}`;
  }

  /** Finds an element from the last snapshot. */
  async element(ref: string) {
    if (!/^e\d{1,3}$/.test(String(ref))) throw new Error(`Invalid element reference "${ref}" (use one like e12 from browser_read).`);
    const page = await this.page();
    const loc = page.locator(`[data-waifu-ref="${ref}"]`);
    if ((await loc.count()) === 0) throw new Error(`Element ${ref} is no longer on the page; call browser_read again.`);
    const info = await loc.first().evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute("type") || "").toLowerCase(),
      label: (el.getAttribute("aria-label") || (el as HTMLInputElement).labels?.[0]?.innerText || (el as HTMLElement).innerText || el.getAttribute("placeholder") || el.getAttribute("name") || "").trim().replace(/\s+/g, " ").slice(0, 80),
      autocomplete: (el.getAttribute("autocomplete") || "").toLowerCase(),
    }));
    return { page, loc: loc.first(), info };
  }

  /** Screenshot with the target outlined, for the approval card. */
  async preview(ref?: string) {
    const page = await this.page();
    let undo: (() => Promise<void>) | undefined;
    if (ref) {
      const loc = page.locator(`[data-waifu-ref="${ref}"]`).first();
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      await loc.evaluate((el) => {
        (el as HTMLElement).dataset.waifuOutline = (el as HTMLElement).style.outline;
        (el as HTMLElement).style.outline = "4px solid #ff2d55";
      }).catch(() => {});
      undo = () => loc.evaluate((el) => void ((el as HTMLElement).style.outline = (el as HTMLElement).dataset.waifuOutline ?? "")).catch(() => {});
    }
    const buf = await page.screenshot({ type: "jpeg", quality: 60 });
    await undo?.();
    return { data: buf.toString("base64"), mime: "image/jpeg" as const, width: page.viewportSize()?.width ?? 0, height: page.viewportSize()?.height ?? 0 };
  }

  async close() {
    await this.ctx?.close().catch(() => {});
  }
}

const SENSITIVE = /password|passwd|contrase|clave|pin\b|cvv|cvc|card|tarjeta|iban|ssn|otp|token|secret|security code/i;

export function createBrowserTools(b: BrowserController): Tool[] {
  const host = (u: string) => {
    try {
      return new URL(u).host;
    } catch {
      return u;
    }
  };

  const open: Tool = {
    kind: "read",
    egress: true,
    describe: (input) => describeEgress("Abrir en su navegador:", (input as { url?: string })?.url),
    def: {
      name: "browser_open",
      description:
        "Open a web page (http/https) in her own browser window (a separate Chrome profile: no access to the user's history, passwords or logins). Returns the page text and its numbered interactive elements. Use it for Canva web too.",
      input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
    async run(input) {
      const s = await b.open(String((input as { url?: string })?.url ?? ""));
      return untrusted(s.url, b.render(s));
    },
  };

  const read: Tool = {
    kind: "read",
    def: {
      name: "browser_read",
      description: "Re-read the current page in her browser: text plus interactive elements numbered e1, e2... (refs change after the page changes; re-read before clicking).",
      input_schema: { type: "object", properties: {} },
    },
    async run() {
      const s = await b.snapshot();
      return untrusted(s.url, b.render(s));
    },
  };

  const shot: Tool = {
    kind: "read",
    def: { name: "browser_screenshot", description: "See the current page in her browser as an image.", input_schema: { type: "object", properties: {} } },
    async run() {
      const img = await b.preview();
      const page = await b.page();
      return { text: untrusted(page.url(), `Screenshot of ${page.url()}`), images: [img] };
    },
  };

  const back: Tool = {
    kind: "read",
    def: { name: "browser_back", description: "Go back to the previous page in her browser.", input_schema: { type: "object", properties: {} } },
    async run() {
      const page = await b.page();
      await page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
      const s = await b.snapshot();
      return untrusted(s.url, b.render(s));
    },
  };

  const click: Tool = {
    kind: "write",
    def: {
      name: "browser_click",
      description: "Click an element of the current page by its ref (e.g. e12 from browser_read). The user sees the element highlighted and must approve.",
      input_schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] },
    },
    async describe(input) {
      const ref = String((input as { ref?: string })?.ref ?? "");
      const { page, info } = await b.element(ref);
      return { summary: `Hacer clic en «${info.label || info.tag}» en ${host(page.url())}`, details: `${info.tag}${info.type ? ` (${info.type})` : ""} · ${page.url()}`, preview: await b.preview(ref) };
    },
    async run(input) {
      const { page, loc } = await b.element(String((input as { ref: string }).ref));
      await loc.click({ timeout: 8000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      const s = await b.snapshot();
      return untrusted(s.url, `Clicked. Now on:\n${b.render(s)}`);
    },
  };

  const type: Tool = {
    kind: "write",
    def: {
      name: "browser_type",
      description:
        "Type text into a field of the current page (or choose an option in a <select>) by ref; optionally press Enter. Never used for passwords, card numbers or codes: the user types those themselves. The user sees the field and the exact text and must approve.",
      input_schema: {
        type: "object",
        properties: { ref: { type: "string" }, text: { type: "string" }, submit: { type: "boolean", description: "Press Enter afterwards" } },
        required: ["ref", "text"],
      },
    },
    async describe(input) {
      const i = input as { ref: string; text: string; submit?: boolean };
      if (typeof i?.text !== "string") throw new Error("text is required.");
      const { page, info } = await b.element(String(i.ref ?? ""));
      if (info.type === "password" || SENSITIVE.test(info.label) || /cc-|one-time-code|current-password|new-password/.test(info.autocomplete)) {
        throw new Error("This looks like a password/payment/security field. Do not fill it: ask the user to type it themselves.");
      }
      if (!["input", "textarea", "select"].includes(info.tag) && !(await (await b.element(i.ref)).loc.evaluate((el) => (el as HTMLElement).isContentEditable))) {
        throw new Error(`${i.ref} is not a text field.`);
      }
      return {
        summary: `${info.tag === "select" ? "Elegir" : "Escribir"} en «${info.label || info.tag}» (${host(page.url())})${i.submit ? " y pulsar Enter" : ""}`,
        details: i.text,
        preview: await b.preview(i.ref),
      };
    },
    async run(input) {
      const i = input as { ref: string; text: string; submit?: boolean };
      const { page, loc, info } = await b.element(i.ref);
      if (info.tag === "select") await loc.selectOption({ label: i.text }).catch(() => loc.selectOption(i.text));
      else await loc.fill(i.text, { timeout: 8000 });
      if (i.submit) {
        await loc.press("Enter");
        await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
      const s = await b.snapshot();
      return untrusted(s.url, `Done. Now on:\n${b.render(s)}`);
    },
  };

  return [open, read, shot, back, click, type];
}

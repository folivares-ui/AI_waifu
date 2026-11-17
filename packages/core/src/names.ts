/**
 * How the character recognises her own name in what the user types or says, whatever the capitalisation
 * ("rice shower", "RICE SHOWER", "Rice shower"...) and the way a Spanish speech-to-text engine tends to
 * spell an English name it heard ("Rais Shower", "Rice Chower"...).
 */
export interface NameConfig {
  /** Canonical forms, e.g. ["Rice Shower", "Rice"]; longer forms are matched first. */
  aliases: string[];
  /** Misspellings produced by speech recognition, mapped to the canonical form they stand for. */
  heardAs?: Record<string, string[]>;
}

export interface NameMatch {
  /** The text with every mention written canonically (only the name is touched). */
  text: string;
  /** True when the message mentions her name. */
  addressed: boolean;
}

/** Lowercase, accents removed, one output char per input char (so match positions map back to the original). */
function foldChars(s: string): string[] {
  return Array.from(s, (c) => c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() || c);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function matchName(input: string, cfg: NameConfig | undefined): NameMatch {
  if (!cfg || !cfg.aliases.length || !input) return { text: input, addressed: false };
  const forms: { variant: string; canonical: string }[] = [];
  for (const a of cfg.aliases) forms.push({ variant: a, canonical: a });
  for (const [canonical, variants] of Object.entries(cfg.heardAs ?? {})) for (const v of variants) forms.push({ variant: v, canonical });
  forms.sort((a, b) => b.variant.length - a.variant.length);

  const chars = Array.from(input);
  const folded = foldChars(input);
  // folded text where every original character is exactly one unit, so indices line up
  const flat = folded.map((f) => (f.length === 1 ? f : f[0] ?? " ")).join("");
  const pattern = forms
    .map((f) => foldChars(f.variant).join("").trim().split(/\s+/).map(escape).join("[\\s\\-_]*"))
    .join("|");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, "gu");

  let out = "";
  let last = 0;
  let addressed = false;
  for (const m of flat.matchAll(re)) {
    const hit = m[0];
    const hitKey = hit.replace(/[\s\-_]+/g, " ").trim();
    const form = forms.find((f) => foldChars(f.variant).join("").replace(/\s+/g, " ").trim() === hitKey);
    addressed = true;
    out += chars.slice(last, m.index).join("") + (form?.canonical ?? hit);
    last = m.index! + Array.from(hit).length;
  }
  return { text: out + chars.slice(last).join(""), addressed };
}

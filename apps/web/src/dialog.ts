/**
 * Text helpers for the visual-novel dialog box.
 * The model's stream contains control tags such as "[emotion:shy]". They arrive split across tokens
 * ("[emotion:sh" + "y] U-um..."), so they are removed from the WHOLE text, never token by token.
 */
export function cleanTags(raw: string): string {
  return raw
    .replace(/\[(?:emotion|emocion|silent)[^\]]*\]/gi, "") // complete tags, anywhere
    .replace(/\[[a-z_ ]*(?::[^\]]*)?$/i, "") // a tag still being written at the end
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** One sentence of her current answer. It appears in the box when she starts saying it. */
export interface DialogLine {
  key: number;
  /** Spanish (shown big). */
  text: string;
  /** What she says aloud when it is another language (shown small), e.g. Japanese. "" = not spoken. */
  speech?: string;
  started: boolean;
  arrived: number;
}

export interface Dialog {
  turn: number;
  lines: DialogLine[];
}

let nextKey = 1;

/** Adds a sentence; a sentence from a new turn starts a fresh box. */
export function addLine(d: Dialog, turn: number, text: string, speech: string | undefined, now: number): { dialog: Dialog; key: number } {
  const key = nextKey++;
  const line: DialogLine = { key, text: cleanTags(text), speech: speech === undefined ? undefined : cleanTags(speech), started: false, arrived: now };
  const lines = d.turn === turn ? [...d.lines, line] : [line];
  return { dialog: { turn, lines }, key };
}

export function markStarted(d: Dialog, key: number): Dialog {
  // Everything before the sentence that is starting has been said too (keeps the order even if an event was lost).
  const i = d.lines.findIndex((l) => l.key === key);
  if (i < 0 || d.lines.slice(0, i + 1).every((l) => l.started)) return d;
  return { ...d, lines: d.lines.map((l, j) => (j <= i ? { ...l, started: true } : l)) };
}

/**
 * Shows sentences that are not being played: when nothing is playing, whatever arrived more than `graceMs` ago
 * (muted, no voice, errors...); and in any case after `maxWaitMs` (a voice that hangs never hides her words).
 */
export function revealStale(d: Dialog, now: number, idle: boolean, graceMs = 800, maxWaitMs = 15_000): Dialog {
  const due = (l: DialogLine) => !l.started && now - l.arrived >= (idle ? graceMs : maxWaitMs);
  if (!d.lines.some(due)) return d;
  // Keep the order: revealing a sentence reveals the ones before it.
  const last = d.lines.map(due).lastIndexOf(true);
  return { ...d, lines: d.lines.map((l, i) => (i <= last ? { ...l, started: true } : l)) };
}

import { useEffect, useRef, useState } from "react";
import type { DialogLine } from "./dialog";

/** Characters per second for the typewriter (a comfortable subtitle reading speed). */
const CPS = 38;

/**
 * Visual-novel dialog box: her name on a tab, what she says in Spanish (typed out as she speaks) and,
 * small below, the Japanese she is actually saying.
 */
export function DialogBox({ name, lines, thinking, userText }: { name: string; lines: DialogLine[]; thinking: boolean; userText?: string }) {
  const said = lines.filter((l) => l.started);
  const es = said.map((l) => l.text).join(" ");
  const ja = said
    .map((l) => l.speech)
    .filter((s): s is string => !!s)
    .join("");
  const shown = useTypewriter(es);
  const done = shown >= es.length;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [shown, ja]);

  if (!es && !thinking) return null;
  return (
    <section className="dialog" aria-live="polite" aria-label={`Lo que dice ${name}`}>
      {userText && <p className="dialog-user">Tu: {userText}</p>}
      <div className="dialog-box">
        <span className="dialog-name">{name}</span>
        <div className="dialog-body" ref={box}>
          {es ? (
            <>
              <p className="dialog-es">
                {es.slice(0, shown)}
                <span className="dialog-rest" aria-hidden="true">
                  {es.slice(shown)}
                </span>
              </p>
              {ja && (
                <p className="dialog-ja" lang="ja">
                  {ja}
                </p>
              )}
            </>
          ) : (
            <p className="dialog-es dialog-thinking" aria-label={`${name} esta pensando`}>
              <span />
              <span />
              <span />
            </p>
          )}
        </div>
        {es && done && !thinking && <span className="dialog-next" aria-hidden="true">▼</span>}
      </div>
    </section>
  );
}

/**
 * How many characters of `text` to show. Based on elapsed time (not on how many timer ticks ran), so a busy page
 * (the 3D model rendering) never slows the reading speed; restarts when a new answer replaces the text.
 */
function useTypewriter(text: string): number {
  const [, tick] = useState(0);
  const seg = useRef({ text: "", from: 0, t0: 0 });
  const now = performance.now();
  const s = seg.current;
  if (text !== s.text) {
    const continuing = text.startsWith(s.text);
    const shownSoFar = continuing ? Math.min(s.text.length, s.from + ((now - s.t0) * CPS) / 1000) : 0;
    seg.current = { text, from: Math.floor(shownSoFar), t0: now };
  }
  const n = Math.min(text.length, Math.floor(seg.current.from + ((now - seg.current.t0) * CPS) / 1000));
  useEffect(() => {
    if (n >= text.length) return;
    const t = setTimeout(() => tick((x) => x + 1), 33);
    return () => clearTimeout(t);
  });
  return n;
}

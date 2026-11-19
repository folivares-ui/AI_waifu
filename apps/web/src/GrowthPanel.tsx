import { useEffect, useState } from "react";
import { getGrowth, resetGrowth, type GrowthView } from "./net";

/** "Como ha cambiado": her traits (0-100), where she started, and the last reasons they changed. */
export function GrowthPanel({ character }: { character: string }) {
  const [g, setG] = useState<GrowthView>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    getGrowth()
      .then(setG)
      .catch((e: Error) => setError(e.message));
  }, [character]);

  if (error) return null;
  if (!g) return null;
  const traitName = (id: string) => g.traits.find((t) => t.id === id)?.name ?? id;
  return (
    <div className="row growth">
      <span>
        Como ha cambiado {g.name}
        <small>Su forma de ser evoluciona poco a poco con como la tratas (animos, confianza, compania). No cambia por ordenes.</small>
      </span>
      <ul className="traits">
        {g.traits.map((t) => (
          <li key={t.id}>
            <div className="trait-head">
              <b>{t.name}</b>
              <span>
                {t.level}/100{t.level !== t.start && <em className={t.level > t.start ? "up" : "down"}> ({t.level > t.start ? "+" : ""}{t.level - t.start})</em>}
              </span>
            </div>
            <div className="bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={t.level} aria-label={t.name}>
              <i style={{ width: `${t.level}%` }} />
              <s style={{ left: `${t.start}%` }} title="Donde empezo" />
            </div>
          </li>
        ))}
      </ul>
      {g.recent.length > 0 && (
        <details className="recent">
          <summary>Ultimos cambios</summary>
          <ul>
            {g.recent.map((r, i) => (
              <li key={i}>
                <span className={r.delta > 0 ? "up" : "down"}>{r.delta > 0 ? `+${r.delta}` : r.delta}</span> {traitName(r.trait)}: {r.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      <button
        type="button"
        className="btn ghost small-btn"
        onClick={async () => {
          if (!confirm(`¿Volver a la personalidad inicial de ${g.name}? Se pierde todo lo que ha crecido.`)) return;
          try {
            setG(await resetGrowth());
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Empezar de nuevo
      </button>
    </div>
  );
}

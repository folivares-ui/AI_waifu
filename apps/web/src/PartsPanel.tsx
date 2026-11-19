import { looksLikeWeapon } from "./modelParts";

/** Ajustes > Partes del modelo: show or hide each part (e.g. the weapon she holds). */
export function PartsPanel({ name, parts, hidden, onChange }: { name: string; parts: string[]; hidden: string[]; onChange: (hidden: string[]) => void }) {
  if (parts.length === 0) return null;
  const toggle = (p: string, visible: boolean) => onChange(visible ? hidden.filter((h) => h !== p) : [...hidden, p]);
  return (
    <div className="row parts">
      <span>
        Partes del modelo
        <small>Desmarca lo que no quieras ver en {name} (por ejemplo, armas u objetos en las manos). Se guarda para este personaje.</small>
      </span>
      <ul className="part-list">
        {parts.map((p) => (
          <li key={p}>
            <label>
              <input type="checkbox" checked={!hidden.includes(p)} onChange={(e) => toggle(p, e.target.checked)} />
              <span>{p}</span>
              {looksLikeWeapon(p) && <small className="tag">arma</small>}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

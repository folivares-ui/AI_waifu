import { useEffect, useState } from "react";
import { createCharacter, deleteCharacter, listCharacters, selectCharacter, type CharacterInfo } from "./net";

/**
 * "Personajes" in the settings: switch between characters (each keeps her own model, voice and memory),
 * create a new one or delete one you created.
 */
export function CharacterPicker({ current }: { current: string }) {
  const [list, setList] = useState<CharacterInfo[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [creating, setCreating] = useState(false);

  const refresh = () =>
    listCharacters()
      .then(setList)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void refresh();
  }, [current]);

  const pick = async (c: CharacterInfo) => {
    if (c.active || busy) return;
    setBusy(c.id);
    setError(undefined);
    try {
      await selectCharacter(c.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const remove = async (c: CharacterInfo) => {
    if (!confirm(`¿Borrar a ${c.name}? Tambien se borran su modelo, su muestra de voz y su memoria. No se puede deshacer.`)) return;
    try {
      await deleteCharacter(c.id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="row characters">
      <span>
        Personaje
        <small>Cada personaje tiene su propio modelo 3D, su voz y su memoria. Al cambiar, la conversacion empieza de nuevo.</small>
      </span>
      <div className="char-list" role="radiogroup" aria-label="Personaje">
        {!list && !error && <small>Cargando...</small>}
        {list?.map((c) => (
          <div key={c.id} className={`char${c.active ? " on" : ""}`}>
            <button type="button" role="radio" aria-checked={c.active} disabled={!!busy} onClick={() => void pick(c)}>
              <b>{c.name}</b>
              <small>
                {busy === c.id ? "Cambiando..." : [c.hasAvatar || c.id === "default" ? "modelo ✓" : "sin modelo", c.hasVoice ? "voz ✓" : "sin voz"].join(" · ")}
              </small>
            </button>
            {!c.builtIn && (
              <button type="button" className="char-del" aria-label={`Borrar a ${c.name}`} title="Borrar este personaje" onClick={() => void remove(c)}>
                ✕
              </button>
            )}
          </div>
        ))}
        <button type="button" className="btn" onClick={() => setCreating(true)}>
          + Nuevo personaje
        </button>
      </div>
      {error && <small className="err">{error}</small>}
      {creating && (
        <NewCharacterForm
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            try {
              await selectCharacter(id);
            } catch (e) {
              setError((e as Error).message);
            }
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function NewCharacterForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [honorific, setHonorific] = useState("");
  const [aliases, setAliases] = useState("");
  const [japanese, setJapanese] = useState(true);
  const [style, setStyle] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const { id } = await createCharacter({
        name,
        persona,
        honorific,
        aliases: aliases.split(",").map((a) => a.trim()).filter(Boolean),
        speechLang: japanese ? "ja-JP" : undefined,
        speechStyle: japanese && style.trim() ? style : undefined,
      });
      onCreated(id);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <form className="new-char" onSubmit={(e) => void submit(e)}>
      <h3>Nuevo personaje</h3>
      <label>
        Nombre
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required placeholder="Ej.: Manhattan Cafe" />
      </label>
      <label>
        Personalidad
        <small>Quien es, como habla, que le gusta, como te trata... Escribelo en segunda persona ("Eres...").</small>
        <textarea value={persona} onChange={(e) => setPersona(e.target.value)} rows={5} maxLength={6000} required placeholder="Eres ..., una chica ... Hablas de forma ..." />
      </label>
      <label>
        Como te llama
        <input value={honorific} onChange={(e) => setHonorific(e.target.value)} maxLength={30} placeholder="Ej.: Trainer-san, Onii-chan..." />
      </label>
      <label>
        Otros nombres a los que responde (separados por comas)
        <input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="Ej.: Cafe" />
      </label>
      <label className="inline">
        <input type="checkbox" checked={japanese} onChange={(e) => setJapanese(e.target.checked)} /> Habla en japones (con subtitulos en espanol)
      </label>
      {japanese && (
        <label>
          Como habla en japones (opcional)
          <input value={style} onChange={(e) => setStyle(e.target.value)} maxLength={600} placeholder="Ej.: usa 「私」 y te llama 「トレーナーさん」" />
        </label>
      )}
      <small>Despues podras cargar su modelo .vrm y su muestra de voz .wav en estos mismos ajustes.</small>
      {error && <small className="err">{error}</small>}
      <div className="new-char-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancelar
        </button>
        <button type="submit" className="btn" disabled={saving}>
          {saving ? "Creando..." : "Crear"}
        </button>
      </div>
    </form>
  );
}

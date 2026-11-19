import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadSoul, type Soul } from "./soul.js";

/** A character she can be: Rice Shower, Agnes Tachyon, or one you create in the app. */
export interface CharacterInfo {
  id: string;
  name: string;
  /** Shipped with the app (cannot be deleted from the app). */
  builtIn: boolean;
  hasAvatar: boolean;
  hasVoice: boolean;
  active: boolean;
}

/** What you fill in when you create a character in the app. */
export interface NewCharacter {
  name: string;
  persona: string;
  /** How she calls you ("Onii-sama", "Trainer"...). */
  honorific?: string;
  /** Other names she answers to ("Tachyon"). */
  aliases?: string[];
  /** "ja-JP" = she speaks Japanese with Spanish subtitles. */
  speechLang?: string;
  speechStyle?: string;
}

/** The default character keeps the files it always had (data/memory.json, data/avatars, data/voices). */
export const DEFAULT_ID = "default";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function slugify(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "personaje"
  );
}

/**
 * All characters: the ones shipped in `<app>/souls` and the ones you created in `<user>/souls`.
 * Each has its own 3D model, voice sample and memory in the user data folder, and one of them is active.
 */
export class Characters {
  constructor(
    private appSouls: string,
    private userSouls: string,
    private dataDir: string,
    /** Character used until you pick one (from SOUL_FILE). */
    private initial = DEFAULT_ID,
    /** Memory file of the default character (MEMORY_FILE). */
    private defaultMemory = join(dataDir, "memory.json"),
  ) {}

  private file(id: string): { path: string; builtIn: boolean } | undefined {
    if (!ID_RE.test(id)) return undefined;
    const mine = join(this.userSouls, `${id}.soul.json`);
    if (existsSync(mine)) return { path: mine, builtIn: existsSync(join(this.appSouls, `${id}.soul.json`)) };
    const shipped = join(this.appSouls, `${id}.soul.json`);
    return existsSync(shipped) ? { path: shipped, builtIn: true } : undefined;
  }

  private ids(): string[] {
    const scan = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".soul.json")).map((f) => basename(f, ".soul.json")) : []);
    const all = [...new Set([...scan(this.appSouls), ...scan(this.userSouls)])].filter((id) => ID_RE.test(id));
    // Hidden souls (old examples) are not offered.
    return all.filter((id) => {
      try {
        return !(JSON.parse(readFileSync(this.file(id)!.path, "utf8")) as { hidden?: boolean }).hidden;
      } catch {
        return false;
      }
    });
  }

  exists(id: string): boolean {
    return !!this.file(id);
  }

  load(id: string): Soul {
    const f = this.file(id);
    if (!f) throw new Error(`Unknown character "${id}"`);
    return loadSoul(f.path);
  }

  /** Where this character's own files live. */
  paths(id: string) {
    if (id === DEFAULT_ID) {
      return {
        avatar: join(this.dataDir, "avatars", "default.vrm"),
        voice: join(this.dataDir, "voices", "voice-ref.wav"),
        legacyVoice: join(this.dataDir, "voices", "rice-shower", "rice-ref-2.wav"),
        memory: this.defaultMemory,
      };
    }
    const dir = join(this.dataDir, "characters", id);
    return { avatar: join(dir, "avatar.vrm"), voice: join(dir, "voice-ref.wav"), legacyVoice: undefined as string | undefined, memory: join(dir, "memory.json") };
  }

  /** The voice sample to use for her VoiceStudio voice (uploaded one, else a clip prepared earlier). */
  voiceSample(id: string): string | undefined {
    const p = this.paths(id);
    return [p.voice, p.legacyVoice].find((f): f is string => !!f && existsSync(f));
  }

  private activeFile() {
    return join(this.dataDir, "active-character.json");
  }

  activeId(): string {
    try {
      const id = (JSON.parse(readFileSync(this.activeFile(), "utf8")) as { id?: string }).id;
      if (id && this.exists(id)) return id;
    } catch {
      /* not chosen yet */
    }
    return this.exists(this.initial) ? this.initial : (this.ids()[0] ?? DEFAULT_ID);
  }

  setActive(id: string) {
    if (!this.exists(id)) throw new Error(`Unknown character "${id}"`);
    mkdirSync(this.dataDir, { recursive: true });
    writeFileSync(this.activeFile(), JSON.stringify({ id }));
  }

  list(): CharacterInfo[] {
    const active = this.activeId();
    return this.ids().map((id) => {
      const p = this.paths(id);
      return { id, name: this.load(id).name, builtIn: this.file(id)!.builtIn, hasAvatar: existsSync(p.avatar), hasVoice: !!this.voiceSample(id), active: id === active };
    });
  }

  /** Creates a character from the app's form. Returns its id. */
  create(c: NewCharacter): string {
    const name = String(c.name ?? "").trim();
    const persona = String(c.persona ?? "").trim();
    if (name.length < 1 || name.length > 40) throw new Error("El nombre debe tener entre 1 y 40 caracteres.");
    if (persona.length < 20 || persona.length > 6000) throw new Error("Describe su personalidad (entre 20 y 6000 caracteres).");
    const base = slugify(name);
    let id = base === DEFAULT_ID ? `${base}-2` : base;
    for (let n = 2; this.exists(id); n++) id = `${base}-${n}`;
    const aliases = [name, ...(c.aliases ?? []).map((a) => String(a).trim()).filter((a) => a && a.length <= 40)].slice(0, 6);
    const lang = c.speechLang && /^[a-z]{2}(-[A-Z]{2})?$/.test(c.speechLang) ? c.speechLang : undefined;
    const soul = {
      name,
      language: "es-ES",
      names: { aliases: [...new Set(aliases)] },
      owner: { name: "", honorific: String(c.honorific ?? "").trim().slice(0, 30) || undefined },
      voice: { lang: "es-ES", pitch: 1.2, rate: 1, ttsVoice: name, ...(lang ? { speechLang: lang } : {}), ...(c.speechStyle ? { speechStyle: String(c.speechStyle).slice(0, 600) } : {}) },
      persona,
      boundaries: `No finjas haber hecho acciones que no puedes hacer. Mantente siempre en el personaje de ${name}, con contenido apto para todo publico.`,
    };
    mkdirSync(this.userSouls, { recursive: true });
    writeFileSync(join(this.userSouls, `${id}.soul.json`), JSON.stringify(soul, null, 2));
    return id;
  }

  /** Deletes a character you created (and its model, voice sample and memory). Shipped ones cannot be deleted. */
  remove(id: string) {
    const f = this.file(id);
    if (!f) throw new Error(`Unknown character "${id}"`);
    if (f.builtIn) throw new Error("Los personajes incluidos con la app no se pueden borrar.");
    rmSync(f.path);
    rmSync(join(this.dataDir, "characters", id), { recursive: true, force: true });
    if (this.activeId() === id) rmSync(this.activeFile(), { force: true });
  }
}

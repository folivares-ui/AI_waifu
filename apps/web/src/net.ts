/** Server address helpers shared by the WebSocket and HTTP clients. */
export function serverBase(): { http: string; ws: string; token: string } {
  const params = new URLSearchParams(location.search);
  const token = params.get("token") ?? localStorage.getItem("waifu_token") ?? "";
  if (token) localStorage.setItem("waifu_token", token);
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  const secure = location.protocol === "https:";
  // Vite dev server (5173) talks to the soul server on 8787; when the soul server itself serves the app, use its origin.
  const dev = location.port === "5173";
  const ws = env ?? `${secure ? "wss" : "ws"}://${dev ? `${location.hostname}:8787` : location.host}`;
  return { ws, http: ws.replace(/^ws/, "http"), token };
}

/** Sends a WAV utterance to the server's STT endpoint and returns the transcript. */
export async function transcribe(wav: Uint8Array): Promise<string> {
  const { http, token } = serverBase();
  const res = await fetch(`${http}/stt`, {
    method: "POST",
    headers: { "content-type": "audio/wav", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: new Blob([wav as BlobPart], { type: "audio/wav" }),
  });
  if (!res.ok) throw new Error(`STT ${res.status}`);
  return ((await res.json()) as { text: string }).text.trim();
}

/** Saves a personal file on the server (your 3D model or voice sample) so it loads automatically next time. */
export async function savePersonal(kind: "avatar" | "voice", data: ArrayBuffer | null): Promise<{ ok: boolean; message: string }> {
  const { http, token } = serverBase();
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const init: RequestInit = data ? { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body: data } : { method: "DELETE", headers };
  try {
    const res = await fetch(`${http}/${kind}`, init);
    const body = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
    if (!res.ok) return { ok: false, message: body.error ?? `Error ${res.status}` };
    return { ok: true, message: body.status ?? "" };
  } catch {
    return { ok: false, message: "No se pudo conectar con el servidor." };
  }
}

export interface CharacterInfo {
  id: string;
  name: string;
  builtIn: boolean;
  hasAvatar: boolean;
  hasVoice: boolean;
  active: boolean;
}

export interface NewCharacter {
  name: string;
  persona: string;
  honorific?: string;
  aliases?: string[];
  speechLang?: string;
  speechStyle?: string;
}

/** Calls the server's character API. Errors come back as readable Spanish messages. */
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { http, token } = serverBase();
  const headers: Record<string, string> = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}) };
  let res: Response;
  try {
    res = await fetch(`${http}${path}`, { ...init, headers });
  } catch {
    throw new Error("No se pudo conectar con el servidor.");
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `Error ${res.status}`);
  return body;
}

export const listCharacters = () => api<CharacterInfo[]>("/characters");
export const selectCharacter = (id: string) => api<{ id: string; name: string }>("/characters/active", { method: "POST", body: JSON.stringify({ id }) });
export const createCharacter = (c: NewCharacter) => api<{ id: string }>("/characters", { method: "POST", body: JSON.stringify(c) });
export const deleteCharacter = (id: string) => api<{ removed: string }>(`/characters/${encodeURIComponent(id)}`, { method: "DELETE" });

export interface GrowthView {
  name: string;
  traits: { id: string; name: string; level: number; start: number }[];
  recent: { at: string; trait: string; delta: number; reason: string }[];
}
export const getGrowth = () => api<GrowthView>("/growth");
export const resetGrowth = () => api<GrowthView>("/growth/reset", { method: "POST" });

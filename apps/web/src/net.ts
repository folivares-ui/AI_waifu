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

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, Emotion, ServerMessage, VoiceHints } from "@waifu/core";

export interface ChatLine {
  id: number;
  who: "user" | "soul";
  text: string;
}

function wsUrl(): string {
  const params = new URLSearchParams(location.search);
  const token = params.get("token") ?? localStorage.getItem("waifu_token") ?? "";
  if (token) localStorage.setItem("waifu_token", token);
  const base = import.meta.env.VITE_SERVER_URL ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8787`;
  return `${base}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

/** Connection to the soul server. Sentences arrive ready for TTS. */
export function useSoul(handlers: { onSentence: (text: string, emotion: Emotion) => void; onInterruptedDone: () => void }) {
  const ws = useRef<WebSocket | undefined>(undefined);
  const h = useRef(handlers);
  h.current = handlers;
  const [connected, setConnected] = useState(false);
  const [name, setName] = useState("...");
  const [voice, setVoice] = useState<VoiceHints>({ lang: "es-ES", pitch: 1, rate: 1 });
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [error, setError] = useState<string>();
  const nextId = useRef(1);
  const currentTurn = useRef(0);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const sock = new WebSocket(wsUrl());
      ws.current = sock;
      sock.onopen = () => {
        setConnected(true);
        setError(undefined);
      };
      sock.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 2000);
      };
      sock.onmessage = (ev) => {
        const m = JSON.parse(ev.data) as ServerMessage;
        if (m.type === "ready") {
          setName(m.soul.name);
          setVoice(m.soul.voice);
        } else if (m.type === "token") {
          // Show text live; one chat line per turn.
          setLines((ls) => {
            const last = ls.at(-1);
            if (m.turnId === currentTurn.current && last?.who === "soul") {
              return [...ls.slice(0, -1), { ...last, text: last.text + m.text.replace(/\[emotion:[^\]]*\]?/gi, "") }];
            }
            currentTurn.current = m.turnId;
            return [...ls, { id: nextId.current++, who: "soul", text: m.text.replace(/\[emotion:[^\]]*\]?/gi, "") }];
          });
        } else if (m.type === "sentence") {
          h.current.onSentence(m.text, m.emotion);
        } else if (m.type === "done") {
          if (m.interrupted) h.current.onInterruptedDone();
        } else if (m.type === "error") {
          setError(m.message);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  }, []);

  const sendText = useCallback(
    (text: string) => {
      setLines((ls) => [...ls, { id: nextId.current++, who: "user", text }]);
      send({ type: "user_text", text });
    },
    [send],
  );

  return { connected, name, voice, lines, error, sendText, interrupt: () => send({ type: "interrupt" }) };
}

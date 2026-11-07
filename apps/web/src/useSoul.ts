import { useCallback, useEffect, useRef, useState } from "react";
import type { Capabilities, ClientMessage, Emotion, ServerMessage, VoiceHints } from "@waifu/core";
import { b64ToBuffer, type Clip } from "./player";
import { serverBase } from "./net";

export interface ChatLine {
  id: number;
  who: "user" | "soul";
  text: string;
}

function wsUrl(): string {
  const { ws, token } = serverBase();
  return `${ws}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

/** Connection to the soul server. Sentences arrive ready for TTS. */
export function useSoul(handlers: { onSentence: (text: string, emotion: Emotion) => void; onAudio: (clip: Clip) => void; onInterruptedDone: () => void }) {
  const ws = useRef<WebSocket | undefined>(undefined);
  const h = useRef(handlers);
  h.current = handlers;
  const [connected, setConnected] = useState(false);
  const [name, setName] = useState("...");
  const [voice, setVoice] = useState<VoiceHints>({ lang: "es-ES", pitch: 1, rate: 1 });
  const [caps, setCaps] = useState<Capabilities>({ tts: false, stt: false });
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [error, setError] = useState<string>();
  const [toolStatus, setToolStatus] = useState<string>();
  const nextId = useRef(1);
  const currentTurn = useRef(0);
  // Server turn ids are sequential per connection (n-th user_text = turn n). Anything at or below
  // `ignoreUpTo` belongs to an answer the user already cut off, so late-arriving audio is dropped.
  const sent = useRef(0);
  const ignoreUpTo = useRef(0);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const sock = new WebSocket(wsUrl());
      ws.current = sock;
      sock.onopen = () => {
        sent.current = 0;
        ignoreUpTo.current = 0;
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
          setCaps(m.caps);
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
          if (m.turnId > ignoreUpTo.current) h.current.onSentence(m.text, m.emotion);
        } else if (m.type === "audio") {
          if (m.turnId > ignoreUpTo.current) h.current.onAudio({ data: b64ToBuffer(m.data), emotion: m.emotion, text: m.text });
        } else if (m.type === "tool") {
          setToolStatus(m.status === "start" ? `Consultando ${m.name === "search_apis" ? "el catalogo de APIs" : m.name === "read_api_docs" ? "la documentacion" : "una API"}...` : undefined);
        } else if (m.type === "done") {
          setToolStatus(undefined);
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
      ignoreUpTo.current = sent.current; // a new utterance replaces whatever was being answered
      sent.current++;
      send({ type: "user_text", text });
    },
    [send],
  );

  return { connected, name, voice, caps, toolStatus, lines, error, sendText, interrupt: () => {
      ignoreUpTo.current = sent.current;
      send({ type: "interrupt" });
    },
  };
}

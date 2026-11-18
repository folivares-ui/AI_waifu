import { useCallback, useEffect, useRef, useState } from "react";
import { PROACTIVE_TURN_BASE, type Capabilities, type ClientMessage, type Emotion, type ScreenImage, type ServerMessage, type VoiceHints, type NameConfig, type TouchRegion, type Gesture } from "@waifu/core";
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
const SPEECH_LANG_KEY = "waifu_speech_lang";
export function storedSpeechLang(): string | undefined {
  try {
    return localStorage.getItem(SPEECH_LANG_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function useSoul(handlers: { onSentence: (text: string, emotion: Emotion, speech?: { say: string; lang?: string }) => void; onAudio: (clip: Clip) => void; onInterruptedDone: () => void; onScreenRequest: (requestId: string) => void }) {
  const ws = useRef<WebSocket | undefined>(undefined);
  const h = useRef(handlers);
  h.current = handlers;
  const [connected, setConnected] = useState(false);
  const [name, setName] = useState("...");
  const [voice, setVoice] = useState<VoiceHints>({ lang: "es-ES", pitch: 1, rate: 1 });
  const [names, setNames] = useState<NameConfig>();
  const [caps, setCaps] = useState<Capabilities>({ tts: false, stt: false, vision: false });
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [toolStatus, setToolStatus] = useState<string>();
  const [approvals, setApprovals] = useState<Extract<ServerMessage, { type: "approval_request" }>[]>([]);
  const nextId = useRef(1);
  const currentTurn = useRef(0);
  // Server turn ids are sequential per connection (n-th user_text = turn n). Anything at or below
  // `ignoreUpTo` belongs to an answer the user already cut off, so late-arriving audio is dropped.
  const sent = useRef(0);
  const ignoreUpTo = useRef(0);
  // Soul-initiated (screen observation) turns have their own numbering; same idea.
  const proactiveSeen = useRef(PROACTIVE_TURN_BASE);
  const proactiveIgnoreUpTo = useRef(PROACTIVE_TURN_BASE);
  const dropped = (turnId: number) => {
    if (turnId >= PROACTIVE_TURN_BASE) {
      proactiveSeen.current = Math.max(proactiveSeen.current, turnId);
      return turnId <= proactiveIgnoreUpTo.current;
    }
    return turnId <= ignoreUpTo.current;
  };

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const sock = new WebSocket(wsUrl());
      ws.current = sock;
      sock.onopen = () => {
        sent.current = 0;
        ignoreUpTo.current = 0;
        proactiveSeen.current = PROACTIVE_TURN_BASE;
        proactiveIgnoreUpTo.current = PROACTIVE_TURN_BASE;
        setConnected(true);
        setError(undefined);
      };
      sock.onclose = () => {
        setConnected(false);
        setApprovals([]); // the server forgets pending approvals with the connection
        if (!closed) retry = setTimeout(connect, 2000);
      };
      sock.onmessage = (ev) => {
        const m = JSON.parse(ev.data) as ServerMessage;
        if (m.type === "ready") {
          // Re-apply the spoken language chosen in the settings (kept on this device).
          const chosen = storedSpeechLang();
          if (chosen) ws.current?.send(JSON.stringify({ type: "speech_lang", lang: chosen }));
          setName(m.soul.name);
          setVoice(m.soul.voice);
          setNames(m.soul.names);
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
          if (!dropped(m.turnId)) h.current.onSentence(m.text, m.emotion, m.speech ? { say: m.speech, lang: m.speechLang } : undefined);
        } else if (m.type === "audio") {
          if (!dropped(m.turnId)) h.current.onAudio({ data: b64ToBuffer(m.data), emotion: m.emotion, text: m.text });
        } else if (m.type === "approval_request") {
          setApprovals((a) => [...a, m]);
        } else if (m.type === "approval_cancel") {
          setApprovals((a) => a.filter((x) => x.id !== m.id));
        } else if (m.type === "screen_request") {
          h.current.onScreenRequest(m.requestId);
        } else if (m.type === "tool") {
          setToolStatus(m.status === "start" ? `Consultando ${m.name === "search_apis" ? "el catalogo de APIs" : m.name === "read_api_docs" ? "la documentacion" : "una API"}...` : undefined);
        } else if (m.type === "done") {
          setToolStatus(undefined);
          if (m.interrupted) h.current.onInterruptedDone();
        } else if (m.type === "notice") {
          setNotice(m.message);
          clearTimeout(noticeTimer);
          noticeTimer = setTimeout(() => setNotice(undefined), 8000);
        } else if (m.type === "error") {
          setError(m.message);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(noticeTimer);
      ws.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(msg));
  }, []);

  const sendText = useCallback(
    (text: string, opts: { image?: ScreenImage; source?: "text" | "voice" } = {}) => {
      const { image, source = "text" } = opts;
      setLines((ls) => [...ls, { id: nextId.current++, who: "user", text: image ? `${text} [con captura de pantalla]` : text }]);
      ignoreUpTo.current = sent.current; // a new utterance replaces whatever was being answered
      proactiveIgnoreUpTo.current = proactiveSeen.current;
      sent.current++;
      send({ type: "user_text", text, source, ...(image ? { image } : {}) });
    },
    [send],
  );

  return {
    connected,
    name,
    names,
    voice,
    caps,
    toolStatus,
    lines,
    error,
    notice,
    sendText,
    sendScreenFrame: (requestId: string, image?: ScreenImage, error?: "not_sharing" | "failed") =>
      send({ type: "screen_frame", requestId, ...(image ? { image } : {}), ...(error ? { error } : {}) }),
    sendWatch: (image: ScreenImage) => send({ type: "screen_watch", image }),
    sendTouch: (region: TouchRegion) => send({ type: "touch", region }),
    sendGesture: (gesture: Gesture) => send({ type: "gesture", gesture }),
    /** Language she speaks aloud from now on; remembered on this device. */
    setSpeechLang: (lang: string) => {
      try {
        localStorage.setItem(SPEECH_LANG_KEY, lang);
      } catch {
        /* private mode: still applied for this session */
      }
      send({ type: "speech_lang", lang });
    },
    approvals,
    answerApproval: (id: string, approved: boolean) => {
      const a = approvals.find((x) => x.id === id);
      setApprovals((list) => list.filter((x) => x.id !== id));
      if (a) setLines((ls) => [...ls, { id: nextId.current++, who: "user", text: `${approved ? "✔ Permitido" : "✖ No permitido"}: ${a.summary}` }]);
      send({ type: "approval_response", id, approved });
    },
    interrupt: () => {
      ignoreUpTo.current = sent.current;
      proactiveIgnoreUpTo.current = proactiveSeen.current;
      send({ type: "interrupt" });
    },
  };
}

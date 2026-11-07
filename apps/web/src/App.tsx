import { useEffect, useRef, useState } from "react";
import type { Emotion } from "@waifu/core";
import { Avatar } from "./Avatar";
import { Listener, Speaker, sttSupported } from "./voice";
import { useSoul } from "./useSoul";

export function App() {
  const [emotion, setEmotion] = useState<Emotion>("neutral");
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [headphones, setHeadphones] = useState(false);
  const [text, setText] = useState("");
  const [micError, setMicError] = useState<string>();

  const speaker = useRef<Speaker | undefined>(undefined);
  const listener = useRef<Listener | undefined>(undefined);
  const speakingRef = useRef(false);
  const headphonesRef = useRef(false);
  headphonesRef.current = headphones;
  speakingRef.current = speaking;

  const soul = useSoul({
    onSentence: (t, e) => {
      setEmotion(e);
      speaker.current?.speak(t);
    },
    onInterruptedDone: () => speaker.current?.cancel(),
  });

  useEffect(() => {
    speaker.current ??= new Speaker(soul.voice, setSpeaking);
    speaker.current.setVoice(soul.voice);
  }, [soul.voice]);

  // Avatar relaxes to neutral shortly after finishing speaking.
  useEffect(() => {
    if (speaking) return;
    const t = setTimeout(() => setEmotion("neutral"), 2500);
    return () => clearTimeout(t);
  }, [speaking]);

  const toggleMic = () => {
    if (listening) {
      listener.current?.stop();
      setListening(false);
      return;
    }
    setMicError(undefined);
    listener.current = new Listener(soul.voice.lang, {
      onInterim: () => {
        // Barge-in only with headphones; otherwise our own TTS would trigger it.
        if (speakingRef.current && headphonesRef.current) {
          speaker.current?.cancel();
          soul.interrupt();
        }
      },
      onFinal: (t) => {
        // Without headphones, ignore what the mic picked up while the soul was talking.
        if (speakingRef.current && !headphonesRef.current) return;
        speaker.current?.cancel();
        soul.sendText(t);
      },
      onError: (m) => {
        setMicError(m);
        setListening(false);
      },
    });
    listener.current.start();
    setListening(true);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    speaker.current?.cancel();
    soul.sendText(t);
    setText("");
  };

  return (
    <main>
      <header>
        <h1>{soul.name}</h1>
        <span className={soul.connected ? "dot on" : "dot"} title={soul.connected ? "Conectada" : "Sin conexion"} />
      </header>
      <Avatar emotion={emotion} speaking={speaking} listening={listening} />
      <section className="log" aria-live="polite">
        {soul.lines.slice(-30).map((l) => (
          <p key={l.id} className={l.who}>
            <b>{l.who === "user" ? "Tu" : soul.name}:</b> {l.text}
          </p>
        ))}
      </section>
      {(soul.error || micError) && <p className="err">{soul.error ?? micError}</p>}
      <div className="controls">
        <button onClick={toggleMic} disabled={!sttSupported} className={listening ? "active" : ""}>
          {listening ? "Dejar de escuchar" : "Hablar"}
        </button>
        <label title="Con auriculares puedes interrumpirla hablando. Sin ellos, el microfono captaria su propia voz.">
          <input type="checkbox" checked={headphones} onChange={(e) => setHeadphones(e.target.checked)} /> Uso auriculares
        </label>
        <button onClick={() => { speaker.current?.cancel(); soul.interrupt(); }}>Callar</button>
      </div>
      {!sttSupported && <p className="err">Tu navegador no soporta reconocimiento de voz (usa Chrome o Edge). Puedes escribir.</p>}
      <form onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="O escribe aqui..." />
        <button type="submit">Enviar</button>
      </form>
    </main>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { encodeWav, looksLikeEcho, resample, type Emotion } from "@waifu/core";
import { AvatarStage } from "./AvatarStage";
import { startMic, type MicHandle } from "./mic";
import { transcribe } from "./net";
import { ClipPlayer } from "./player";
import { ScreenShare } from "./screen";
import { useSoul } from "./useSoul";
import { Listener, Speaker, sttSupported } from "./voice";

const ECHO_WINDOW_MS = 1200; // after she stops talking, treat mic input with extra suspicion

export function App() {
  const [emotion, setEmotion] = useState<Emotion>("neutral");
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [headphones, setHeadphones] = useState(false);
  const [status, setStatus] = useState("");
  const [text, setText] = useState("");
  const [micError, setMicError] = useState<string>();
  const [sharing, setSharing] = useState(false);
  const [watching, setWatching] = useState(false);
  const screen = useRef<ScreenShare | undefined>(undefined);
  const watchRef = useRef(false);
  watchRef.current = watching;

  const speaker = useRef<Speaker | undefined>(undefined);
  const player = useRef<ClipPlayer | undefined>(undefined);
  const listener = useRef<Listener | undefined>(undefined);
  const mic = useRef<MicHandle | undefined>(undefined);
  const headphonesRef = useRef(false);
  headphonesRef.current = headphones;
  const spoken = useRef<string[]>([]); // what she said recently, for the echo guard
  const rememberSpoken = (t: string) => (spoken.current = [...spoken.current.slice(-5), t]);

  const getPlayer = () =>
    (player.current ??= new ClipPlayer({
      onStart: (c) => {
        setEmotion(c.emotion);
        setSpeaking(true);
        rememberSpoken(c.text);
      },
      onIdle: () => setSpeaking(false),
    }));
  const busy = () => !!player.current?.playing || speaker.current?.busy === true;
  const stopSpeech = () => {
    player.current?.stop();
    speaker.current?.cancel();
  };

  const soul = useSoul({
    onSentence: (t, e) => {
      setEmotion(e);
      rememberSpoken(t);
      speaker.current?.speak(t);
    },
    onAudio: (clip) => getPlayer().enqueue(clip),
    onInterruptedDone: stopSpeech,
    // The soul asked to look: answer only if the user is sharing (the capture itself is always the user's choice).
    onScreenRequest: (id) => {
      const img = screen.current?.capture();
      if (img) soul.sendScreenFrame(id, img);
      else soul.sendScreenFrame(id, undefined, "not_sharing");
    },
  });
  const { caps, voice } = soul;

  useEffect(() => {
    speaker.current ??= new Speaker(voice, setSpeaking);
    speaker.current.setVoice(voice);
  }, [voice]);

  useEffect(() => {
    if (speaking) return;
    const t = setTimeout(() => setEmotion("neutral"), 2500);
    return () => clearTimeout(t);
  }, [speaking]);

  const getLevel = useCallback(() => (player.current?.playing ? player.current.level() : -1), []);

  // Raise the VAD threshold while she talks so her own voice (echo leftovers) does not trigger us.
  useEffect(() => {
    if (!listening || !caps.stt) return;
    const id = setInterval(() => {
      const ep = mic.current?.endpointer;
      if (!ep) return;
      const recent = performance.now() - (player.current?.lastEnded ?? 0) < ECHO_WINDOW_MS;
      ep.boost = busy() || recent ? (headphonesRef.current ? 1.5 : 3) : 1;
    }, 50);
    return () => clearInterval(id);
  }, [listening, caps.stt]);

  const startServerMic = async () => {
    mic.current = await startMic((ev) => {
      if (ev.type === "speech_start") {
        setStatus("Te escucho...");
        if (busy()) {
          stopSpeech(); // barge-in
          soul.interrupt();
        }
      } else if (ev.type === "discarded") {
        setStatus("");
      } else if (ev.type === "utterance") {
        setStatus("Transcribiendo...");
        const wav = encodeWav(resample(ev.samples, ev.sampleRate, 16000), 16000);
        transcribe(wav)
          .then((t) => {
            setStatus("");
            if (!t) return;
            const recent = performance.now() - (player.current?.lastEnded ?? 0) < ECHO_WINDOW_MS;
            if ((ev.startedDuringBoost || recent) && looksLikeEcho(t, spoken.current)) return; // it was her own voice
            stopSpeech();
            soul.sendText(t);
          })
          .catch((e) => {
            setStatus("");
            setMicError(`No pude transcribir: ${e instanceof Error ? e.message : e}`);
          });
      }
    });
  };

  const startBrowserStt = () => {
    listener.current = new Listener(voice.lang, {
      onInterim: () => {
        if (busy() && headphonesRef.current) {
          stopSpeech();
          soul.interrupt();
        }
      },
      onFinal: (t) => {
        if (busy() && !headphonesRef.current) return;
        stopSpeech();
        soul.sendText(t);
      },
      onError: (m) => {
        setMicError(m);
        setListening(false);
      },
    });
    listener.current.start();
  };

  const toggleMic = async () => {
    if (listening) {
      mic.current?.stop();
      mic.current = undefined;
      listener.current?.stop();
      setListening(false);
      setStatus("");
      return;
    }
    setMicError(undefined);
    void getPlayer().unlock();
    try {
      if (caps.stt) await startServerMic();
      else startBrowserStt();
      setListening(true);
    } catch (e) {
      setMicError(`No pude abrir el microfono: ${e instanceof Error ? e.message : e}`);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    void getPlayer().unlock();
    stopSpeech();
    soul.sendText(t);
    setText("");
  };

  const stopSharing = () => {
    screen.current?.stop();
    setSharing(false);
    setWatching(false);
  };
  const toggleShare = async () => {
    if (sharing) return stopSharing();
    try {
      screen.current ??= new ScreenShare();
      await screen.current.start(() => {
        setSharing(false);
        setWatching(false);
      });
      setSharing(true);
    } catch (e) {
      // NotAllowedError = the user cancelled the picker: not an error worth showing.
      if (!(e instanceof DOMException && e.name === "NotAllowedError")) setMicError(`No pude compartir la pantalla: ${e instanceof Error ? e.message : e}`);
    }
  };
  const askAboutScreen = () => {
    const img = screen.current?.capture();
    if (!img) return setMicError("Primero pulsa 'Compartir pantalla'.");
    void getPlayer().unlock();
    stopSpeech();
    soul.sendText(text.trim() || "Mira mi pantalla. ¿Que ves y como podria mejorarlo?", img);
    setText("");
  };

  // Continuous observation: look for changes every few seconds; the server rate-limits what she actually says.
  useEffect(() => {
    if (!watching) return;
    const id = setInterval(() => {
      const s = screen.current;
      if (!s?.active || busy() || !s.changed()) return;
      const img = s.capture(1024, 0.6);
      if (img) soul.sendWatch(img);
    }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching]);

  const canListen = caps.stt || sttSupported;
  return (
    <main>
      <header>
        <h1>{soul.name}</h1>
        <span className={soul.connected ? "dot on" : "dot"} title={soul.connected ? "Conectada" : "Sin conexion"} />
        <small className="mode">
          voz: {caps.stt ? "servidor" : "navegador"} / {caps.tts ? "servidor" : "navegador"}
        </small>
      </header>
      <AvatarStage emotion={emotion} speaking={speaking} listening={listening} getLevel={getLevel} />
      <section className="log" aria-live="polite">
        {soul.lines.slice(-30).map((l) => (
          <p key={l.id} className={l.who}>
            <b>{l.who === "user" ? "Tu" : soul.name}:</b> {l.text}
          </p>
        ))}
        {(status || soul.toolStatus) && <p className="status">{soul.toolStatus ?? status}</p>}
      </section>
      {sharing && (
        <p className="sharing" role="status">
          <span className="rec" /> {watching ? "Observando tu pantalla" : "Pantalla compartida"} (nada se guarda; solo se envia al servidor cuando ella mira)
        </p>
      )}
      {(soul.error || micError) && <p className="err">{micError ?? soul.error}</p>}
      <div className="controls">
        <button onClick={() => void toggleMic()} disabled={!canListen} className={listening ? "active" : ""}>
          {listening ? "Dejar de escuchar" : "Hablar"}
        </button>
        <label title="Con auriculares la interrupcion por voz es mas sensible.">
          <input type="checkbox" checked={headphones} onChange={(e) => setHeadphones(e.target.checked)} /> Uso auriculares
        </label>
        <button onClick={() => { stopSpeech(); soul.interrupt(); }}>Callar</button>
      </div>
      {soul.caps.vision && ScreenShare.supported && (
        <div className="controls">
          <button onClick={() => void toggleShare()} className={sharing ? "active" : ""} title="Elige una VENTANA concreta en vez de toda la pantalla para no mostrar otras apps.">
            {sharing ? "Dejar de compartir" : "Compartir pantalla"}
          </button>
          <button onClick={askAboutScreen} disabled={!sharing}>Preguntar por mi pantalla</button>
          <label title="Ella comentara de vez en cuando si ve algo util (como mucho una vez cada ~25 s, solo si la pantalla cambio).">
            <input type="checkbox" checked={watching} disabled={!sharing} onChange={(e) => setWatching(e.target.checked)} /> Observacion continua
          </label>
        </div>
      )}
      {!canListen && <p className="err">Tu navegador no soporta reconocimiento de voz (usa Chrome o Edge) y el servidor no tiene STT. Puedes escribir.</p>}
      <form onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="O escribe aqui..." />
        <button type="submit">Enviar</button>
      </form>
    </main>
  );
}

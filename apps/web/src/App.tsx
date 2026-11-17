import { useCallback, useEffect, useRef, useState } from "react";
import { encodeWav, looksLikeEcho, matchName, resample, type Emotion, type ScreenImage } from "@waifu/core";
import { ApprovalCard } from "./ApprovalCard";
import { AvatarStage } from "./AvatarStage";
import { CameraIcon, CloseIcon, EyeIcon, GearIcon, MicIcon, RoseIcon, ScreenIcon, SendIcon, StopIcon } from "./icons";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    // Without audio output, speak the sentence with the system voice (if any) instead of losing it.
    onAudio: (clip) => (getPlayer().available ? getPlayer().enqueue(clip) : speaker.current?.speak(clip.text)),
    onInterruptedDone: stopSpeech,
    // The soul asked to look: answer only if the user is sharing (the capture itself is always the user's choice).
    onScreenRequest: (id) => {
      const img = screen.current?.capture();
      if (img) soul.sendScreenFrame(id, img);
      else soul.sendScreenFrame(id, undefined, "not_sharing");
    },
  });
  const { caps, voice } = soul;

  /** Sends a message; if it calls her by name she reacts at once (ears up), before the answer arrives. */
  const say = (t: string, opts: { image?: ScreenImage; source?: "text" | "voice" } = {}) => {
    if (matchName(t, soul.names).addressed) setEmotion("surprised");
    soul.sendText(t, opts);
  };

  // Errors are shown as a toast that goes away by itself.
  const errorText = micError ?? soul.error;
  useEffect(() => {
    if (!micError) return;
    const t = setTimeout(() => setMicError(undefined), 7000);
    return () => clearTimeout(t);
  }, [micError]);

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
            say(t, { source: "voice" });
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
        say(t, { source: "voice" });
      },
      onError: (m) => {
        setMicError(m);
        setListening(false);
      },
    });
    listener.current.start();
  };

  const toggleMicRef = useRef<() => void>(() => {});
  // Desktop shell: global push-to-talk shortcut (Ctrl+Shift+Space) dispatches this event.
  useEffect(() => {
    const h = () => toggleMicRef.current();
    window.addEventListener("waifu:toggle-mic", h);
    return () => window.removeEventListener("waifu:toggle-mic", h);
  }, []);

  const toggleMic = async () => {
    if (listening) {
      mic.current?.stop();
      mic.current = undefined;
      listener.current?.stop();
      setListening(false);
      setStatus("");
      return;
    }
    if (!caps.stt && !sttSupported) return setMicError("Este navegador no tiene reconocimiento de voz: configura STT_PROVIDER en el servidor.");
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

  toggleMicRef.current = () => void toggleMic();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    void getPlayer().unlock();
    stopSpeech();
    say(t);
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
    say(text.trim() || "Mira mi pantalla. ¿Que ves y como podria mejorarlo?", { image: img });
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
  const short = soul.names?.aliases.at(-1) ?? soul.name;
  const mood = !soul.connected
    ? "Sin conexion"
    : soul.toolStatus ?? (status || (speaking ? "Hablando..." : listening ? "Te escucho..." : "En linea"));

  return (
    <div className="app">
      <AvatarStage emotion={emotion} speaking={speaking} listening={listening} getLevel={getLevel} onTouch={(r) => soul.sendTouch(r)} />
      <div className="veil veil-top" aria-hidden="true" />
      <div className="veil veil-bottom" aria-hidden="true" />

      <header className="topbar">
        <div className="title">
          <span className="crest" aria-hidden="true">
            <RoseIcon size={18} />
          </span>
          <div>
            <h1>{soul.name}</h1>
            <p className="mood">
              <span className={soul.connected ? "dot on" : "dot"} aria-hidden="true" /> {mood}
            </p>
          </div>
        </div>
        <div className="top-actions">
          <button type="button" className="chip" aria-label="Capturar" title="Guardar una foto de ella" onClick={() => window.dispatchEvent(new CustomEvent("waifu:capture", { detail: { name: soul.name } }))}>
            <CameraIcon size={18} /> <span>Capturar</span>
          </button>
          <button type="button" className="round small" aria-label="Ajustes" title="Ajustes" onClick={() => setSettingsOpen(true)}>
            <GearIcon size={20} />
          </button>
        </div>
      </header>

      {sharing && (
        <div className="sharing" role="status">
          <span className="rec" aria-hidden="true" /> {watching ? "Observando tu pantalla" : "Pantalla compartida"}
          <label className="switch" title="Ella comentara de vez en cuando si ve algo util (como mucho una vez cada ~25 s, solo si la pantalla cambio).">
            <input type="checkbox" checked={watching} onChange={(e) => setWatching(e.target.checked)} /> Observacion continua
          </label>
        </div>
      )}

      <div className={`bottom${soul.approvals.length ? " asking" : ""}`}>
        <section className="log" aria-live="polite" aria-label="Conversacion">
          {soul.lines.slice(-30).map((l) => (
            <p key={l.id} className={`bubble ${l.who}`}>
              {l.who === "soul" && <b>{soul.name}</b>}
              <span>{l.text}</span>
            </p>
          ))}
        </section>

        {soul.approvals.map((r) => (
          <ApprovalCard key={r.id} req={r} name={short} onAnswer={(ok) => soul.answerApproval(r.id, ok)} />
        ))}

        <div className="dock">
          <div className="controls">
            {soul.caps.vision && ScreenShare.supported && (
              <button
                type="button"
                className={`round${sharing ? " on" : ""}`}
                aria-label={sharing ? "Dejar de compartir" : "Compartir pantalla"}
                title={sharing ? "Dejar de compartir la pantalla" : "Compartir una ventana (mejor que toda la pantalla)"}
                onClick={() => void toggleShare()}
              >
                <ScreenIcon />
              </button>
            )}
            {soul.caps.vision && ScreenShare.supported && (
              <button type="button" className="round" aria-label="Preguntar por mi pantalla" title="Preguntarle por lo que se ve en tu pantalla" onClick={askAboutScreen} disabled={!sharing}>
                <EyeIcon />
              </button>
            )}
            <button
              type="button"
              className={`mic${listening ? " on" : ""}`}
              aria-label={listening ? "Dejar de escuchar" : "Hablar"}
              aria-pressed={listening}
              title={canListen ? (listening ? "Dejar de escuchar" : `Hablar con ${short}`) : "Sin reconocimiento de voz aqui: escribele o configura STT_PROVIDER"}
              onClick={() => void toggleMic()}
              disabled={!canListen}
            >
              <MicIcon size={30} />
            </button>
            <button type="button" className="round" aria-label="Callar" title="Que deje de hablar" onClick={() => { stopSpeech(); soul.interrupt(); }}>
              <StopIcon />
            </button>
          </div>
          <form className="composer" onSubmit={submit}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Escribele a ${short}...`} aria-label={`Mensaje para ${soul.name}`} />
            <button type="submit" className="send" aria-label="Enviar" disabled={!text.trim()}>
              <SendIcon size={18} /> <span>Enviar</span>
            </button>
          </form>
        </div>
      </div>

      {errorText && (
        <p className="toast" role="alert">
          {errorText}
        </p>
      )}

      {settingsOpen && (
        <div className="sheet-backdrop" onClick={() => setSettingsOpen(false)}>
          <section className="sheet" role="dialog" aria-modal="true" aria-label="Ajustes" onClick={(e) => e.stopPropagation()}>
            <header>
              <h2>Ajustes</h2>
              <button type="button" className="round small" aria-label="Cerrar ajustes" onClick={() => setSettingsOpen(false)}>
                <CloseIcon size={18} />
              </button>
            </header>
            <label className="row">
              <span>
                Uso auriculares
                <small>Permite interrumpirla hablando con mas sensibilidad.</small>
              </span>
              <input type="checkbox" checked={headphones} onChange={(e) => setHeadphones(e.target.checked)} />
            </label>
            <label className="row file">
              <span>
                Cambiar modelo 3D
                <small>Carga otro archivo .vrm solo para esta sesion.</small>
              </span>
              <span className="btn">Elegir .vrm</span>
              <input type="file" accept=".vrm,.glb" hidden onChange={(e) => e.target.files?.[0] && window.dispatchEvent(new CustomEvent("waifu:load-model", { detail: e.target.files[0] }))} />
            </label>
            <div className="row info">
              <span>
                Voz
                <small>
                  Oido: {caps.stt ? "servidor" : sttSupported ? "navegador" : "no disponible (escribe)"} · Habla: {caps.tts ? "servidor" : "navegador"}
                </small>
              </span>
            </div>
            <div className="row info">
              <span>
                Atajo en la app de escritorio
                <small>Ctrl + Mayus + Espacio activa o desactiva el microfono desde cualquier programa.</small>
              </span>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

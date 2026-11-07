import { useEffect, useState } from "react";
import type { Emotion } from "@waifu/core";

const BROWS: Record<Emotion, { l: string; r: string }> = {
  neutral: { l: "M62 78 Q75 74 88 78", r: "M112 78 Q125 74 138 78" },
  happy: { l: "M62 76 Q75 70 88 76", r: "M112 76 Q125 70 138 76" },
  sad: { l: "M62 74 Q75 80 88 80", r: "M112 80 Q125 80 138 74" },
  angry: { l: "M62 72 L88 80", r: "M112 80 L138 72" },
  surprised: { l: "M62 68 Q75 62 88 68", r: "M112 68 Q125 62 138 68" },
  thinking: { l: "M62 78 Q75 74 88 78", r: "M112 70 Q125 66 138 72" },
  shy: { l: "M62 76 Q75 74 88 78", r: "M112 78 Q125 74 138 76" },
};

/**
 * Placeholder 2D avatar (pure SVG, no assets). The `Avatar` props are the contract a
 * Live2D / VRM renderer will implement later: an emotion + a speaking flag.
 */
export function Avatar({ emotion, speaking, listening }: { emotion: Emotion; speaking: boolean; listening: boolean }) {
  const [mouthOpen, setMouthOpen] = useState(0);
  const [blink, setBlink] = useState(false);

  useEffect(() => {
    if (!speaking) return setMouthOpen(0);
    const id = setInterval(() => setMouthOpen(Math.random()), 110);
    return () => clearInterval(id);
  }, [speaking]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      setBlink(true);
      setTimeout(() => setBlink(false), 130);
      t = setTimeout(loop, 2200 + Math.random() * 3000);
    };
    t = setTimeout(loop, 2500);
    return () => clearTimeout(t);
  }, []);

  const brows = BROWS[emotion];
  const eyeH = blink ? 1 : emotion === "surprised" ? 12 : emotion === "happy" ? 5 : 9;
  const smile = emotion === "happy" ? 8 : emotion === "sad" || emotion === "angry" ? -6 : 2;
  const my = 128;
  const mh = 2 + mouthOpen * 12;

  return (
    <svg viewBox="0 0 200 220" className={`avatar${listening ? " listening" : ""}`} role="img" aria-label={`Avatar, emocion ${emotion}`}>
      <path d="M30 120 Q30 20 100 20 Q170 20 170 120 L170 190 Q100 215 30 190 Z" fill="#7a5cff" />
      <ellipse cx="100" cy="110" rx="62" ry="72" fill="#ffe3d3" />
      <path d="M38 105 Q60 40 100 52 Q140 40 162 105 Q140 70 100 78 Q60 70 38 105Z" fill="#7a5cff" />
      <path d={brows.l} stroke="#4b2fb5" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d={brows.r} stroke="#4b2fb5" strokeWidth="3" fill="none" strokeLinecap="round" />
      <ellipse cx="75" cy="98" rx="9" ry={eyeH} fill="#2b1b5e" />
      <ellipse cx="125" cy="98" rx="9" ry={eyeH} fill="#2b1b5e" />
      {!blink && <circle cx="78" cy="95" r="2.5" fill="#fff" />}
      {!blink && <circle cx="128" cy="95" r="2.5" fill="#fff" />}
      {emotion === "shy" && (
        <>
          <ellipse cx="60" cy="118" rx="10" ry="5" fill="#ff9bb0" opacity=".7" />
          <ellipse cx="140" cy="118" rx="10" ry="5" fill="#ff9bb0" opacity=".7" />
        </>
      )}
      {speaking ? (
        <ellipse cx="100" cy={my + 2} rx="11" ry={mh} fill="#8a2d4a" />
      ) : (
        <path d={`M84 ${my} Q100 ${my + smile * 2} 116 ${my}`} stroke="#8a2d4a" strokeWidth="3" fill="none" strokeLinecap="round" />
      )}
    </svg>
  );
}

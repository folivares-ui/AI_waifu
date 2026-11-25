import { lazy, Suspense, useEffect, useState } from "react";
import { Avatar as SvgAvatar } from "./Avatar";
import { savePersonal, serverBase } from "./net";
import type { AvatarProps, TouchFx } from "./VrmAvatar";

// three.js is large: only load it when a VRM model is actually available.
const VrmAvatar = lazy(() => import("./VrmAvatar").then((m) => ({ default: m.VrmAvatar })));

const isGlb = (b: ArrayBuffer) => new TextDecoder().decode(b.slice(0, 4)) === "glTF";

/** Shows the anime VRM model if present at /avatars/default.vrm (or loaded by the user), else the simple SVG face. */
export function AvatarStage({ character = "", ...props }: AvatarProps & { character?: string }) {
  const [model, setModel] = useState<ArrayBuffer | null>(null);
  const [fx, setFx] = useState<(TouchFx & { id: number })[]>([]);

  // The model of the active character (the query only keeps browsers from reusing another character's model).
  // Always from the soul server (in development the page itself comes from another server with its own files).
  const fetchSaved = () =>
    fetch(`${serverBase().http}/avatars/default.vrm?c=${encodeURIComponent(character)}&t=${Date.now()}`, { headers: serverBase().token ? { authorization: `Bearer ${serverBase().token}` } : {} })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => (b && isGlb(b) ? b : null)) // dev servers may answer 200 with index.html
      .catch(() => null);
  useEffect(() => {
    let cancelled = false;
    void fetchSaved().then((b) => !cancelled && b && setModel(b));
    return () => {
      cancelled = true;
    };
  }, []);

  // "Cambiar modelo 3D" in the settings sheet.
  useEffect(() => {
    const h = (e: Event) => void pick((e as CustomEvent<File>).detail);
    window.addEventListener("waifu:load-model", h);
    return () => window.removeEventListener("waifu:load-model", h);
  });

  const pick = async (file?: File) => {
    if (!file) return;
    const b = await file.arrayBuffer();
    if (!isGlb(b)) return alert("Ese archivo no parece un modelo VRM/GLB valido.");
    setModel(b);
    // Keep it: next time the app opens with this model, no need to load it again.
    const r = await savePersonal("avatar", b);
    if (!r.ok) return alert(`El modelo se muestra, pero no se pudo guardar: ${r.message}`);
    // The server may have repaired it (bones recognised, resized, a skeleton that did not fit replaced): show
    // the saved model, as it will be next time, not the file as picked.
    const saved = await fetchSaved();
    if (saved) setModel(saved);
  };

  return (
    <div
      className="stage"
      data-speaking={props.speaking}
      ref={(el) => {
        if (!el || (el as HTMLDivElement & { __fx?: boolean }).__fx) return;
        (el as HTMLDivElement & { __fx?: boolean }).__fx = true;
        let n = 0;
        el.addEventListener("waifu:touch-fx", (e) => {
          const d = (e as CustomEvent<TouchFx>).detail;
          const id = ++n;
          setFx((list) => [...list.slice(-14), { ...d, id }]);
          setTimeout(() => setFx((list) => list.filter((f) => f.id !== id)), 1200);
        });
      }}
    >
      {model ? (
        <Suspense fallback={<div className="vrm" />}>
          <VrmAvatar data={model} {...props} />
        </Suspense>
      ) : (
        <SvgAvatar emotion={props.emotion} speaking={props.speaking} listening={props.listening} />
      )}
      {fx.map((f) => (
        <span key={f.id} className="touch-fx" aria-hidden="true" style={{ left: f.x, top: f.y, color: f.color, ["--drift" as string]: `${(f.id % 5) * 9 - 18}px` }}>
          {f.glyph}
        </span>
      ))}
    </div>
  );
}

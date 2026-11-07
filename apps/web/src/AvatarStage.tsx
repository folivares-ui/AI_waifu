import { lazy, Suspense, useEffect, useState } from "react";
import { Avatar as SvgAvatar } from "./Avatar";
import type { AvatarProps } from "./VrmAvatar";

// three.js is large: only load it when a VRM model is actually available.
const VrmAvatar = lazy(() => import("./VrmAvatar").then((m) => ({ default: m.VrmAvatar })));

const isGlb = (b: ArrayBuffer) => new TextDecoder().decode(b.slice(0, 4)) === "glTF";

/** Shows the anime VRM model if present at /avatars/default.vrm (or loaded by the user), else the simple SVG face. */
export function AvatarStage(props: AvatarProps) {
  const [model, setModel] = useState<ArrayBuffer | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/avatars/default.vrm")
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => !cancelled && b && isGlb(b) && setModel(b)) // dev servers may answer 200 with index.html
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const pick = async (file?: File) => {
    if (!file) return;
    const b = await file.arrayBuffer();
    if (isGlb(b)) setModel(b);
    else alert("Ese archivo no parece un modelo VRM/GLB valido.");
  };

  return (
    <div className="stage" data-speaking={props.speaking}>
      {model ? (
        <Suspense fallback={<div className="vrm" />}>
          <VrmAvatar data={model} {...props} />
        </Suspense>
      ) : (
        <SvgAvatar emotion={props.emotion} speaking={props.speaking} listening={props.listening} />
      )}
      <label className="load-vrm">
        Cargar modelo VRM
        <input type="file" accept=".vrm,.glb" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      </label>
    </div>
  );
}

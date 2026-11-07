import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { Emotion } from "@waifu/core";

export interface AvatarProps {
  emotion: Emotion;
  speaking: boolean;
  listening: boolean;
  /** Live loudness 0..1 of her voice, for lip-sync. If absent while speaking, a flap is simulated. */
  getLevel?: () => number;
}

/** Expression weights (VRM preset names) and gaze/head offsets per emotion. */
const POSES: Record<Emotion, { expr: Record<string, number>; look: [number, number]; tilt: number }> = {
  neutral: { expr: {}, look: [0, 0], tilt: 0 },
  happy: { expr: { happy: 0.9 }, look: [0, 0.03], tilt: 0.04 },
  sad: { expr: { sad: 1 }, look: [0, -0.15], tilt: -0.03 },
  angry: { expr: { angry: 1 }, look: [0, 0], tilt: 0 },
  surprised: { expr: { surprised: 1 }, look: [0, 0.05], tilt: 0 },
  thinking: { expr: { relaxed: 0.4 }, look: [0.25, 0.25], tilt: 0.09 },
  shy: { expr: { relaxed: 0.7 }, look: [-0.15, -0.2], tilt: 0.1 },
};
const EXPR_NAMES = ["happy", "sad", "angry", "surprised", "relaxed", "aa", "oh", "ih", "blink"];

/** `?capture=face` renders a transparent face close-up (used by scripts/make-icons.mjs to build app icons). */
const CAPTURE_FACE = new URLSearchParams(location.search).get("capture") === "face";
if (CAPTURE_FACE) document.body.classList.add("capture");

export function VrmAvatar({ data, ...props }: AvatarProps & { data: ArrayBuffer }) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  live.current = props;

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(24, 1, 0.1, 20);
    const key = new THREE.DirectionalLight(0xffffff, Math.PI);
    key.position.set(0.6, 1, 1.2);
    scene.add(key, new THREE.AmbientLight(0xffffff, 0.6));
    const gaze = new THREE.Object3D(); // what her eyes follow
    scene.add(gaze);

    let vrm: VRM | undefined;
    let raf = 0;
    let disposed = false;
    const timer = new THREE.Timer();
    const cur: Record<string, number> = Object.fromEntries(EXPR_NAMES.map((n) => [n, 0]));
    let nextBlink = 1.5;
    let blinkT = -1;

    const resize = () => {
      const w = el.clientWidth || 300;
      const h = el.clientHeight || 360;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    const loader = new GLTFLoader();
    loader.register((p) => new VRMLoaderPlugin(p));
    loader
      .parseAsync(data.slice(0), "")
      .then((gltf) => {
        if (disposed) return;
        const v = gltf.userData.vrm as VRM;
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);
        VRMUtils.rotateVRM0(v); // no-op for VRM 1.0, turns VRM 0.x models to face the camera
        scene.add(v.scene);
        vrm = v;
        // Relaxed pose instead of the default T-pose.
        const bone = (n: string) => v.humanoid.getNormalizedBoneNode(n as never);
        const set = (n: string, x: number, y: number, z: number) => bone(n)?.rotation.set(x, y, z);
        // VRM 0.x normalized bones are mirrored relative to VRM 1.0 (after rotateVRM0), so flip the sign.
        const k = v.meta.metaVersion === "0" ? -1 : 1;
        set("leftUpperArm", 0, 0, -1.2 * k);
        set("rightUpperArm", 0, 0, 1.2 * k);
        set("leftLowerArm", 0, 0, -0.1 * k);
        set("rightLowerArm", 0, 0, 0.1 * k);
        v.scene.updateMatrixWorld(true);
        const head = bone("head")!.getWorldPosition(new THREE.Vector3());
        // The head bone sits at the base of the skull: frame from above the hair down to the chest.
        if (CAPTURE_FACE) {
          camera.position.set(0, head.y + 0.045, 1.15);
          camera.lookAt(0, head.y + 0.045, 0);
        } else {
          camera.position.set(0, head.y - 0.05, 1.6);
          camera.lookAt(0, head.y - 0.07, 0);
        }
        gaze.position.set(0, head.y + 0.08, 1.6);
        if (v.lookAt) v.lookAt.target = gaze;
      })
      .catch((e) => console.error("VRM load failed", e));

    const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      timer.update();
      const dt = Math.min(timer.getDelta(), 0.1);
      const t = timer.getElapsed();
      if (!vrm) return renderer.render(scene, camera);
      const p = live.current;
      const pose = POSES[p.emotion];

      // Targets
      const target: Record<string, number> = Object.fromEntries(EXPR_NAMES.map((n) => [n, 0]));
      Object.assign(target, pose.expr);
      if (p.speaking) {
        const raw = p.getLevel?.() ?? -1; // negative = no audio signal (browser voice): simulate flapping
        const lvl = raw >= 0 ? raw : 0.35 + 0.35 * Math.sin(t * 13) * Math.sin(t * 5.3);
        const open = Math.min(0.8, lvl * 2.2); // leave room for the emotion to stay visible
        const shape = (Math.sin(t * 6.1) + 1) / 2; // vary vowels a little
        target.aa = open * (0.55 + 0.45 * shape);
        target.oh = open * (1 - shape) * 0.5;
        target.ih = open * shape * 0.25;
      }
      // Blinking
      if (!CAPTURE_FACE && blinkT < 0 && t > nextBlink) blinkT = 0; // icons: never capture mid-blink
      if (blinkT >= 0) {
        blinkT += dt;
        target.blink = Math.sin(Math.min(1, blinkT / 0.16) * Math.PI);
        if (blinkT > 0.16) {
          blinkT = -1;
          nextBlink = t + 2 + Math.random() * 3.5;
        }
      }
      for (const n of EXPR_NAMES) {
        const fast = n === "aa" || n === "oh" || n === "ih" || n === "blink";
        cur[n] = lerp(cur[n], target[n], Math.min(1, dt * (fast ? 22 : 6)));
        vrm.expressionManager?.setValue(n, cur[n]);
      }

      // Gaze + idle body motion
      gaze.position.x = lerp(gaze.position.x, pose.look[0], dt * 4);
      gaze.position.y = lerp(gaze.position.y, (vrm.humanoid.getNormalizedBoneNode("head")?.getWorldPosition(new THREE.Vector3()).y ?? 1.4) + 0.08 + pose.look[1], dt * 4);
      const head = vrm.humanoid.getNormalizedBoneNode("head");
      if (head) {
        const nod = p.speaking ? Math.sin(t * 3.2) * 0.025 : 0;
        head.rotation.x = lerp(head.rotation.x, Math.sin(t * 0.9) * 0.02 + nod + (p.listening ? 0.03 : 0), dt * 5);
        head.rotation.y = lerp(head.rotation.y, Math.sin(t * 0.55) * 0.05, dt * 3);
        head.rotation.z = lerp(head.rotation.z, pose.tilt + (p.listening ? 0.03 : 0), dt * 3);
      }
      const spine = vrm.humanoid.getNormalizedBoneNode("spine");
      if (spine) spine.rotation.x = Math.sin(t * 1.5) * 0.012;
      const chest = vrm.humanoid.getNormalizedBoneNode("chest");
      if (chest) chest.rotation.x = Math.sin(t * 1.5 + 0.4) * 0.01;

      vrm.update(dt);
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (vrm) {
        scene.remove(vrm.scene);
        VRMUtils.deepDispose(vrm.scene);
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [data]);

  return <div ref={host} className="vrm" role="img" aria-label={`Avatar, emocion ${props.emotion}`} />;
}

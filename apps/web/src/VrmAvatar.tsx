import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import type { Emotion, LookStyle, MotionStyle, TouchRegion } from "@waifu/core";
import { addSpringChains, faceFraming, fullFraming, hideHelperMeshes, meshLyingDown, setToonBrightness, standUpright, toonify } from "./avatarFixups";
import { collectParts } from "./modelParts";
import { BODY_BONES, FINGER_NAMES, FINGER_SEGMENT_BEND, bodyPose, fingerCurl } from "./bodyMotion";
import { solveArmPoses, type ArmSolutions } from "./armIK";
import { TorsoGuard } from "./torsoGuard";
import { measureArmLift } from "./restPose";
import { BoneFaceRig, CHANNEL_NAMES, RIG_POSES, type Channel } from "./boneFace";
import { REACTIONS, StrokeTracker, TouchMap, envelope } from "./petting";

export interface AvatarProps {
  emotion: Emotion;
  speaking: boolean;
  listening: boolean;
  /** Live loudness 0..1 of her voice, for lip-sync. If absent while speaking, a flap is simulated. */
  getLevel?: () => number;
  /** She was stroked on this body region with the cursor (fires once per stroke, at most every ~2.5 s per region). */
  onTouch?: (region: TouchRegion) => void;
  /** Model parts to hide (e.g. a weapon in her hand), by part name (see modelParts.ts). */
  hiddenParts?: string[];
  /** Called once the model is loaded, with the names of its parts. */
  onParts?: (parts: string[]) => void;
  /** How lively this character's body is (soul "motion"). */
  motion?: MotionStyle;
  /** How her model is drawn (soul "look"). */
  look?: LookStyle;
}

/** Floating hearts / sweat drops next to the cursor (rendered by AvatarStage). */
export interface TouchFx {
  x: number;
  y: number;
  glyph: string;
  color: string;
}

/** Expression weights (VRM preset names) and gaze/head offsets per emotion. */
const POSES: Record<Emotion, { expr: Record<string, number>; look: [number, number]; tilt: number; yaw?: number; chinUp?: number }> = {
  neutral: { expr: {}, look: [0, 0], tilt: 0 },
  happy: { expr: { happy: 0.9 }, look: [0, 0.03], tilt: 0.04 },
  sad: { expr: { sad: 1 }, look: [0, -0.15], tilt: -0.03 },
  // Tsundere "hmph": head turned away with the chin up, eyes still glaring at you from the side.
  angry: { expr: { angry: 1 }, look: [0, 0], tilt: 0.06, yaw: 0.38, chinUp: 0.1 },
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
  const parts = useRef<Map<string, THREE.Object3D[]>>(new Map());
  const applyHidden = () => {
    const hide = new Set(live.current.hiddenParts ?? []);
    for (const [name, objs] of parts.current) for (const o of objs) o.visible = !hide.has(name);
  };
  // Hide/show parts whenever the choice changes.
  useEffect(applyHidden, [props.hiddenParts]);
  // Per-character brightness (converted models), also when it arrives after the model.
  const model = useRef<VRM | undefined>(undefined);
  useEffect(() => {
    if (model.current) setToonBrightness(model.current, props.look?.brightness ?? 1);
  }, [props.look?.brightness]);

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
    // Models without expressions but with facial bones are animated through this rig instead.
    let rig: BoneFaceRig | undefined;
    let armPoses: ArmSolutions = {};
    let torso: TorsoGuard | undefined;
    let armLift = { left: 0, right: 0 };
    /** Extra outward opening of the hanging arms per mood, measured on her body at load. */
    const clearance: Partial<Record<Emotion, { left: number; right: number }>> = {};
    let voiceLevelSmooth = 0;
    const poseState = new Map<string, [number, number, number]>();
    let springs: ReturnType<typeof addSpringChains>;
    const rigCur = Object.fromEntries(CHANNEL_NAMES.map((n) => [n, 0])) as Record<Channel, number>;
    let nextTwitch = 3;
    // Petting
    let touchMap: TouchMap | undefined;
    const strokes = new StrokeTracker();
    const pointer = { x: 0, y: 0, moved: 0, inside: false, lastMove: -1, lastFx: 0 };
    let reaction: { region: TouchRegion; start: number; lastActive: number; side: number } | undefined;
    const canvas = renderer.domElement;
    canvas.style.touchAction = "none"; // strokes with a finger on touch screens
    const onPointerMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (pointer.inside) pointer.moved += Math.hypot(x - pointer.x, y - pointer.y);
      Object.assign(pointer, { x, y, inside: true, lastMove: timer.getElapsed() });
    };
    const onPointerLeave = () => {
      pointer.inside = false;
      pointer.moved = 0;
      canvas.style.cursor = "";
    };
    canvas.addEventListener("pointermove", onPointerMove);
    // She waves back when you wave at the camera.
    let waveStart = -10;
    const fingerState = new Map<string, number>();
    const onWave = () => (waveStart = timer.getElapsed());
    window.addEventListener("waifu:avatar-wave", onWave);
    canvas.addEventListener("pointerleave", onPointerLeave);
    let twitchT = -1;
    let twitchSide: Channel = "earTwitchL";

    let frame: () => void = () => {}; // re-aims the camera for the current window shape
    const resize = () => {
      const w = el.clientWidth || 300;
      const h = el.clientHeight || 360;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      frame();
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
        standUpright(v); // converted models can come lying down or facing away
        if (meshLyingDown(v)) {
          console.warn("[avatar] the body mesh does not stand like its skeleton (re-rigged model?)");
          window.dispatchEvent(new CustomEvent("waifu:avatar-problem", { detail: "Este modelo tiene el cuerpo tumbado respecto a su esqueleto (pasa con algunas herramientas de auto-rigging). Carga el modelo original: la app reconoce sola sus huesos." }));
        }
        scene.add(v.scene);
        // Repairs for models converted from other formats (no-ops for proper VRM models).
        const hidden = hideHelperMeshes(v);
        // Parts the user can hide (helper meshes hidden above are not offered).
        parts.current = new Map([...collectParts(v.scene)].map(([n, objs]) => [n, objs.filter((o) => o.visible)] as const).filter(([, objs]) => objs.length > 0));
        applyHidden();
        live.current.onParts?.([...parts.current.keys()]);
        const tooned = toonify(v);
        setToonBrightness(v, live.current.look?.brightness ?? 1);
        rig = BoneFaceRig.detect(v); // must run in the rest pose
        armLift = measureArmLift(v); // A-pose models: lift the arms back to the T-pose the poses are written for
        torso = TorsoGuard.measure(v); // her real body shape, so the arms never go through it
        armPoses = solveArmPoses(v, torso, armLift.left); // hands on the hips, at the chin... for her proportions, outside her body
        if (import.meta.env.DEV) console.info(`[avatar] arm lift (A-pose correction): ${JSON.stringify(armLift)}`);
        // How far the hanging-arm poses must open so the arms clear her body (wide hips, bulky clothes...).
        if (torso) {
          const kk = v.meta.metaVersion === "0" ? -1 : 1;
          for (const emo of ["neutral", "happy", "sad"] as Emotion[]) {
            const pose0 = bodyPose({ t: 0, emotion: emo, speaking: false, level: 0, listening: false, arms: armPoses });
            for (const name of BODY_BONES) {
              const e = pose0[name];
              const b = v.humanoid.getNormalizedBoneNode(name as never);
              if (e && b && name !== "spine" && name !== "chest") b.rotation.set(e[0] * kk, e[1], e[2] * kk + (name === "leftUpperArm" ? armLift.left : name === "rightUpperArm" ? armLift.right : 0));
            }
            clearance[emo] = { left: torso.need("left", kk, 1.05), right: torso.need("right", -kk, 1.05) };
          }
          if (import.meta.env.DEV) console.info(`[avatar] arm clearance: ${JSON.stringify(clearance)}`);
        }
        if (import.meta.env.DEV) console.info(`[avatar] arm poses solved: ${Object.keys(armPoses).join(", ") || "none"}`);
        touchMap = new TouchMap(v);
        springs = addSpringChains(v);
        if (hidden.length || tooned || rig || springs) {
          console.info(`[avatar] converted model: ${tooned} materials made toon, hidden: [${hidden.join(", ")}], face rig: ${rig ? [...rig.channels].join(",") : "none"}, hair springs: ${springs ? springs.joints.size : 0}`);
        }
        vrm = v;
        model.current = v;
        if (import.meta.env.DEV) Object.assign(window, { __vrm: v, __THREE: THREE, __camera: camera, __rig: rig }); // for rig experiments
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
        frame = () => {
          const f = CAPTURE_FACE ? faceFraming(v, head.y, camera.fov) : fullFraming(v, camera.fov, camera.aspect);
          camera.position.set(0, f.y, f.dist);
          camera.lookAt(0, f.y, 0);
        };
        frame();
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
      let voiceLevel = 0;

      // Targets
      const target: Record<string, number> = Object.fromEntries(EXPR_NAMES.map((n) => [n, 0]));
      Object.assign(target, pose.expr);
      if (p.speaking) {
        const raw = p.getLevel?.() ?? -1; // negative = no audio signal (browser voice): simulate flapping
        const lvl = raw >= 0 ? raw : 0.35 + 0.35 * Math.sin(t * 13) * Math.sin(t * 5.3);
        voiceLevelSmooth += (lvl - voiceLevelSmooth) * Math.min(1, dt * 5); // gestures follow the voice, not every peak
        voiceLevel = voiceLevelSmooth;
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
      // Being petted: the reaction is layered on top of her current emotion while it lasts.
      const re = reaction ? REACTIONS[reaction.region] : undefined;
      const env = reaction ? envelope(t, reaction.start, reaction.lastActive) : 0;
      if (reaction && env === 0 && t > reaction.start + 1) reaction = undefined;
      if (re && env > 0) for (const [n, w] of Object.entries(re.expr)) target[n] = Math.max(target[n] ?? 0, w * env);
      for (const n of EXPR_NAMES) {
        const fast = n === "aa" || n === "oh" || n === "ih" || n === "blink";
        cur[n] = lerp(cur[n], target[n], Math.min(1, dt * (fast ? 22 : 6)));
        vrm.expressionManager?.setValue(n, cur[n]);
      }

      if (rig) {
        const want: Partial<Record<Channel, number>> = { ...RIG_POSES[p.emotion] };
        if (re && env > 0) {
          // The touch reaction wins over the mood (smile vs frown would fight otherwise).
          for (const c of CHANNEL_NAMES) if (want[c] && !(c in re.rig)) want[c] = (want[c] ?? 0) * (1 - env);
          for (const [c, w] of Object.entries(re.rig)) want[c as Channel] = Math.max(want[c as Channel] ?? 0, (w ?? 0) * env);
          if (re.earWiggle) {
            const wob = (Math.sin(t * 26) + 1) / 2;
            want.earTwitchL = wob * env;
            want.earTwitchR = (1 - wob) * env;
          }
        }
        const add = (c: Channel, v: number) => (want[c] = Math.min(1, Math.max(want[c] ?? 0, 0) + v));
        // Visemes and blinking reuse the values computed above for standard models.
        want.mouthOpen = Math.max(want.mouthOpen ?? 0, Math.min(1, target.aa * 1.1 + target.oh * 0.9 + target.ih * 0.5));
        add("mouthNarrow", target.oh * 0.9);
        add("mouthWide", target.ih);
        // Smiling eyes are already nearly shut: blink only the remaining gap.
        want.blink = Math.max(want.blink ?? 0, target.blink * (1 - 0.85 * (want.eyeSmile ?? 0)));
        // Ears flick now and then, like the real animal's.
        if (rig.channels.has("earTwitchL") && !re?.earWiggle) {
          if (twitchT < 0 && t > nextTwitch) {
            twitchT = 0;
            twitchSide = Math.random() < 0.5 ? "earTwitchL" : "earTwitchR";
          }
          if (twitchT >= 0) {
            twitchT += dt;
            want[twitchSide] = Math.sin(Math.min(1, twitchT / 0.28) * Math.PI);
            if (twitchT > 0.28) {
              twitchT = -1;
              nextTwitch = t + 3 + Math.random() * 6;
            }
          }
        }
        for (const c of CHANNEL_NAMES) {
          const fast = c === "blink" || c.startsWith("mouth") || c.startsWith("earTwitch");
          rigCur[c] = lerp(rigCur[c], want[c] ?? 0, Math.min(1, dt * (fast ? 22 : 6)));
        }
        // Dev-only hooks to tune the rig from the browser console: pause it, or force exact weights.
        const dev = import.meta.env.DEV ? (window as unknown as { __rigPause?: boolean; __rigOverride?: typeof rigCur }) : undefined;
        if (!dev?.__rigPause) rig.apply(dev?.__rigOverride ?? rigCur);
      }

      // Gaze + idle body motion
      const headY = vrm.humanoid.getNormalizedBoneNode("head")?.getWorldPosition(new THREE.Vector3()).y ?? 1.4;
      let lookX = pose.look[0];
      let lookY = headY + 0.08 + pose.look[1];
      if (re && env > 0 && reaction) {
        if (re.lookAtHand && pointer.inside) {
          // eyes follow the hand: a point in front of her under the cursor
          const ndc = new THREE.Vector3((pointer.x / canvas.clientWidth) * 2 - 1, -(pointer.y / canvas.clientHeight) * 2 + 1, 0.5).unproject(camera);
          const dir = ndc.sub(camera.position).normalize();
          const hit = camera.position.clone().add(dir.multiplyScalar((0.4 - camera.position.z) / dir.z));
          lookX = hit.x;
          lookY = hit.y;
        } else if (re.shrink) {
          lookX = -0.3 * reaction.side; // looks away, embarrassed
          lookY = headY - 0.15;
        } else if (reaction.region === "head") lookY = headY + 0.3; // looks up at the hand on her head
      }
      gaze.position.x = lerp(gaze.position.x, lookX, dt * 4);
      gaze.position.y = lerp(gaze.position.y, lookY, dt * 4);
      const head = vrm.humanoid.getNormalizedBoneNode("head");
      if (head) {
        const energy = p.motion?.energy ?? 1;
        const nod = p.speaking ? Math.sin(t * 3.2 * (p.motion?.tempo ?? 1)) * 0.025 * energy : 0;
        const k = re && reaction ? env : 0;
        const side = reaction?.side ?? 0;
        // VRM 0.x normalized bones are mirrored (see the arm pose), so the roll towards the hand flips with it.
        const mirror = vrm.meta.metaVersion === "0" ? -1 : 1;
        const devPose = POSES[(import.meta.env.DEV ? (window as unknown as { __bodyEmotion?: Emotion }).__bodyEmotion : undefined) ?? p.emotion];
        const chinUp = (devPose?.chinUp ?? 0) * mirror; // VRM 0.x flips the pitch axis
        head.rotation.x = lerp(head.rotation.x, Math.sin(t * 0.9) * 0.02 + nod + (p.listening ? 0.03 : 0) + (re?.pitch ?? 0) * k - chinUp, dt * 5);
        head.rotation.y = lerp(head.rotation.y, Math.sin(t * 0.55) * 0.05 + (devPose?.yaw ?? 0) + (re?.shrink ? 0.3 * side * mirror * k : 0), dt * 3);
        head.rotation.z = lerp(head.rotation.z, pose.tilt + (p.listening ? 0.03 : 0) - (re?.tiltToward ?? 0) * side * mirror * k, dt * 3);
      }
      const spine = vrm.humanoid.getNormalizedBoneNode("spine");
      // Body language: arms and legs follow her mood, her breathing and her voice (see bodyMotion.ts).
      // VRM 0.x normalized bones are mirrored (x and z flip); poses are written in VRM 1.0 convention.
      const armK = vrm.meta.metaVersion === "0" ? -1 : 1;
      const devBody = import.meta.env.DEV ? (window as unknown as { __bodyEmotion?: Emotion; __bodySpeaking?: boolean }) : undefined;
      const bodyEmotion = devBody?.__bodyEmotion ?? p.emotion;
      const body = bodyPose({ t, emotion: bodyEmotion, speaking: devBody?.__bodySpeaking ?? p.speaking, level: voiceLevel, listening: p.listening, arms: armPoses, style: (import.meta.env.DEV ? (window as unknown as { __bodyStyle?: MotionStyle }).__bodyStyle : undefined) ?? p.motion });
      const follow = Math.min(1, dt * 4.5); // ~0.3 s to settle into a new pose
      for (const name of BODY_BONES) {
        const e = body[name];
        const b = vrm.humanoid.getNormalizedBoneNode(name as never);
        if (!e || !b || name === "spine" || name === "chest") continue;
        // Smoothly towards the target, and never faster than a relaxed human joint (no vibration, whatever
        // the source: a lively style, a jumpy voice level, a pose change).
        // The smoothed pose is kept apart from the bone, so later corrections (torso guard, wave) never feed
        // back into it frame after frame.
        const maxStep = dt * 2.2;
        const step = (cur: number, to: number) => cur + Math.max(-maxStep, Math.min(maxStep, (to - cur) * follow));
        const st = poseState.get(name) ?? [b.rotation.x, b.rotation.y, b.rotation.z];
        const open = clearance[bodyEmotion];
        const extra =
          name === "leftUpperArm" ? (open?.left ?? 0) * armK + armLift.left : name === "rightUpperArm" ? -(open?.right ?? 0) * armK + armLift.right : 0;
        st[0] = step(st[0], e[0] * armK);
        st[1] = step(st[1], e[1]);
        st[2] = step(st[2], e[2] * armK + extra);
        poseState.set(name, st);
        b.rotation.set(st[0], st[1], st[2]);
      }
      // Fingers: curled by mood, bending towards the palm (normalized bones: about z, opposite sign per hand).
      {
        const curl = fingerCurl({ t, emotion: bodyEmotion, speaking: p.speaking, level: voiceLevelSmooth, waving: t - waveStart < 2.4 });
        for (const side of ["left", "right"] as const) {
          const dir = (side === "left" ? -1 : 1) * armK;
          for (const f of FINGER_NAMES) {
            const segs = f === "Thumb" ? (["Metacarpal", "Proximal", "Distal"] as const) : (["Proximal", "Intermediate", "Distal"] as const);
            for (const g of segs) {
              const b = vrm.humanoid.getNormalizedBoneNode(`${side}${f}${g}` as never);
              if (!b) continue;
              const to = curl[f] * FINGER_SEGMENT_BEND[g] * (f === "Thumb" ? 0.45 : 1);
              const key = `${side}${f}${g}`;
              const cur = fingerState.get(key) ?? 0;
              const next = cur + (to - cur) * Math.min(1, dt * 6);
              fingerState.set(key, next);
              // the thumb folds across the palm (about y), the others towards it (about z)
              if (f === "Thumb") b.rotation.set(0, -dir * next * 0.6, dir * next * 0.5);
              else b.rotation.set(0, 0, dir * next);
            }
          }
        }
      }
      // Waving back: right arm up, forearm swinging, for ~2.4 s (blended over her current pose).
      const wk = envelope(t, waveStart, waveStart + 1.6, 0.35, 0, 0.5);
      const rUp = vrm.humanoid.getNormalizedBoneNode("rightUpperArm");
      const rLow = vrm.humanoid.getNormalizedBoneNode("rightLowerArm");
      if (rUp && rLow && wk > 0) {
        rUp.rotation.z = lerp(rUp.rotation.z, -0.25 * armK + armLift.right, wk);
        rUp.rotation.x = lerp(rUp.rotation.x, 0, wk);
        rLow.rotation.y = lerp(rLow.rotation.y, 0, wk);
        rLow.rotation.z = lerp(rLow.rotation.z, -(0.9 + 0.35 * Math.sin(t * 9)) * armK, wk);
      }
      const shrinkK = re?.shrink && reaction ? env : 0;
      if (spine) {
        // steps back when shy; leans in a little while listening
        spine.rotation.x = lerp(spine.rotation.x, Math.sin(t * 1.5) * 0.012 - 0.16 * shrinkK + (body.spine?.[0] ?? 0) * armK, dt * 6);
        spine.rotation.y = lerp(spine.rotation.y, 0.32 * (reaction?.side ?? 1) * shrinkK + (body.spine?.[1] ?? 0), dt * 5); // turns away / twists
        spine.rotation.z = lerp(spine.rotation.z, (body.spine?.[2] ?? 0) * armK, follow); // stays upright over the shifting hips
      }
      const chest = vrm.humanoid.getNormalizedBoneNode("chest");
      if (chest) {
        chest.rotation.x = lerp(chest.rotation.x, Math.sin(t * 1.5 + 0.4) * 0.01 + (body.chest?.[0] ?? 0) * armK, follow);
        chest.rotation.z = lerp(chest.rotation.z, (body.chest?.[2] ?? 0) * armK, follow);
      }

      vrm.update(dt);
      // Arms never pass through her body: corrected after the pose is applied (see torsoGuard.ts).
      const guardOff = import.meta.env.DEV && (window as unknown as { __guardOff?: boolean }).__guardOff;
      const fixes = torso && !guardOff ? torso.apply(dt, { left: armK, right: -armK }) : 0;
      if (import.meta.env.DEV) Object.assign(window, { __guardFixes: fixes, __armMinDepth: torso?.minDepth() });
      springs?.update(dt);
      renderer.render(scene, camera);

      // Petting: only while the cursor moves over HER (opaque pixel), never on the background.
      strokes.decay(dt);
      if (touchMap && pointer.inside && !CAPTURE_FACE && pointer.moved > 0) {
        const gl = renderer.getContext();
        const px = new Uint8Array(4);
        const dpr = renderer.getPixelRatio();
        gl.readPixels(Math.floor(pointer.x * dpr), Math.floor(canvas.height - pointer.y * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const onHer = px[3] > 20;
        canvas.style.cursor = onHer ? "grab" : "";
        const region = onHer ? touchMap.classify(pointer.x, pointer.y, camera, canvas.clientWidth, canvas.clientHeight) : undefined;
        if (import.meta.env.DEV) Object.assign(window, { __pet: { alpha: px[3], region, x: pointer.x, y: pointer.y } });
        if (region) {
          const headPx = new THREE.Vector3();
          vrm.humanoid.getRawBoneNode("head" as never)?.getWorldPosition(headPx);
          headPx.project(camera);
          const side = (pointer.x / canvas.clientWidth) * 2 - 1 > headPx.x ? 1 : -1; // hand on her left/right
          const fired = strokes.add(region, pointer.moved, t);
          if (fired) {
            reaction = { region, start: reaction?.region === region && envelope(t, reaction.start, reaction.lastActive) > 0 ? reaction.start : t, lastActive: t, side };
            live.current.onTouch?.(region);
          } else if (reaction?.region === region && strokes.active(region)) reaction.lastActive = t;
          if (reaction?.region === region && t - pointer.lastFx > 0.35) {
            pointer.lastFx = t;
            const fx = REACTIONS[region].fx;
            el.dispatchEvent(new CustomEvent<TouchFx>("waifu:touch-fx", { bubbles: true, detail: { x: pointer.x, y: pointer.y, glyph: fx.glyph, color: fx.color } }));
          }
        }
        pointer.moved = 0;
      }
    };
    tick();

    // "Capturar": a PNG of her over the app background.
    const onCapture = (e: Event) => {
      renderer.render(scene, camera); // the WebGL buffer is only valid right after a render
      const src = renderer.domElement;
      const out = document.createElement("canvas");
      out.width = src.width;
      out.height = src.height;
      const ctx = out.getContext("2d")!;
      const g = ctx.createRadialGradient(out.width / 2, out.height * 0.35, 0, out.width / 2, out.height * 0.35, out.height * 0.9);
      g.addColorStop(0, "#3b3a8f");
      g.addColorStop(1, "#0d0b1d");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(src, 0, 0);
      const name = String((e as CustomEvent<{ name?: string }>).detail?.name ?? "avatar").replace(/\s+/g, "-");
      const a = document.createElement("a");
      a.download = `${name}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
      a.href = out.toDataURL("image/png");
      a.click();
    };
    window.addEventListener("waifu:capture", onCapture);

    return () => {
      window.removeEventListener("waifu:capture", onCapture);
      window.removeEventListener("waifu:avatar-wave", onWave);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerleave", onPointerLeave);
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

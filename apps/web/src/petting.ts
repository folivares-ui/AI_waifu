import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import { SENSITIVE_REGIONS, type TouchRegion } from "@waifu/core";
import type { Weights } from "./boneFace";

/** How she reacts to being stroked somewhere (merged on top of her current emotion while it lasts). */
export interface Reaction {
  /** VRM expression presets (models with blendshapes). */
  expr: Record<string, number>;
  /** Bone-rig channels (models like Rice Shower's). */
  rig: Weights;
  /** Head roll towards the hand (radians at full strength). */
  tiltToward?: number;
  /** Head pitch: + leans the head into the hand, - pulls back. */
  pitch?: number;
  /** Upper body leans back (embarrassed) and turns away. */
  shrink?: boolean;
  /** Both ears flick quickly (ticklish). */
  earWiggle?: boolean;
  /** Eyes follow the hand. */
  lookAtHand?: boolean;
  /** Floating symbols next to the cursor. */
  fx: { glyph: string; color: string };
}

const SENSITIVE: Reaction = {
  expr: { surprised: 0.85, sad: 0.5 },
  rig: { eyeWide: 1, browSad: 1, mouthFrown: 0.5, mouthOpen: 0.4, mouthNarrow: 0.7, earsBack: 1 },
  pitch: -0.08,
  shrink: true,
  fx: { glyph: "💦", color: "#8fd3ff" },
};

export const REACTIONS: Record<TouchRegion, Reaction> = {
  // Head pats: pure bliss, eyes closed, leaning into the hand, ears relaxed.
  head: { expr: { happy: 1 }, rig: { eyeSmile: 1, mouthSmile: 1, browUp: 0.25, earsDroop: 0.35 }, tiltToward: 0.16, pitch: 0.1, fx: { glyph: "♥", color: "#ff7aa5" } },
  // Ears are ticklish: they flick, she squeaks.
  ears: { expr: { surprised: 0.6, relaxed: 0.4 }, rig: { eyeWide: 0.5, browUp: 0.7, mouthOpen: 0.25, mouthNarrow: 0.5 }, earWiggle: true, tiltToward: 0.1, fx: { glyph: "♪", color: "#b7a8ff" } },
  // Cheeks: shy and happy, nuzzles the hand.
  cheeks: { expr: { relaxed: 1, happy: 0.4 }, rig: { eyeSmile: 0.65, mouthSmile: 0.75, browSad: 0.45, earsDroop: 0.5 }, tiltToward: 0.2, pitch: 0.04, fx: { glyph: "♥", color: "#ff9ab8" } },
  // Boop on the nose: startled blink.
  face: { expr: { surprised: 1 }, rig: { eyeWide: 1, browUp: 1, mouthOpen: 0.35, mouthNarrow: 0.6, earsPerk: 1 }, pitch: -0.06, fx: { glyph: "!", color: "#ffd166" } },
  hair: { expr: { happy: 0.6 }, rig: { eyeSmile: 0.5, mouthSmile: 0.65, earsPerk: 0.6 }, tiltToward: 0.07, fx: { glyph: "✿", color: "#9fb1ff" } },
  // Holding her hand: surprised, then happy, looks at it.
  hands: { expr: { surprised: 0.35, happy: 0.55 }, rig: { eyeWide: 0.25, mouthSmile: 0.7, browSad: 0.3, earsPerk: 1 }, lookAtHand: true, fx: { glyph: "♥", color: "#ff7aa5" } },
  arms: { expr: { surprised: 0.3 }, rig: { earsPerk: 1, browUp: 0.4 }, lookAtHand: true, fx: { glyph: "?", color: "#c7d0ff" } },
  shoulders: { expr: { surprised: 0.3, relaxed: 0.3 }, rig: { earsPerk: 1, browUp: 0.4, mouthSmile: 0.3 }, lookAtHand: true, fx: { glyph: "?", color: "#c7d0ff" } },
  // Private areas: flustered, steps back, asks you to stop (the server makes her say so politely).
  chest: SENSITIVE,
  belly: SENSITIVE,
  hips: SENSITIVE,
  legs: SENSITIVE,
  tail: { ...SENSITIVE, rig: { ...SENSITIVE.rig, earsPerk: 1, earsBack: 0 } },
};

export const isSensitive = (r: TouchRegion) => SENSITIVE_REGIONS.includes(r);

interface TouchPoint {
  region: TouchRegion;
  world: THREE.Vector3;
  /** Behind her body (tail, back hair): only wins when nothing in front is close. */
  back?: boolean;
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

function findNode(vrm: VRM, re: RegExp): THREE.Object3D | undefined {
  let found: THREE.Object3D | undefined;
  vrm.scene.traverse((o) => {
    if (!found && re.test(o.name)) found = o;
  });
  return found;
}

/**
 * Body points (world space) a stroke can land on, from the humanoid skeleton. The model faces +Z.
 * Ears / tail use the model's own bones when it has them (animal ears), otherwise the head's sides.
 */
export class TouchMap {
  private ears: THREE.Object3D[];
  private tail?: THREE.Object3D;

  constructor(private vrm: VRM) {
    this.ears = [findNode(vrm, /^Ear_02_L/), findNode(vrm, /^Ear_02_R/)].filter((n): n is THREE.Object3D => !!n);
    this.tail = findNode(vrm, /Tail0_B_02|Tail.*_02|^Tail/i);
  }

  points(): TouchPoint[] {
    const raw = (n: string) => this.vrm.humanoid.getRawBoneNode(n as never);
    const pos = (n: string) => raw(n)?.getWorldPosition(new THREE.Vector3());
    const head = pos("head");
    if (!head) return [];
    const at = (o: THREE.Vector3, d: THREE.Vector3) => o.clone().add(d);
    const pts: TouchPoint[] = [
      { region: "head", world: at(head, v3(0, 0.16, 0.02)) },
      { region: "head", world: at(head, v3(0, 0.12, 0.07)) },
      { region: "face", world: at(head, v3(0, 0.045, 0.1)) },
      { region: "cheeks", world: at(head, v3(0.04, 0.03, 0.085)) },
      { region: "cheeks", world: at(head, v3(-0.04, 0.03, 0.085)) },
      { region: "hair", world: at(head, v3(0.1, 0.03, -0.01)) },
      { region: "hair", world: at(head, v3(-0.1, 0.03, -0.01)) },
      { region: "hair", world: at(head, v3(0.13, -0.15, -0.02)) },
      { region: "hair", world: at(head, v3(-0.13, -0.15, -0.02)) },
    ];
    if (this.ears.length) for (const e of this.ears) pts.push({ region: "ears", world: e.getWorldPosition(new THREE.Vector3()) });
    else pts.push({ region: "ears", world: at(head, v3(0.08, 0.06, 0)) }, { region: "ears", world: at(head, v3(-0.08, 0.06, 0)) });
    const add = (region: TouchRegion, p?: THREE.Vector3, d = v3(0, 0, 0)) => p && pts.push({ region, world: at(p, d) });
    add("shoulders", pos("leftUpperArm"));
    add("shoulders", pos("rightUpperArm"));
    add("shoulders", pos("neck"), v3(0, -0.02, 0.04));
    add("arms", pos("leftLowerArm"));
    add("arms", pos("rightLowerArm"));
    add("hands", pos("leftHand"));
    add("hands", pos("rightHand"));
    add("chest", pos("upperChest") ?? pos("chest"), v3(0, 0, 0.07));
    add("belly", pos("spine"), v3(0, 0, 0.07));
    add("hips", pos("hips"), v3(0, -0.06, 0.05));
    for (const s of ["left", "right"]) {
      add("legs", pos(`${s}UpperLeg`), v3(0, -0.18, 0.03));
      add("legs", pos(`${s}LowerLeg`));
    }
    if (this.tail) pts.push({ region: "tail", world: this.tail.getWorldPosition(new THREE.Vector3()), back: true });
    return pts;
  }

  /** Nearest body region to a screen point (CSS px), using the head size on screen as the scale. */
  classify(x: number, y: number, camera: THREE.Camera, w: number, h: number): TouchRegion | undefined {
    const pts = this.points();
    if (!pts.length) return undefined;
    const toPx = (p: THREE.Vector3) => {
      const n = p.clone().project(camera);
      return [((n.x + 1) / 2) * w, ((1 - n.y) / 2) * h] as const;
    };
    const head = this.vrm.humanoid.getRawBoneNode("head" as never)!.getWorldPosition(new THREE.Vector3());
    const [hx] = toPx(head);
    const [hx2] = toPx(head.clone().add(v3(0.1, 0, 0)));
    const scale = Math.max(8, Math.abs(hx2 - hx)); // pixels per 10 cm
    let front: { region: TouchRegion; d: number } | undefined;
    let back: { region: TouchRegion; d: number } | undefined;
    for (const p of pts) {
      const [px, py] = toPx(p.world);
      const d = Math.hypot(px - x, py - y);
      if (p.back) {
        if (!back || d < back.d) back = { region: p.region, d };
      } else if (!front || d < front.d) front = { region: p.region, d };
    }
    // Seen from the front, what is behind her (tail) is hidden by her body: it only counts away from the body.
    const best = front && front.d < scale * 1.3 ? front : back && (!front || back.d < front.d) ? back : front;
    return best && best.d < scale * 2.2 ? best.region : undefined;
  }
}

/**
 * Turns cursor motion into strokes: movement over one region builds up "energy" that fades in about a second.
 * A stroke fires when enough movement happened recently; hovering without moving never counts.
 */
export class StrokeTracker {
  private energy = new Map<TouchRegion, number>();
  private lastFired = new Map<TouchRegion, number>();

  constructor(private threshold = 90, private cooldownS = 2.5) {}

  /** Adds `moved` pixels of motion on `region` at time `t` (s). Returns the region if this completes a stroke. */
  add(region: TouchRegion, moved: number, t: number): TouchRegion | undefined {
    const e = (this.energy.get(region) ?? 0) + moved;
    this.energy.set(region, e);
    if (e < this.threshold) return undefined;
    this.energy.set(region, this.threshold * 0.4); // keep some, so continued petting keeps her reacting
    if (t - (this.lastFired.get(region) ?? -Infinity) < this.cooldownS) return undefined;
    this.lastFired.set(region, t);
    return region;
  }

  /** Is the user still stroking this region (for keeping the reaction alive)? */
  active(region: TouchRegion): boolean {
    return (this.energy.get(region) ?? 0) > this.threshold * 0.25;
  }

  decay(dt: number) {
    const k = Math.exp(-dt / 0.8);
    for (const [r, e] of this.energy) this.energy.set(r, e * k);
  }
}

/**
 * Reaction envelope (0..1): rises quickly from `start`, holds at least `hold` seconds and for as long as the
 * user keeps stroking (`lastActive`), then fades out over `release` seconds.
 */
export function envelope(now: number, start: number, lastActive: number, attack = 0.18, hold = 1.4, release = 0.9): number {
  const age = now - start;
  if (age < 0) return 0;
  if (age < attack) return age / attack;
  const holdUntil = Math.max(start + attack + hold, lastActive);
  if (now <= holdUntil) return 1;
  const r = (now - holdUntil) / release;
  return r >= 1 ? 0 : 1 - r;
}

import type { Emotion, MotionStyle } from "@waifu/core";
import type { ArmSolution, ArmSolutions } from "./armIK";

/**
 * Body language: arms and legs that move with her mood, her voice and her breathing, instead of a fixed pose.
 *
 * Angles are radians on the humanoid's *normalized* bones in VRM 1.0 convention (rest = T-pose, she faces +z,
 * her left arm points +x). The caller flips x and z for VRM 0.x models. Only the LEFT side is written for
 * symmetric poses; the right side mirrors it (same x, opposite y and z).
 */
export type Euler3 = [number, number, number];
export type BodyPose = Partial<Record<BodyBone, Euler3>>;
export type BodyBone =
  | "leftUpperArm" | "leftLowerArm" | "leftHand" | "rightUpperArm" | "rightLowerArm" | "rightHand"
  | "leftShoulder" | "rightShoulder" | "leftUpperLeg" | "leftLowerLeg" | "rightUpperLeg" | "rightLowerLeg"
  | "hips" | "spine" | "chest";

export const BODY_BONES: BodyBone[] = [
  "leftUpperArm", "leftLowerArm", "leftHand", "rightUpperArm", "rightLowerArm", "rightHand",
  "leftShoulder", "rightShoulder", "leftUpperLeg", "leftLowerLeg", "rightUpperLeg", "rightLowerLeg",
  "hips", "spine", "chest",
];

const mirror = (e: Euler3): Euler3 => [e[0], -e[1], -e[2]];
/** Pose for both arms from the left one. */
const both = (upper: Euler3, lower: Euler3, hand: Euler3 = [0, 0, 0], shoulder: Euler3 = [0, 0, 0]): BodyPose => ({
  leftUpperArm: upper, leftLowerArm: lower, leftHand: hand, leftShoulder: shoulder,
  rightUpperArm: mirror(upper), rightLowerArm: mirror(lower), rightHand: mirror(hand), rightShoulder: mirror(shoulder),
});

/**
 * Arm poses per emotion. Upper arm: z lowers it from the T-pose, x swings it forward (-) / back (+).
 * Lower arm: y bends the elbow forward (- on the left). Values checked by measuring where the hands end up.
 */
export const EMOTION_POSES: Record<Emotion, BodyPose> = {
  neutral: both([0.05, 0, -1.2], [0, -0.18, -0.08], [0, 0, -0.08]),
  happy: both([-0.05, 0, -1.0], [0, -0.45, -0.1], [0, 0, 0.1]), // arms a little open, lively
  sad: { ...both([-0.12, 0, -1.32], [0, -0.35, 0], [0, 0, -0.15], [0, 0, -0.08]), chest: [0.08, 0, 0] }, // close to the body, shoulders down, slouched
  angry: both([0.35, 0, -0.85], [0, -1.65, 0], [0, 0, 0.25]), // hands on the hips
  surprised: both([-0.55, 0, -1.05], [0, -1.85, 0], [0, 0, 0.3]), // hands up to the chest
  thinking: {
    // right hand to the chin, left arm across the waist holding the right elbow
    leftUpperArm: [-0.45, 0, -1.25], leftLowerArm: [0, -1.45, 0], leftHand: [0, 0, 0],
    rightUpperArm: [-0.85, 0, 1.15], rightLowerArm: [0, 2.15, 0], rightHand: [0, 0, -0.35],
  },
  shy: { ...both([-0.38, 0, -1.28], [0, -1.0, 0.15], [0, 0, -0.1], [0, 0, -0.05]), chest: [0.05, 0, 0] }, // hands together in front
};

export interface BodyState {
  t: number;
  emotion: Emotion;
  speaking: boolean;
  /** Loudness of her voice 0..1 while speaking (for the beat of the gestures). */
  level: number;
  listening: boolean;
  /** Arm poses solved for this model (armIK.ts); the fixed table is used when absent. */
  arms?: ArmSolutions;
  /** How lively this character is (soul file "motion"); calm defaults when absent. */
  style?: MotionStyle;
}

/** Mood poses with the hands placed for THIS model (on the hips, at the chin...). */
function calibrated(emotion: Emotion, arms: ArmSolutions | undefined): BodyPose | undefined {
  const a = (t: keyof ArmSolutions) => arms?.[t];
  const pose = EMOTION_POSES[emotion];
  const sym = (s: ArmSolution | undefined, hand: Euler3) => s && { ...pose, ...both(s.upper, [0, s.lower, 0], hand, pose.leftShoulder) };
  switch (emotion) {
    case "angry": {
      // Tsundere: arms crossed (one forearm over the other); hands on the hips if that cannot be solved.
      const front = a("crossFront");
      const back = a("crossBack");
      if (front && back) return { ...pose, leftUpperArm: front.upper, leftLowerArm: [0, front.lower, 0], leftHand: [0, 0, 0.1], rightUpperArm: mirror(back.upper), rightLowerArm: [0, -back.lower, 0], rightHand: [0, 0, -0.1] };
      return sym(a("hips"), [0, 0, 0.25]);
    }
    case "shy":
      return sym(a("together"), [0, 0, -0.1]);
    case "surprised":
      return sym(a("chest"), [0, 0, 0.3]);
    case "thinking": {
      const chin = a("chin");
      const across = a("across");
      if (!chin || !across) return undefined;
      return { ...pose, leftUpperArm: across.upper, leftLowerArm: [0, across.lower, 0], rightUpperArm: mirror(chin.upper), rightLowerArm: [0, -chin.lower, 0], rightHand: [0, 0, -0.35] };
    }
    default:
      return undefined;
  }
}

/** Deterministic "random" in 0..1 for a time slot (so gestures vary but tests are repeatable). */
const rnd = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

const add = (a: Euler3 | undefined, b: Euler3): Euler3 => (a ? [a[0] + b[0], a[1] + b[1], a[2] + b[2]] : b);

/** Target pose for this instant: mood pose + breathing/idle sway + weight shift + talking gestures. */
export function bodyPose(s: BodyState): BodyPose {
  const pose: BodyPose = { ...(calibrated(s.emotion, s.arms) ?? EMOTION_POSES[s.emotion]) };
  const energy = s.style?.energy ?? 1;
  const bounceAmt = s.style?.bounce ?? 0;
  const fidgetAmt = s.style?.fidget ?? 0;
  const t = s.t * (s.style?.tempo ?? 1); // a lively character moves faster
  const breath = Math.sin(t * 1.5);

  // Idle: arms sway a little with the breath, never perfectly still (wider for energetic characters).
  // The arms swing out more than in: an inward swing is what makes them brush through the body.
  const swayRaw = (0.035 * Math.sin(t * 0.8) + 0.015 * breath) * energy;
  const sway = swayRaw > 0 ? swayRaw : swayRaw * 0.25;
  pose.leftUpperArm = add(pose.leftUpperArm, [0.03 * energy * Math.sin(t * 0.7), 0, sway]);
  pose.rightUpperArm = add(pose.rightUpperArm, [0.03 * energy * Math.sin(t * 0.7 + 1.3), 0, -sway]);
  pose.leftLowerArm = add(pose.leftLowerArm, [0, -0.05 * energy * (1 + Math.sin(t * 0.9)), 0]);
  pose.rightLowerArm = add(pose.rightLowerArm, [0, 0.05 * energy * (1 + Math.sin(t * 0.9 + 0.8)), 0]);
  // Loose arms: elbows a little bent and the forearms swinging on their own (slightly out of step).
  const relax = s.style?.armRelax ?? 0;
  if (relax > 0) {
    const swing = (ph: number) => 0.22 * relax + 0.07 * relax * Math.sin(t * 1.1 + ph) + 0.03 * relax * Math.sin(t * 2.3 + ph * 2);
    pose.leftLowerArm = add(pose.leftLowerArm, [0, -swing(0), 0]);
    pose.rightLowerArm = add(pose.rightLowerArm, [0, swing(1.7), 0]);
    pose.leftUpperArm = add(pose.leftUpperArm, [0.06 * relax * Math.sin(t * 0.9 + 0.4), 0, 0]);
    pose.rightUpperArm = add(pose.rightUpperArm, [0.06 * relax * Math.sin(t * 0.9 + 2.1), 0, 0]);
    pose.leftHand = add(pose.leftHand, [0, 0, 0.12 * relax * Math.sin(t * 1.3)]);
    pose.rightHand = add(pose.rightHand, [0, 0, -0.12 * relax * Math.sin(t * 1.3 + 1.1)]);
  }
  pose.leftShoulder = add(pose.leftShoulder, [0, 0, 0.02 * energy * breath]);
  pose.rightShoulder = add(pose.rightShoulder, [0, 0, -0.02 * energy * breath]);
  // The torso is alive too: a slow twist and side sway (more with energy).
  // (calm characters turn too, just less: a torso that only ever tilts looks stiff)
  pose.spine = add(pose.spine, [0, 0.045 * Math.max(0.6, energy) * Math.sin(t * 0.45) * (0.75 + 0.25 * Math.sin(t * 0.17)), 0]);
  pose.chest = add(pose.chest, [0, 0.015 * Math.max(0.6, energy) * Math.sin(t * 0.45 - 0.6), 0]);
  pose.chest = add(pose.chest, [0, 0, 0.012 * (energy - 0.6) * Math.sin(t * 0.75 + 0.5)]);

  // Weight shift every few seconds: hips tilt, the free leg's knee bends a little.
  const shift = Math.sin(t * 0.42) * 0.5 + Math.sin(t * 0.17) * 0.5; // -1..1, slow and irregular
  pose.hips = add(pose.hips, [0, 0.03 * shift, 0.035 * shift]);
  pose.spine = add(pose.spine, [0, 0, -0.03 * shift]); // the upper body stays upright
  const freeL = Math.max(0, -shift);
  const freeR = Math.max(0, shift);
  pose.leftUpperLeg = [-0.07 * freeL, 0, -0.035 * shift];
  pose.leftLowerLeg = [0.16 * freeL, 0, 0];
  pose.rightUpperLeg = [-0.07 * freeR, 0, -0.035 * shift];
  pose.rightLowerLeg = [0.16 * freeR, 0, 0];

  // Bounce in the knees: when happy, and always for restless characters (bounce > 0).
  const bounce = s.emotion === "happy" ? Math.max(1, bounceAmt * 1.3) : bounceAmt;
  if (bounce > 0) {
    const b = bounce * (0.5 + 0.5 * Math.sin(t * 4.2));
    pose.leftUpperLeg = add(pose.leftUpperLeg, [-0.04 * b, 0, 0]);
    pose.rightUpperLeg = add(pose.rightUpperLeg, [-0.04 * b, 0, 0]);
    pose.leftLowerLeg = add(pose.leftLowerLeg, [0.08 * b, 0, 0]);
    pose.rightLowerLeg = add(pose.rightLowerLeg, [0.08 * b, 0, 0]);
  }

  // Fidgeting (restless characters): every few seconds one small spontaneous move, eased in and out.
  // (only from a pose with the arms hanging: added to hands already placed somewhere, at the chest, together in
  // front, it would twist the arm into a shape no elbow makes)
  const hanging = s.emotion === "neutral" || s.emotion === "happy";
  if (fidgetAmt > 0 && !s.speaking && s.emotion !== "angry" && s.emotion !== "thinking") {
    const slot = Math.floor(t / 3.2);
    const phase = (t / 3.2) % 1;
    const k = fidgetAmt * Math.sin(Math.PI * Math.min(1, phase * 1.25)) ** 2; // 0 -> 1 -> 0 within the slot
    const move = Math.floor(rnd(slot + 77) * 5);
    if (move === 0) {
      // hand on the hip (left): towards the pose solved for her body if there is one (her hip is where it is,
      // whatever her proportions), else a generic one
      if (hanging) {
        const hips = s.arms?.hips;
        if (hips) {
          const mix = (a: Euler3 | undefined, b: Euler3): Euler3 => (a ? [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k] : b);
          pose.leftUpperArm = mix(pose.leftUpperArm, hips.upper);
          pose.leftLowerArm = mix(pose.leftLowerArm, [0, hips.lower, 0]);
        } else {
          pose.leftUpperArm = add(pose.leftUpperArm, [0.25 * k, 0, 0.35 * k]);
          pose.leftLowerArm = add(pose.leftLowerArm, [0, -1.1 * k, 0]);
        }
      }
    } else if (move === 1) {
      // shoulder roll / shrug
      pose.leftShoulder = add(pose.leftShoulder, [0, 0, 0.12 * k]);
      pose.rightShoulder = add(pose.rightShoulder, [0, 0, -0.12 * k]);
    } else if (move === 2) {
      // torso twist to one side
      pose.spine = add(pose.spine, [0, 0.12 * k * (rnd(slot) > 0.5 ? 1 : -1), 0]);
    } else if (move === 3 && hanging) {
      // arms swing forward and back once, like shaking off energy (one smooth swing per slot)
      const swing = Math.sin(phase * 2 * Math.PI);
      pose.leftUpperArm = add(pose.leftUpperArm, [-0.2 * k * swing, 0, 0]);
      pose.rightUpperArm = add(pose.rightUpperArm, [0.2 * k * swing, 0, 0]);
    } else {
      // weight on one leg, hip popped
      pose.hips = add(pose.hips, [0, 0, 0.06 * k]);
      pose.spine = add(pose.spine, [0, 0, -0.06 * k]);
    }
  }

  // Listening: a slight lean towards you.
  if (s.listening && !s.speaking) pose.spine = add(pose.spine, [0.04, 0, 0]);

  // Talking: hand gestures on the beat of her voice, one arm or both, changing every ~1.4 s.
  if (s.speaking && s.emotion !== "thinking") {
    // Which arm(s) gesture changes every ~1.4 s, cross-faded over the first 0.9 s of each slot (no jumps).
    const SLOT = 1.4;
    const slot = Math.floor(t / SLOT);
    const arms = (n: number) => {
      const pick = rnd(n);
      return { left: pick < 0.45 || pick > 0.8 ? 1 : 0, right: pick >= 0.45 ? 1 : 0 };
    };
    const f = Math.min(1, (t - slot * SLOT) / 0.9);
    const blend = f * f * (3 - 2 * f); // smoothstep
    const prev = arms(slot - 1);
    const cur = arms(slot);
    const wL = prev.left + (cur.left - prev.left) * blend;
    const wR = prev.right + (cur.right - prev.right) * blend;
    // A slow, even beat (the voice level is already smoothed by the caller).
    // (smaller when the hands are already placed: on the hips, at the chest, together, crossed)
    const placed = s.emotion === "angry" || s.emotion === "surprised" || s.emotion === "shy" ? 0.35 : 1;
    const beat = Math.min(1, 0.35 + s.level * 1.4) * (0.8 + 0.2 * Math.sin(t * 2.6)) * Math.min(1.6, energy) * placed;
    const g = (k: number): [Euler3, Euler3] => [[-0.32 * k, 0, 0.18 * k], [0, -0.75 * k, 0]];
    if (wL > 0) {
      const [u, l] = g(beat * wL);
      pose.leftUpperArm = add(pose.leftUpperArm, u);
      pose.leftLowerArm = add(pose.leftLowerArm, l);
      pose.leftHand = add(pose.leftHand, [0, 0, 0.25 * beat * wL]);
    }
    if (wR > 0) {
      const [u, l] = g(beat * wR);
      pose.rightUpperArm = add(pose.rightUpperArm, mirror(u));
      pose.rightLowerArm = add(pose.rightLowerArm, mirror(l));
      pose.rightHand = add(pose.rightHand, mirror([0, 0, 0.25 * beat * wR]));
    }
  }
  // Feet stay planted: whatever tilts or turns the hips (weight shift, a popped hip when fidgeting...), the thighs
  // turn back by as much, so the legs stand where they stood instead of swinging with the pelvis like a pendulum
  // (and dragging a long skirt or coat with them).
  const hipTilt = pose.hips?.[2] ?? 0;
  const hipTurn = pose.hips?.[1] ?? 0;
  for (const leg of ["leftUpperLeg", "rightUpperLeg"] as const) {
    const e = pose[leg] ?? [0, 0, 0];
    // (the weight shift's own counter-tilt is already in: only the rest of the tilt is added)
    pose[leg] = [e[0], e[1] - hipTurn, e[2] - (hipTilt - 0.035 * shift)];
  }
  // An elbow only bends one way, and not all the way: whatever was added up above, the forearm never bends
  // backwards (left: y < 0 bends it forward; right: y > 0) nor folds onto the upper arm.
  const elbow = (e: Euler3 | undefined, sign: number): Euler3 | undefined =>
    e && [e[0], sign * Math.min(2.6, Math.max(0.02, sign * e[1])), e[2]];
  pose.leftLowerArm = elbow(pose.leftLowerArm, -1);
  pose.rightLowerArm = elbow(pose.rightLowerArm, 1);
  return pose;
}

// ---------- fingers ----------

export const FINGER_NAMES = ["Thumb", "Index", "Middle", "Ring", "Little"] as const;

/**
 * How curled each finger is (0 = straight, 1 = fist), by mood: relaxed hands are a little curled, the little finger
 * more than the index; angry ones close into fists; happy ones open up. While speaking the curl breathes a little,
 * and each finger drifts slowly on its own so the hands never look frozen.
 */
export function fingerCurl(s: { t: number; emotion: Emotion; speaking: boolean; level: number; waving?: boolean }): Record<(typeof FINGER_NAMES)[number], number> {
  const base: Record<Emotion, number> = { neutral: 0.2, happy: 0.1, sad: 0.28, angry: 0.8, surprised: 0.08, thinking: 0.3, shy: 0.32 };
  const b = s.waving ? 0.08 : base[s.emotion];
  const talk = s.speaking ? 0.06 * Math.sin(s.t * 2.1) + 0.05 * Math.min(1, s.level * 2) : 0;
  const drift = (k: number) => 0.04 * Math.sin(s.t * (0.37 + k * 0.11) + k * 1.7);
  const out = {} as Record<(typeof FINGER_NAMES)[number], number>;
  FINGER_NAMES.forEach((f, k) => {
    const spread = f === "Thumb" ? -0.1 : (k - 1) * 0.06; // the little finger curls a bit more than the index
    out[f] = Math.max(0, Math.min(1, b + spread + talk + drift(k)));
  });
  return out;
}

/** Rotation (radians) of each finger segment for a curl of 1: the base bends less than the middle joint. */
export const FINGER_SEGMENT_BEND = { Metacarpal: 0.25, Proximal: 1.0, Intermediate: 1.2, Distal: 0.7 } as const;

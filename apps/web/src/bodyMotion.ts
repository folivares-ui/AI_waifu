import type { Emotion } from "@waifu/core";
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
  const { t } = s;
  const breath = Math.sin(t * 1.5);

  // Idle: arms sway a little with the breath, never perfectly still.
  const sway = 0.035 * Math.sin(t * 0.8) + 0.015 * breath;
  pose.leftUpperArm = add(pose.leftUpperArm, [0.03 * Math.sin(t * 0.7), 0, sway]);
  pose.rightUpperArm = add(pose.rightUpperArm, [0.03 * Math.sin(t * 0.7 + 1.3), 0, -sway]);
  pose.leftLowerArm = add(pose.leftLowerArm, [0, -0.05 * (1 + Math.sin(t * 0.9)), 0]);
  pose.rightLowerArm = add(pose.rightLowerArm, [0, 0.05 * (1 + Math.sin(t * 0.9 + 0.8)), 0]);
  pose.leftShoulder = add(pose.leftShoulder, [0, 0, 0.02 * breath]);
  pose.rightShoulder = add(pose.rightShoulder, [0, 0, -0.02 * breath]);

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

  // Happy: a small bounce in the knees.
  if (s.emotion === "happy") {
    const b = 0.5 + 0.5 * Math.sin(t * 4.2);
    pose.leftUpperLeg = add(pose.leftUpperLeg, [-0.04 * b, 0, 0]);
    pose.rightUpperLeg = add(pose.rightUpperLeg, [-0.04 * b, 0, 0]);
    pose.leftLowerLeg = add(pose.leftLowerLeg, [0.08 * b, 0, 0]);
    pose.rightLowerLeg = add(pose.rightLowerLeg, [0.08 * b, 0, 0]);
  }

  // Listening: a slight lean towards you.
  if (s.listening && !s.speaking) pose.spine = add(pose.spine, [0.04, 0, 0]);

  // Talking: hand gestures on the beat of her voice, one arm or both, changing every ~1.4 s.
  if (s.speaking && s.emotion !== "thinking") {
    const slot = Math.floor(t / 1.4);
    const pick = rnd(slot);
    const beat = Math.min(1, 0.35 + s.level * 1.4) * (0.75 + 0.25 * Math.sin(t * 7));
    const left = pick < 0.45 || pick > 0.8;
    const right = pick >= 0.45;
    const g = (k: number): [Euler3, Euler3] => [[-0.32 * k, 0, 0.18 * k], [0, -0.75 * k, 0]];
    if (left) {
      const [u, l] = g(beat);
      pose.leftUpperArm = add(pose.leftUpperArm, u);
      pose.leftLowerArm = add(pose.leftLowerArm, l);
      pose.leftHand = add(pose.leftHand, [0, 0, 0.25 * beat]);
    }
    if (right) {
      const [u, l] = g(beat);
      pose.rightUpperArm = add(pose.rightUpperArm, mirror(u));
      pose.rightLowerArm = add(pose.rightLowerArm, mirror(l));
      pose.rightHand = add(pose.rightHand, mirror([0, 0, 0.25 * beat]));
    }
  }
  return pose;
}

import * as THREE from "three";
import type { VRM } from "@pixiv/three-vrm";
import type { Emotion } from "@waifu/core";

/**
 * Facial expressions for models that ship WITHOUT blendshapes/expressions but WITH a facial bone rig
 * (eyelid, eyebrow, mouth and ear bones), which is common in models ripped/converted from games.
 *
 * Supported naming family (found empirically on such a model; other rigs are simply not detected and the
 * avatar then has a static face): Eye_up_NN_L/R, Eye_bottom_NN_L/R, Eye_double_*, Eye_sub_*, Eyelashes_*,
 * Eyebrow_NN_L/R, Mouth_L/R, Mouth_bottom_*, Chin, Tooth_bottom, Ear_01_L/R.
 *
 * Each "channel" moves a group of bones by an offset expressed in millimetres in the model's rest-pose
 * world axes (+x = character's left, +y = up, +z = front), or rotates them (radians, world axes).
 * Offsets were tuned by rendering each group and looking at the result.
 */

type Move = { bones: RegExp; mm: [number, number, number] } | { bones: RegExp; rot: [number, number, number] };

const UPPER_LID = /^(Eye_up_0[12345]|Eye_up_1[12345]|Eye_double_0\d|Eye_sub_0[1234]|Eyelashes|Eye_middle_01)_[LR]$/;
const LOWER_LID = /^Eye_bottom_0\d_[LR]$/;
const LOWER_LID_MID = /^Eye_bottom_0[23]_[LR]$/; // centre of the lower lid
const LOWER_LID_ENDS = /^Eye_bottom_0[14]_[LR]$/; // inner and outer corners
const BROW_ALL = /^Eyebrow_0[1234]_[LR]$/;
const BROW_INNER = /^Eyebrow_0[14]_[LR]$/;
const BROW_OUTER = /^Eyebrow_03_[LR]$/;
const MOUTH_CORNER = /^Mouth_middle_[LR]$/;

export const CHANNELS = {
  blink: [{ bones: UPPER_LID, mm: [0, -26, 0] }, { bones: LOWER_LID, mm: [0, 3, 0] }],
  eyeWide: [{ bones: UPPER_LID, mm: [0, 4, 0] }, { bones: LOWER_LID, mm: [0, -2, 0] }],
  // Anime "smiling eyes": the lower lid arches up (centre more than the corners) to meet the lowered upper lid,
  // leaving a sliver of iris at full weight.
  eyeSmile: [{ bones: UPPER_LID, mm: [0, -13, 0] }, { bones: LOWER_LID_MID, mm: [0, 15, 0] }, { bones: LOWER_LID_ENDS, mm: [0, 8, 0] }],
  browUp: [{ bones: BROW_ALL, mm: [0, 7, 0] }],
  browAngry: [{ bones: BROW_INNER, mm: [0, -7, 0] }, { bones: BROW_OUTER, mm: [0, 4, 0] }],
  browSad: [{ bones: BROW_INNER, mm: [0, 7, 0] }, { bones: BROW_OUTER, mm: [0, -4, 0] }],
  // Jaw drop graded from the centre of the lower lip to the corners, so the opening has a rounded bottom
  // (combined with mouthSmile it becomes the open "D" smile).
  mouthOpen: [
    { bones: /^Mouth_bottom_01_[CLR]$/, mm: [0, -9, 0] },
    { bones: /^Mouth_bottom_02_[LR]$/, mm: [0, -6.5, 0] },
    { bones: /^Mouth_bottom_03_[LR]$/, mm: [0, -3.5, 0] },
    { bones: /^Chin$/, mm: [0, -5.5, 0] },
    { bones: /^Tooth_bottom$/, mm: [0, -5.5, 0] },
  ],
  // Corners lifted through Mouth_middle_* as well, otherwise the closed smile bends into a wavy "W".
  mouthSmile: [{ bones: /^Mouth_L$/, mm: [3, 2, 0] }, { bones: /^Mouth_R$/, mm: [-3, 2, 0] }, { bones: MOUTH_CORNER, mm: [0, 2.5, 0] }],
  mouthFrown: [{ bones: MOUTH_CORNER, mm: [0, -2.5, 0] }, { bones: /^Mouth_(bottom|up)_03_[LR]$/, mm: [0, -1.2, 0] }],
  mouthNarrow: [{ bones: /^Mouth_L$/, mm: [-2.5, 0, 0] }, { bones: /^Mouth_R$/, mm: [2.5, 0, 0] }],
  mouthWide: [{ bones: /^Mouth_L$/, mm: [2.5, 0.5, 0] }, { bones: /^Mouth_R$/, mm: [-2.5, 0.5, 0] }],
  // Animal ears (if the model has them): they carry a lot of the emotion.
  earsDroop: [{ bones: /^Ear_01_L$/, rot: [0, 0, -0.6] }, { bones: /^Ear_01_R$/, rot: [0, 0, 0.6] }],
  earsBack: [{ bones: /^Ear_01_[LR]$/, rot: [-0.6, 0, 0] }],
  earsPerk: [{ bones: /^Ear_01_L$/, rot: [0.25, 0, 0.12] }, { bones: /^Ear_01_R$/, rot: [0.25, 0, -0.12] }],
  earTwitchL: [{ bones: /^Ear_01_L$/, rot: [0, 0, -0.28] }],
  earTwitchR: [{ bones: /^Ear_01_R$/, rot: [0, 0, 0.28] }],
} satisfies Record<string, Move[]>;

export type Channel = keyof typeof CHANNELS;
export type Weights = Partial<Record<Channel, number>>;
export const CHANNEL_NAMES = Object.keys(CHANNELS) as Channel[];

/** How each emotion looks on a bone rig. */
export const RIG_POSES: Record<Emotion, Weights> = {
  neutral: {},
  happy: { eyeSmile: 0.9, mouthSmile: 1, browUp: 0.3, earsPerk: 1 },
  sad: { browSad: 1, mouthFrown: 1, blink: 0.22, earsDroop: 1 },
  angry: { browAngry: 1, mouthFrown: 0.7, blink: 0.12, earsBack: 1 },
  surprised: { eyeWide: 1, browUp: 1, mouthOpen: 0.3, mouthNarrow: 0.5, earsPerk: 1 },
  thinking: { browUp: 0.35, mouthNarrow: 0.6, earsDroop: 0.25 },
  shy: { eyeSmile: 0.45, mouthSmile: 0.5, browSad: 0.6, earsDroop: 0.7 },
};

/** Exporters such as Sketchfab append an index to node names ("Eye_up_01_L_0146"). */
const baseName = (n: string) => n.replace(/_\d{3,4}$/, "");

interface Driven {
  node: THREE.Object3D;
  restPos: THREE.Vector3;
  restQuat: THREE.Quaternion;
  offsets: { channel: Channel; local: THREE.Vector3 }[];
  rotations: { channel: Channel; delta: THREE.Quaternion }[];
}

export class BoneFaceRig {
  private driven: Driven[] = [];
  readonly channels = new Set<Channel>();

  /** Returns a rig if the model has no facial expressions of its own but has recognisable face bones. */
  static detect(vrm: VRM): BoneFaceRig | undefined {
    const own = vrm.expressionManager?.expressionMap ?? {};
    if ("blink" in own || "aa" in own) return undefined; // the model animates its face the standard way
    const rig = new BoneFaceRig(vrm);
    return rig.channels.has("blink") || rig.channels.has("mouthOpen") ? rig : undefined;
  }

  /** Must be created while the model is in its rest pose (and after VRMUtils.rotateVRM0). */
  private constructor(vrm: VRM) {
    vrm.scene.updateMatrixWorld(true);
    const byNode = new Map<THREE.Object3D, Driven>();
    const candidates: THREE.Object3D[] = [];
    (vrm.humanoid.getRawBoneNode("head") ?? vrm.scene).traverse((o) => candidates.push(o));

    const add = (channel: Channel, node: THREE.Object3D, move: { mm: [number, number, number] } | { rot: [number, number, number] }) => {
      if (!node.parent) return;
      let d = byNode.get(node);
      if (!d) {
        d = { node, restPos: node.position.clone(), restQuat: node.quaternion.clone(), offsets: [], rotations: [] };
        byNode.set(node, d);
      }
      const parentInv = node.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      if ("mm" in move) {
        // World-space offset -> the bone's parent space, so it keeps working when the head turns.
        const scale = node.parent.getWorldScale(new THREE.Vector3());
        d.offsets.push({ channel, local: new THREE.Vector3(...move.mm).multiplyScalar(0.001).applyQuaternion(parentInv).divide(scale) });
      } else {
        const world = new THREE.Quaternion().setFromEuler(new THREE.Euler(...move.rot));
        const target = parentInv.clone().multiply(world).multiply(node.getWorldQuaternion(new THREE.Quaternion()));
        d.rotations.push({ channel, delta: d.restQuat.clone().invert().multiply(target) });
      }
      this.channels.add(channel);
    };

    // Family 1 (fixed offsets tuned by eye).
    for (const channel of CHANNEL_NAMES) {
      for (const move of CHANNELS[channel] as Move[]) {
        for (const node of candidates) if (move.bones.test(baseName(node.name))) add(channel, node, move);
      }
    }
    // Family 2: offsets computed from the model's own geometry.
    if (this.channels.size === 0) {
      const head = vrm.humanoid.getRawBoneNode("head");
      if (head) for (const m of geometryMoves(head, candidates)) add(m.channel, m.node, m);
    }
    this.driven = [...byNode.values()];
  }

  private tmpQ = new THREE.Quaternion();
  private identity = new THREE.Quaternion();

  /** Poses the face. Weights are 0..1; channels add up on bones they share. */
  apply(w: Weights) {
    for (const d of this.driven) {
      d.node.position.copy(d.restPos);
      for (const o of d.offsets) {
        const k = w[o.channel];
        if (k) d.node.position.addScaledVector(o.local, k);
      }
      if (d.rotations.length) {
        d.node.quaternion.copy(d.restQuat);
        for (const r of d.rotations) {
          const k = w[r.channel];
          if (k) d.node.quaternion.multiply(this.tmpQ.copy(this.identity).slerp(r.delta, k));
        }
      }
    }
  }
}

// ---------- family 2: "LT eyelid A", "LU eyelid A", "L eyebrow A", "LT lip A", "jaw A"... -----------------------

/** Names like "LT_eyelid_A_12" (three.js turns spaces into "_"; exporters append an index). */
const fam2 = (n: string) => n.replace(/_\d{1,4}$/, "").replace(/_/g, " ").trim();

type GeoMove = { channel: Channel; node: THREE.Object3D } & ({ mm: [number, number, number] } | { rot: [number, number, number] });

/**
 * Eyelids, eyebrows, lips and jaw named "LT/LU/RT/RU eyelid A..D", "LI/LO eyelid", "L/R browskin A..E",
 * "T/U lip", "LT/LU lip A..D", "jaw A". Instead of fixed offsets, each movement is measured on the model:
 * to blink, every upper-lid bone moves down to the lower lid right below it, so it fits any face size or eye shape.
 */
export function geometryMoves(head: THREE.Object3D, nodes: THREE.Object3D[]): GeoMove[] {
  head.updateMatrixWorld(true);
  const origin = head.getWorldPosition(new THREE.Vector3());
  const pos = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3()).sub(origin).multiplyScalar(1000); // mm
  const find = (re: RegExp) => nodes.filter((o) => re.test(fam2(o.name)));
  const out: GeoMove[] = [];
  const mm = (channel: Channel, node: THREE.Object3D, x: number, y: number, z: number) => out.push({ channel, node, mm: [x, y, z] });

  for (const side of ["L", "R"]) {
    const upper = find(new RegExp(`^${side}T eyelid [A-Z]$`));
    const lower = find(new RegExp(`^${side}U eyelid [A-Z]$`));
    if (upper.length < 2 || lower.length < 2) continue;
    const corners = find(new RegExp(`^${side}[IO] eyelid$`));
    // Lower-lid line (corners included), to know how far each upper-lid bone has to travel.
    const line = [...lower, ...corners].map((o) => pos(o)).sort((a, b) => a.x - b.x);
    const lowerY = (x: number) => {
      if (x <= line[0].x) return line[0].y;
      for (let i = 1; i < line.length; i++) {
        if (x <= line[i].x) {
          const t = (x - line[i - 1].x) / (line[i].x - line[i - 1].x || 1);
          return line[i - 1].y + t * (line[i].y - line[i - 1].y);
        }
      }
      return line[line.length - 1].y;
    };
    const gaps = upper.map((o) => Math.max(0, pos(o).y - lowerY(pos(o).x)));
    const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    upper.forEach((o, i) => {
      const gap = gaps[i];
      mm("blink", o, 0, -0.88 * gap, 0);
      mm("eyeSmile", o, 0, -0.5 * gap, 0);
      mm("eyeWide", o, 0, 0.18 * meanGap, 0);
    });
    for (const o of lower) {
      mm("blink", o, 0, 0.12 * meanGap, 0);
      mm("eyeSmile", o, 0, 0.32 * meanGap, 0); // the lower lid arches up: anime "smiling eyes"
      mm("eyeWide", o, 0, -0.08 * meanGap, 0);
    }
    // Eyebrows: the skin bone carries the brow. Inner = closest to the nose.
    const brows = find(new RegExp(`^${side} browskin [A-Z]$`)).sort((a, b) => Math.abs(pos(a).x) - Math.abs(pos(b).x));
    const unit = Math.max(3, Math.min(8, meanGap * 0.45)); // ~6 mm on a typical face
    brows.forEach((o, i) => {
      const t = brows.length > 1 ? i / (brows.length - 1) : 0; // 0 inner .. 1 outer
      mm("browUp", o, 0, unit, 0);
      mm("browAngry", o, 0, unit * (-0.9 + 1.4 * t), 0);
      mm("browSad", o, 0, unit * (0.9 - 1.4 * t), 0);
    });
  }

  // Mouth: the outermost lip bones are the corners.
  const lips = find(/^(L|R)[TU] lip [A-Z]$/);
  if (lips.length) {
    const width = Math.max(...lips.map((o) => Math.abs(pos(o).x)));
    for (const o of lips) {
      const p = pos(o);
      const t = Math.abs(p.x) / (width || 1); // 0 centre .. 1 corner
      const out_ = Math.sign(p.x);
      const k = t * t; // mostly the corners
      mm("mouthSmile", o, out_ * 1.5 * k, 3 * k, 0);
      mm("mouthFrown", o, 0, -2.6 * k, 0);
      mm("mouthNarrow", o, -out_ * 2.5 * k, 0, 0);
      mm("mouthWide", o, out_ * 2.5 * k, 0.4 * k, 0);
    }
  }
  // Jaw: rotating it opens the mouth (the lower lip, lower teeth and tongue hang from it).
  const jaw = find(/^jaw [A-Z]$/)[0];
  if (jaw) {
    const lowerLip = find(/^U lip$/)[0];
    // Opening angle for ~11 mm at the lower lip, whatever the distance between the jaw pivot and the lips.
    const reach = lowerLip ? Math.max(30, Math.hypot(pos(lowerLip).y - pos(jaw).y, pos(lowerLip).z - pos(jaw).z)) : 100;
    out.push({ channel: "mouthOpen", node: jaw, rot: [11 / reach, 0, 0] });
  }
  return out;
}

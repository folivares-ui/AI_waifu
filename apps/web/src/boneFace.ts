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

    for (const channel of CHANNEL_NAMES) {
      for (const move of CHANNELS[channel] as Move[]) {
        for (const node of candidates) {
          if (!node.parent || !move.bones.test(baseName(node.name))) continue;
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
        }
      }
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

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Your own 3D models and voice samples are saved per character (see characters.ts). */
export const MAX_AVATAR_BYTES = 150 * 1024 * 1024;
export const MAX_VOICE_BYTES = 20 * 1024 * 1024;

/** VRM/GLB files are binary glTF: they start with "glTF". */
export const isGlb = (b: Buffer) => b.length > 20 && b.subarray(0, 4).toString("latin1") === "glTF";
/** WAV: "RIFF" .... "WAVE". */
export const isWav = (b: Buffer) => b.length > 44 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WAVE";

/** Writes to a temporary file first, so a crash never leaves half a model behind. */
export function saveAtomic(file: string, data: Buffer) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export function removeIfExists(file: string): boolean {
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

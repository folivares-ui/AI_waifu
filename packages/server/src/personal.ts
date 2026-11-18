import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { userPath } from "./paths.js";

/**
 * Your own avatar and voice sample, kept in the user folder (the repo's data/ folder, or the installed app's
 * data folder) so they load automatically every time. Never committed to Git and never included in the installer.
 */
export const avatarFile = () => userPath("data", "avatars", "default.vrm");
export const voiceFile = () => userPath("data", "voices", "voice-ref.wav");
/** Clips prepared earlier for Rice (rice-ref-2.wav is the recommended one). */
export const legacyVoiceFile = () => userPath("data", "voices", "rice-shower", "rice-ref-2.wav");

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

/** The voice sample to use: the one you uploaded, else the clip prepared for Rice if it is there. */
export function currentVoiceSample(): string | undefined {
  return [voiceFile(), legacyVoiceFile()].find((f) => existsSync(f));
}

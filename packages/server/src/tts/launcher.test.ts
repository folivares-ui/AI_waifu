import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ensureVoiceStudio, findVoiceStudio } from "./launcher.js";

const fakeChild = () => Object.assign(new EventEmitter(), { pid: 123, exitCode: null }) as unknown as ChildProcess;

describe("opening VoiceStudio automatically", () => {
  it("does nothing when it is already running", async () => {
    let launched = 0;
    const r = await ensureVoiceStudio("http://x", { exe: "C:/VS.exe", up: async () => true, launch: () => (launched++, fakeChild()) });
    expect(r.status).toBe("running");
    expect(launched).toBe(0);
  });
  it("opens it and waits until it answers", async () => {
    let checks = 0;
    const launched: string[] = [];
    const r = await ensureVoiceStudio("http://x", { exe: "C:/VS.exe", up: async () => ++checks >= 4, launch: (p) => (launched.push(p), fakeChild()), sleep: async () => {} });
    expect(r.status).toBe("started");
    expect(launched).toEqual(["C:/VS.exe"]);
  });
  it("explains when it cannot be found", async () => {
    expect((await ensureVoiceStudio("http://x", { up: async () => false })).status).toBe("not-found");
  });
  it("finds it from VOICESTUDIO_PATH or the usual install folders", () => {
    const has = (set: string[]) => (p: string) => set.includes(p);
    expect(findVoiceStudio({ VOICESTUDIO_PATH: '"D:\\Apps\\VoiceStudio.exe"' }, "win32", has(["D:\\Apps\\VoiceStudio.exe"]))).toBe("D:\\Apps\\VoiceStudio.exe");
    expect(findVoiceStudio({ VOICESTUDIO_PATH: "D:\\nope.exe" }, "win32", has([]))).toBeUndefined();
    const usual = "C:\\Users\\F\\AppData\\Local\\Programs\\VoiceStudio\\VoiceStudio.exe".replace(/\\/g, require("node:path").sep);
    const local = "C:\\Users\\F\\AppData\\Local".replace(/\\/g, require("node:path").sep);
    expect(findVoiceStudio({ LOCALAPPDATA: local }, "win32", has([usual]))).toBe(usual);
  });
});

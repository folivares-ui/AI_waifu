import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { ServerMessage } from "@waifu/core";
import { MockProvider } from "./llm/mock.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import { loadSoul } from "./soul.js";

it("a soul's motion style reaches the app (limited to sane values)", () => {
  const dir = mkdtempSync(join(tmpdir(), "motion-"));
  const f = join(dir, "x.soul.json");
  writeFileSync(f, JSON.stringify({ name: "X", persona: "p", motion: { energy: 99, tempo: -3, bounce: 0.5, fidget: "mucho" } }));
  const soul = loadSoul(f);
  expect(soul.motion).toEqual({ energy: 2.5, tempo: 0.5, bounce: 0.5, fidget: undefined });
  const out: ServerMessage[] = [];
  new Session(soul, new MockProvider(), new MemoryStore(join(dir, "m.json")), (m) => out.push(m)).hello();
  expect(out[0]).toMatchObject({ type: "ready", soul: { name: "X", motion: { energy: 2.5 } } });
});

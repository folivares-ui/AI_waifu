import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@waifu/core";
import { ActionLog } from "./actionLog.js";
import type { LLMEvent, LLMProvider, LLMRequest, ToolDef } from "./llm/index.js";
import { MemoryStore } from "./memory.js";
import { Session } from "./session.js";
import type { Soul } from "./soul.js";
import type { Tool } from "./tools/types.js";

const soul: Soul = { name: "T", language: "es-ES", voice: { lang: "es-ES", pitch: 1, rate: 1 }, persona: "p", boundaries: "" };
const until = async (c: () => boolean) => {
  for (let i = 0; i < 400 && !c(); i++) await new Promise((r) => setTimeout(r, 10));
};

/** Calls the given tools one after another (one per round), then says it is done. */
class Script implements LLMProvider {
  name = "script";
  constructor(private calls: { name: string; input?: unknown }[]) {}
  async *stream(req: LLMRequest): AsyncGenerator<string> {
    if (req.system.includes("Return ONLY")) yield "[]";
  }
  async *streamWithTools(req: LLMRequest & { tools: ToolDef[] }): AsyncGenerator<LLMEvent> {
    const n = req.messages.filter((m) => Array.isArray(m.content) && m.content[0]?.type === "tool_result").length;
    const c = this.calls[n];
    if (!c) {
      yield { type: "text", text: "Listo." };
      return;
    }
    yield { type: "tool_use", id: `c${n}`, name: c.name, input: c.input ?? {} };
  }
}

function setup(calls: { name: string; input?: unknown }[], answer: (req: Extract<ServerMessage, { type: "approval_request" }>, s: Session) => void) {
  const dir = mkdtempSync(join(tmpdir(), "ctl-"));
  const ran: string[] = [];
  const screen = (name: string, risky = false): Tool => ({
    def: { name, description: "d", input_schema: {} },
    kind: "write",
    controllable: true,
    describe: () => ({ summary: name, ...(risky ? { alwaysAsk: true } : {}) }),
    run: async () => {
      ran.push(name);
      return "ok";
    },
  });
  const save: Tool = { def: { name: "save_file", description: "d", input_schema: {} }, kind: "write", describe: () => ({ summary: "save" }), run: async () => (ran.push("save_file"), "ok") };
  const out: ServerMessage[] = [];
  const log = join(dir, "actions.jsonl");
  let s!: Session;
  s = new Session(soul, new Script(calls), new MemoryStore(join(dir, "m.json")), (m) => {
    out.push(m);
    if (m.type === "approval_request") answer(m, s);
  }, { tools: [screen("desktop_click"), screen("desktop_key", true), save], actionLog: new ActionLog(log), approvalTimeoutMs: 3000 });
  return { s, out, ran, asked: () => out.filter((m) => m.type === "approval_request").map((m) => (m as { tool: string }).tool), readLog: () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) };
}

describe('"Darle el control": screen control for the current activity', () => {
  it("after the user gives control, her next screen actions run without asking until the activity ends", async () => {
    const t = setup(
      [{ name: "desktop_click" }, { name: "desktop_click" }, { name: "desktop_click" }],
      (req, s) => s.handle({ type: "approval_response", id: req.id, approved: true, control: req.controllable }),
    );
    t.s.handle({ type: "user_text", text: "edita el documento" });
    await until(() => t.out.some((m) => m.type === "done"));
    expect(t.ran).toEqual(["desktop_click", "desktop_click", "desktop_click"]);
    expect(t.asked()).toEqual(["desktop_click"]); // only the first one
    const ctl = t.out.filter((m) => m.type === "control").map((m) => (m as { active: boolean }).active);
    expect(ctl).toEqual([true, false]); // given, then back to the user when she finished
    expect(t.readLog().map((e) => e.summary)).toEqual(["desktop_click", "desktop_click (con el control)", "desktop_click (con el control)"]);

    // a new activity starts without control: it asks again
    t.s.handle({ type: "user_text", text: "otra cosa" });
    await until(() => t.out.filter((m) => m.type === "done").length === 2);
    expect(t.asked()).toEqual(["desktop_click", "desktop_click"]);
  });

  it("risky shortcuts and other kinds of changes still ask while she has control", async () => {
    const t = setup(
      [{ name: "desktop_click" }, { name: "desktop_key" }, { name: "save_file" }, { name: "desktop_click" }],
      (req, s) => s.handle({ type: "approval_response", id: req.id, approved: true, control: req.controllable }),
    );
    t.s.handle({ type: "user_text", text: "hazlo" });
    await until(() => t.out.some((m) => m.type === "done"));
    expect(t.asked()).toEqual(["desktop_click", "desktop_key", "save_file"]);
    // the risky key and the file tool are never offered as a way to give control
    const offered = t.out.filter((m) => m.type === "approval_request").map((m) => !!(m as { controllable?: boolean }).controllable);
    expect(offered).toEqual([true, false, false]);
    expect(t.ran).toEqual(["desktop_click", "desktop_key", "save_file", "desktop_click"]);
  });

  it("the user can take it back at any moment: the next action asks again", async () => {
    let first = true;
    const t = setup([{ name: "desktop_click" }, { name: "desktop_click" }], (req, s) => {
      if (first) {
        first = false;
        s.handle({ type: "approval_response", id: req.id, approved: true, control: true });
        s.handle({ type: "control_revoke" });
        return;
      }
      s.handle({ type: "approval_response", id: req.id, approved: false });
    });
    t.s.handle({ type: "user_text", text: "hazlo" });
    await until(() => t.out.some((m) => m.type === "done"));
    expect(t.asked()).toEqual(["desktop_click", "desktop_click"]);
    expect(t.ran).toEqual(["desktop_click"]);
  });

  it("control cannot be taken without a pending card, nor given by answering no", async () => {
    const t = setup([{ name: "desktop_click" }, { name: "desktop_click" }], (req, s) => s.handle({ type: "approval_response", id: req.id, approved: false, control: true }));
    t.s.handle({ type: "approval_response", id: "guess", approved: true, control: true });
    t.s.handle({ type: "user_text", text: "hazlo" });
    await until(() => t.out.some((m) => m.type === "done"));
    expect(t.out.some((m) => m.type === "control")).toBe(false);
    expect(t.ran).toEqual([]);
  });
});

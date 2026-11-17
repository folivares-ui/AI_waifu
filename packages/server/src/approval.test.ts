import { mkdtempSync, readFileSync, existsSync } from "node:fs";
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
const tmp = () => mkdtempSync(join(tmpdir(), "appr-"));
const until = async (c: () => boolean) => { for (let i = 0; i < 400 && !c(); i++) await new Promise((r) => setTimeout(r, 10)); };
const done = (out: ServerMessage[]) => out.some((m) => m.type === "done");

/** Asks for `tool` once, then reports what came back. */
class OneCall implements LLMProvider {
  name = "one";
  results: any[] = [];
  constructor(private tool: string, private input: unknown = { path: "a.txt" }) {}
  async *stream(req: LLMRequest): AsyncGenerator<string> { if (req.system.includes("Return ONLY")) yield "[]"; }
  async *streamWithTools(req: LLMRequest & { tools: ToolDef[] }): AsyncGenerator<LLMEvent> {
    const last = req.messages.at(-1)!;
    if (Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
      this.results.push(last.content[0]);
      yield { type: "text", text: "Listo." };
      return;
    }
    yield { type: "tool_use", id: "c1", name: this.tool, input: this.input };
  }
}

function setup(opts: { answer?: "yes" | "no" | "never" | "interrupt"; describeThrows?: boolean; approvalTimeoutMs?: number; tool?: "write" | "read" } = {}) {
  const dir = tmp();
  const log = join(dir, "actions.jsonl");
  let ran = 0;
  const kind = opts.tool ?? "write";
  const tool: Tool = {
    def: { name: "save_file", description: "d", input_schema: {} },
    kind,
    describe: (input) => {
      if (opts.describeThrows) throw new Error("path outside the workspace");
      return { summary: `Guardar ${(input as { path: string }).path}`, details: "+ nueva linea" };
    },
    run: async () => { ran++; return "saved"; },
  };
  const llm = new OneCall("save_file");
  const out: ServerMessage[] = [];
  let s!: Session;
  s = new Session(soul, llm, new MemoryStore(join(dir, "m.json")), (m) => {
    out.push(m);
    if (m.type === "approval_request") {
      if (opts.answer === "yes") s.handle({ type: "approval_response", id: m.id, approved: true });
      if (opts.answer === "no") s.handle({ type: "approval_response", id: m.id, approved: false });
      if (opts.answer === "interrupt") s.handle({ type: "interrupt" });
    }
  }, { tools: [tool], actionLog: new ActionLog(log), approvalTimeoutMs: opts.approvalTimeoutMs ?? 5000 });
  return { s, out, llm, ran: () => ran, log, readLog: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}

describe("approval of write actions", () => {
  it("shows the card with summary/details, runs only after 'yes', and logs it", async () => {
    const t = setup({ answer: "yes" });
    t.s.handle({ type: "user_text", text: "guarda" });
    await until(() => done(t.out));
    const req = t.out.find((m) => m.type === "approval_request") as any;
    expect(req).toMatchObject({ tool: "save_file", summary: "Guardar a.txt", details: "+ nueva linea" });
    expect(t.ran()).toBe(1);
    expect(t.llm.results[0]).toMatchObject({ content: "saved" });
    // the card is shown BEFORE the tool starts
    expect(t.out.findIndex((m) => m.type === "approval_request")).toBeLessThan(t.out.findIndex((m) => m.type === "tool"));
    expect(t.readLog()).toEqual([expect.objectContaining({ tool: "save_file", summary: "Guardar a.txt", approved: true, ok: true })]);
  });

  it("never runs on 'no', tells the model, and logs the refusal", async () => {
    const t = setup({ answer: "no" });
    t.s.handle({ type: "user_text", text: "guarda" });
    await until(() => done(t.out));
    expect(t.ran()).toBe(0);
    expect(t.llm.results[0]).toMatchObject({ is_error: true, content: expect.stringContaining("did NOT approve") });
    expect(t.out.some((m) => m.type === "tool")).toBe(false);
    expect(t.readLog()).toEqual([expect.objectContaining({ approved: false })]);
  });

  it("counts silence as 'no' after the timeout and hides the card", async () => {
    const t = setup({ answer: "never", approvalTimeoutMs: 60 });
    t.s.handle({ type: "user_text", text: "guarda" });
    await until(() => done(t.out));
    const req = t.out.find((m) => m.type === "approval_request") as any;
    expect(t.out).toContainEqual({ type: "approval_cancel", id: req.id });
    expect(t.ran()).toBe(0);
  });

  it("an interruption cancels the pending approval", async () => {
    const t = setup({ answer: "interrupt" });
    t.s.handle({ type: "user_text", text: "guarda" });
    await until(() => done(t.out));
    expect(t.out.some((m) => m.type === "approval_cancel")).toBe(true);
    expect(t.ran()).toBe(0);
  });

  it("ignores approvals for unknown ids (no pre-approving) and late answers", async () => {
    const t = setup({ answer: "never", approvalTimeoutMs: 80 });
    t.s.handle({ type: "approval_response", id: "guess", approved: true }); // before anything was asked
    t.s.handle({ type: "user_text", text: "guarda" });
    await until(() => t.out.some((m) => m.type === "approval_request"));
    t.s.handle({ type: "approval_response", id: "other-id", approved: true });
    await until(() => done(t.out));
    const req = t.out.find((m) => m.type === "approval_request") as any;
    t.s.handle({ type: "approval_response", id: req.id, approved: true }); // too late
    await new Promise((r) => setTimeout(r, 30));
    expect(t.ran()).toBe(0);
  });

  it("an invalid request (describe throws) is refused without bothering the user", async () => {
    const t = setup({ answer: "yes", describeThrows: true });
    t.s.handle({ type: "user_text", text: "guarda" });
    await until(() => done(t.out));
    expect(t.out.some((m) => m.type === "approval_request")).toBe(false);
    expect(t.ran()).toBe(0);
    expect(t.llm.results[0].content).toContain("outside the workspace");
  });

  it("read tools run without asking and are not logged as actions", async () => {
    const t = setup({ answer: "never", tool: "read" });
    t.s.handle({ type: "user_text", text: "lee" });
    await until(() => done(t.out));
    expect(t.out.some((m) => m.type === "approval_request")).toBe(false);
    expect(t.ran()).toBe(1);
    expect(t.readLog()).toEqual([]);
  });
});

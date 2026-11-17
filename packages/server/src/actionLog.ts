import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ActionRecord {
  tool: string;
  summary: string;
  /** Whether the user approved (write tools) or "not-needed" (read tools are not logged). */
  approved: boolean;
  /** Outcome when it ran. */
  ok?: boolean;
  error?: string;
}

/** Append-only JSON-lines log of every action she asked to perform, approved or not. Kept on this computer. */
export class ActionLog {
  constructor(private path?: string) {}

  record(r: ActionRecord) {
    if (!this.path) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...r, summary: r.summary.slice(0, 500), error: r.error?.slice(0, 300) });
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, line + "\n");
    } catch (e) {
      console.warn("[actions] could not write log:", e);
    }
  }
}

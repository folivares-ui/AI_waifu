import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { TEXT_EXTS, applyXlsxUpdate, buildDocument, docxReplace, lineDiff, planXlsxUpdate, readDocument, type CellUpdate, type NewDocument } from "./documents.js";
import { untrusted, type Tool } from "./types.js";
import type { Workspace } from "./workspace.js";

const MAX_OUT = 14_000;
const clip = (s: string) => (s.length > MAX_OUT ? s.slice(0, MAX_OUT) + `\n...[truncado: ${s.length - MAX_OUT} caracteres mas; pide una hoja o parte concreta]` : s);

/** Windows locks files that are open in Office: explain it instead of a raw EBUSY. */
async function writeSafely(path: string, data: Buffer | string) {
  try {
    await writeFile(path, data);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
      throw new Error(`The file is locked or read-only (${code}); it is probably open in Word/Excel/PowerPoint. Ask the user to close it and try again.`);
    }
    throw e;
  }
}

const str = (v: unknown, what: string) => {
  if (typeof v !== "string" || !v) throw new Error(`${what} is required.`);
  return v;
};

/**
 * Document tools over the user's workspace folders: list/read are free, every change asks first,
 * shows exactly what will change, and keeps a backup copy of the previous version.
 */
export function createFileTools(ws: Workspace): Tool[] {
  const listFiles: Tool = {
    kind: "read",
    def: {
      name: "list_files",
      description: "List files in the user's workspace folders (the only folders you may use). Path relative to the workspace, '.' for its root.",
      input_schema: { type: "object", properties: { folder: { type: "string" } } },
    },
    async run(input) {
      return ws.list((input as { folder?: string })?.folder || ".");
    },
  };

  const readDoc: Tool = {
    kind: "read",
    def: {
      name: "read_document",
      description:
        "Read a file from the workspace: Word (.docx), Excel (.xlsx, cells with addresses and formulas), PowerPoint (.pptx, text and notes per slide), PDF, or text/code files. Use it before suggesting improvements or edits.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, sheet: { type: "string", description: "Excel: only this sheet" }, max_rows: { type: "integer", minimum: 1, maximum: 2000 } },
        required: ["path"],
      },
    },
    async run(input) {
      const i = input as { path: string; sheet?: string; max_rows?: number };
      const real = ws.resolve(str(i?.path, "path"), { mustExist: true });
      if (statSync(real).size > 50_000_000) throw new Error("File too large (> 50 MB).");
      return untrusted(ws.display(real), clip(await readDocument(real, { sheet: i.sheet, maxRows: i.max_rows })));
    },
  };

  const writeText: Tool = {
    kind: "write",
    def: {
      name: "write_text_file",
      description: "Create or overwrite a plain-text/code file in the workspace (.txt, .md, .csv, .json, .py, .js, .html...). The user sees the diff and must approve.",
      input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
    },
    async describe(input) {
      const i = input as { path: string; content: string };
      const real = ws.resolve(str(i?.path, "path"));
      if (!TEXT_EXTS.has(extname(real).toLowerCase())) throw new Error("write_text_file only writes text/code files; use create_document for Office files.");
      if (typeof i.content !== "string") throw new Error("content is required.");
      const before = existsSync(real) ? await readFile(real, "utf8") : "";
      return {
        summary: `${existsSync(real) ? "Modificar" : "Crear"} ${ws.display(real)}`,
        details: existsSync(real) ? lineDiff(before, i.content) : i.content.slice(0, 4000),
      };
    },
    async run(input) {
      const i = input as { path: string; content: string };
      const real = ws.resolve(i.path);
      const backup = ws.backup(real);
      await writeSafely(real, i.content);
      return `Saved ${ws.display(real)}${backup ? ` (previous version backed up)` : ""}.`;
    },
  };

  const excel: Tool = {
    kind: "write",
    def: {
      name: "excel_update_cells",
      description:
        "Change cells in an .xlsx workbook in the workspace. A value starting with '=' is written as a formula (English function names, e.g. =SUM(B2:B9)). Read the workbook first. The user sees every old→new value and must approve.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          sheet: { type: "string", description: "Sheet name (default: first sheet)" },
          cells: {
            type: "array",
            items: { type: "object", properties: { cell: { type: "string", description: "e.g. B7" }, value: { type: ["string", "number", "boolean", "null"] } }, required: ["cell"] },
          },
        },
        required: ["path", "cells"],
      },
    },
    async describe(input) {
      const i = input as { path: string; sheet?: string; cells: CellUpdate[] };
      const real = ws.resolve(str(i?.path, "path"), { mustExist: true });
      if (extname(real).toLowerCase() !== ".xlsx") throw new Error("Only .xlsx workbooks can be edited (not .xls/.xlsm).");
      const { lines } = await planXlsxUpdate(real, i.sheet, i.cells);
      return { summary: `Cambiar ${lines.length} celda(s) en ${ws.display(real)}`, details: lines.join("\n") };
    },
    async run(input) {
      const i = input as { path: string; sheet?: string; cells: CellUpdate[] };
      const real = ws.resolve(i.path, { mustExist: true });
      ws.backup(real);
      const n = await applyXlsxUpdate(real, i.sheet, i.cells);
      return `Updated ${n} cell(s) in ${ws.display(real)} (previous version backed up). Formulas are recalculated when the file is opened in Excel.`;
    },
  };

  const word: Tool = {
    kind: "write",
    def: {
      name: "word_replace_text",
      description:
        "Replace text in a .docx document in the workspace (body, headers, footers, notes), keeping formatting. Use exact text read with read_document. The user sees before/after examples and must approve.",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" }, all: { type: "boolean", description: "Replace every occurrence (default: only the first)" } },
        required: ["path", "find", "replace"],
      },
    },
    async describe(input) {
      const i = input as { path: string; find: string; replace: string; all?: boolean };
      const real = ws.resolve(str(i?.path, "path"), { mustExist: true });
      if (extname(real).toLowerCase() !== ".docx") throw new Error("Only .docx documents can be edited.");
      const { count, samples } = await docxReplace(await readFile(real), str(i.find, "find"), String(i.replace ?? ""), i.all ? 1000 : 1);
      if (count === 0) throw new Error(`Text not found in ${ws.display(real)}: "${i.find.slice(0, 80)}". It must match exactly (read the document first).`);
      return { summary: `Reemplazar ${count} vez/veces en ${ws.display(real)}`, details: samples.join("\n\n") };
    },
    async run(input) {
      const i = input as { path: string; find: string; replace: string; all?: boolean };
      const real = ws.resolve(i.path, { mustExist: true });
      const { count, output } = await docxReplace(await readFile(real), i.find, String(i.replace ?? ""), i.all ? 1000 : 1);
      if (!output) throw new Error("Text not found (the document may have changed).");
      ws.backup(real);
      await writeSafely(real, output);
      return `Replaced ${count} occurrence(s) in ${ws.display(real)} (previous version backed up).`;
    },
  };

  const create: Tool = {
    kind: "write",
    def: {
      name: "create_document",
      description:
        "Create a NEW file in the workspace: .docx (text with '# ' / '## ' headings and '- ' bullets), .pptx (slides with title, bullets, notes), .xlsx (sheets with rows; '=' starts a formula) or a text file. Never overwrites an existing file.",
      input_schema: {
        type: "object",
        properties: {
          path: { type: "string" },
          text: { type: "string" },
          slides: { type: "array", items: { type: "object", properties: { title: { type: "string" }, bullets: { type: "array", items: { type: "string" } }, notes: { type: "string" } }, required: ["title"] } },
          sheets: { type: "array", items: { type: "object", properties: { name: { type: "string" }, rows: { type: "array", items: { type: "array" } } }, required: ["name", "rows"] } },
        },
        required: ["path"],
      },
    },
    async describe(input) {
      const i = input as NewDocument & { path: string };
      const real = ws.resolve(str(i?.path, "path"));
      if (existsSync(real)) throw new Error(`${ws.display(real)} already exists; choose another name (create_document never overwrites).`);
      await buildDocument(real, i); // validates the content before asking
      const preview = i.slides
        ? i.slides.map((s, n) => `${n + 1}. ${s.title}${s.bullets?.length ? "\n   - " + s.bullets.join("\n   - ") : ""}`).join("\n")
        : i.sheets
          ? i.sheets.map((s) => `[${s.name}]\n` + (s.rows ?? []).slice(0, 15).map((r) => r.join(" | ")).join("\n")).join("\n")
          : String(i.text ?? "").slice(0, 3000);
      return { summary: `Crear ${ws.display(real)}`, details: preview };
    },
    async run(input) {
      const i = input as NewDocument & { path: string };
      const real = ws.resolve(i.path);
      if (existsSync(real)) throw new Error("The file appeared in the meantime; not overwriting it.");
      await writeSafely(real, await buildDocument(real, i));
      return `Created ${ws.display(real)}.`;
    },
  };

  return [listFiles, readDoc, writeText, excel, word, create];
}

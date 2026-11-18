import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Document, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { applyXlsxUpdate, buildDocument, docxReplace, lineDiff, readDocument } from "./documents.js";
import { createFileTools } from "./files.js";
import type { Tool } from "./types.js";
import { Workspace } from "./workspace.js";

const tmp = () => mkdtempSync(join(tmpdir(), "docs-"));
const tool = (tools: Tool[], name: string) => tools.find((t) => t.def.name === name)!;

/** Smallest valid single-page PDF with one line of text (offsets computed, so the xref table is correct). */
function tinyPdf(text: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("Workspace", () => {
  it("allows paths inside, refuses .., absolute paths and symlinks that escape", () => {
    const base = tmp();
    const root = join(base, "ws");
    const outside = join(base, "secret");
    mkdirSync(outside);
    writeFileSync(join(outside, "keys.txt"), "TOP SECRET");
    const ws = new Workspace([root]);
    symlinkSync(outside, join(root, "link"));
    expect(ws.resolve("notes/new.md")).toBe(join(ws.roots[0], "notes", "new.md")); // non-existing nested path is fine
    expect(() => ws.resolve("../secret/keys.txt")).toThrow(/outside/);
    expect(() => ws.resolve(join(outside, "keys.txt"))).toThrow(/outside/);
    expect(() => ws.resolve("link/keys.txt")).toThrow(/outside/); // symlink resolved to its real target
    expect(() => ws.resolve("link/new.txt")).toThrow(/outside/); // even for files that do not exist yet
    expect(() => ws.resolve("missing.txt", { mustExist: true })).toThrow(/not found/);
    expect(() => ws.resolve("")).toThrow(/required/);
  });
});

describe("documents", () => {
  it("replaces text in Word even when it is split across formatting runs, keeping the rest", async () => {
    const doc = new Document({
      sections: [{ children: [new Paragraph({ children: [new TextRun("Hola mu"), new TextRun({ text: "ndo cruel", bold: true }), new TextRun(" & adios")] }), new Paragraph("Otro mundo aqui")] }],
    });
    const buf = await Packer.toBuffer(doc);
    const one = await docxReplace(buf, "mundo cruel", "planeta <bonito>", 1);
    expect(one.count).toBe(1);
    const dir = tmp();
    writeFileSync(join(dir, "a.docx"), one.output!);
    expect(await readDocument(join(dir, "a.docx"))).toBe("Hola planeta <bonito> & adios\n\nOtro mundo aqui");
    const all = await docxReplace(buf, "mundo", "MUNDO", 1000);
    expect(all.count).toBe(2);
    expect(all.samples[0]).toMatch(/^- Hola mundo cruel & adios\n\+ Hola MUNDO cruel & adios/);
    expect((await docxReplace(buf, "no existe", "x")).count).toBe(0);
  });

  it("creates and reads back Excel with formulas, then updates cells", async () => {
    const dir = tmp();
    const p = join(dir, "b.xlsx");
    writeFileSync(p, await buildDocument(p, { sheets: [{ name: "Ventas", rows: [["Mes", "Total"], ["Ene", 10], ["Feb", 32], ["Suma", "=SUM(B2:B3)"]] }] }));
    const text = await readDocument(p);
    expect(text).toContain('=== Hoja "Ventas"');
    expect(text).toContain("A2=Ene | B2=10");
    expect(text).toContain("B4==SUM(B2:B3)");
    await applyXlsxUpdate(p, "Ventas", [{ cell: "B3", value: 40 }, { cell: "C1", value: "Nota" }, { cell: "c4", value: "=B4*2" }]);
    const after = await readDocument(p);
    expect(after).toContain("B3=40");
    expect(after).toContain("C1=Nota");
    expect(after).toContain("C4==B4*2");
  });

  it("refuses to save workbooks with charts/macros (they would be lost)", async () => {
    const dir = tmp();
    const p = join(dir, "c.xlsx");
    const zip = await JSZip.loadAsync(await buildDocument(p, { sheets: [{ name: "S", rows: [[1]] }] }));
    zip.file("xl/charts/chart1.xml", "<c/>");
    writeFileSync(p, await zip.generateAsync({ type: "nodebuffer" }));
    await expect(applyXlsxUpdate(p, undefined, [{ cell: "A1", value: 2 }])).rejects.toThrow(/graficos/);
  });

  it("creates and reads PowerPoint slides with notes", async () => {
    const dir = tmp();
    const p = join(dir, "d.pptx");
    writeFileSync(p, await buildDocument(p, { slides: [{ title: "Hola", bullets: ["Uno", "Dos"], notes: "Decir algo" }, { title: "Fin" }] }));
    const t = await readDocument(p);
    expect(t).toMatch(/--- Diapositiva 1 ---\nHola\nUno\nDos\n\[Notas\] Decir algo/);
    expect(t).toContain("--- Diapositiva 2 ---\nFin");
  });

  it("reads PDF text page by page", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "e.pdf"), tinyPdf("Hola desde un PDF"));
    expect(await readDocument(join(dir, "e.pdf"))).toBe("--- Pagina 1/1 ---\nHola desde un PDF");
  });

  it("explains unsupported legacy formats", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "old.doc"), "x");
    await expect(readDocument(join(dir, "old.doc"))).rejects.toThrow(/save it as .docx/);
  });

  it("lineDiff shows only changes with context", () => {
    expect(lineDiff("a\nb\nc\nd\ne\nf\ng", "a\nb\nc\nX\ne\nf\ng", 1)).toBe("  ...\n  c\n- d\n+ X\n  e\n  ...");
    expect(lineDiff("same", "same")).toBe("(sin cambios)");
  });
});

describe("file tools", () => {
  const setup = () => {
    const base = tmp();
    const ws = new Workspace([join(base, "ws")], join(base, "backups"));
    return { ws, base, tools: createFileTools(ws), root: ws.roots[0] };
  };

  it("classifies tools: listing/reading are free, everything else needs approval", () => {
    const { tools } = setup();
    expect(Object.fromEntries(tools.map((t) => [t.def.name, t.kind]))).toEqual({
      list_files: "read",
      read_document: "read",
      write_text_file: "write",
      excel_update_cells: "write",
      word_replace_text: "write",
      create_document: "write",
      find_files: "read",
      request_file_access: "write",
    });
  });

  it("write_text_file: approval shows a diff, the old version is backed up", async () => {
    const { tools, root, base } = setup();
    writeFileSync(join(root, "n.md"), "uno\ndos\ntres");
    const w = tool(tools, "write_text_file");
    const info = await w.describe!({ path: "n.md", content: "uno\nDOS\ntres" });
    expect(info).toEqual({ summary: "Modificar n.md", details: "  uno\n- dos\n+ DOS\n  tres" });
    await w.run({ path: "n.md", content: "uno\nDOS\ntres" });
    expect(readFileSync(join(root, "n.md"), "utf8")).toBe("uno\nDOS\ntres");
    const stamp = readdirSync(join(base, "backups"))[0];
    expect(readFileSync(join(base, "backups", stamp, "n.md"), "utf8")).toBe("uno\ndos\ntres");
    await expect(w.describe!({ path: "x.exe", content: "MZ" })).rejects.toThrow(/text\/code/);
    await expect(w.describe!({ path: "../../evil.txt", content: "x" })).rejects.toThrow(/outside/);
  });

  it("excel/word tools describe exactly what changes, and reading output is marked untrusted", async () => {
    const { tools, root } = setup();
    const create = tool(tools, "create_document");
    const xl = { path: "t.xlsx", sheets: [{ name: "Hoja1", rows: [["a", 1]] }] };
    expect((await create.describe!(xl)).summary).toBe("Crear t.xlsx");
    await create.run(xl);
    await expect(create.describe!(xl)).rejects.toThrow(/already exists/);
    const upd = await tool(tools, "excel_update_cells").describe!({ path: "t.xlsx", cells: [{ cell: "B1", value: 5 }] });
    expect(upd.details).toBe("Hoja1!B1: 1  →  5");
    await expect(tool(tools, "excel_update_cells").describe!({ path: "t.xlsx", cells: [{ cell: "ZZZZ1", value: 5 }] })).rejects.toThrow(/Invalid cell/);

    await create.run({ path: "w.docx", text: "# Titulo\nTexto con un eror." });
    const wr = tool(tools, "word_replace_text");
    expect((await wr.describe!({ path: "w.docx", find: "eror", replace: "error" })).details).toBe("- Texto con un eror.\n+ Texto con un error.");
    await expect(wr.describe!({ path: "w.docx", find: "nada", replace: "x" })).rejects.toThrow(/not found/);
    await wr.run({ path: "w.docx", find: "eror", replace: "error" });
    const read = await tool(tools, "read_document").run({ path: "w.docx" });
    expect(read).toContain("<untrusted_external_data");
    expect(read).toContain("Titulo\n\nTexto con un error.");
    expect(existsSync(join(root, "w.docx"))).toBe(true);
    expect(await tool(tools, "list_files").run({})).toMatch(/t\.xlsx[\s\S]*w\.docx/);
  });
});

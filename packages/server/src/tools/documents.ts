import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import mammoth from "mammoth";
import PptxGenJS from "pptxgenjs";
import { extractText } from "unpdf";

/** Plain-text formats she may read and write directly. */
export const TEXT_EXTS = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".html", ".htm", ".css", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".xml", ".yaml", ".yml", ".ini", ".toml", ".log", ".sql", ".sh", ".ps1", ".bat", ".c", ".cpp", ".h", ".cs", ".java", ".go", ".rs", ".php", ".rb", ".lua"]);
const MAX_TEXT_BYTES = 400_000;

const ext = (p: string) => extname(p).toLowerCase();

// ---------- reading ----------------------------------------------------------------------------------------------

export async function readDocument(path: string, opts: { sheet?: string; maxRows?: number } = {}): Promise<string> {
  const e = ext(path);
  if (e === ".docx") return (await mammoth.extractRawText({ path })).value.trim();
  if (e === ".xlsx" || e === ".xlsm") return readXlsx(path, opts.sheet, opts.maxRows ?? 200);
  if (e === ".pptx") return readPptx(await readFile(path));
  if (e === ".pdf") {
    const { totalPages, text } = await extractText(new Uint8Array(await readFile(path)), { mergePages: false });
    return text.map((t, i) => `--- Pagina ${i + 1}/${totalPages} ---\n${t.trim()}`).join("\n");
  }
  if (TEXT_EXTS.has(e)) {
    const buf = await readFile(path);
    if (buf.length > MAX_TEXT_BYTES) return buf.subarray(0, MAX_TEXT_BYTES).toString("utf8") + "\n...[truncado]";
    return buf.toString("utf8");
  }
  if (e === ".doc" || e === ".xls" || e === ".ppt") throw new Error(`The old binary format ${e} is not supported: save it as ${e}x first.`);
  throw new Error(`Unsupported file type "${e || "(none)"}".`);
}

/** Readable form of an Excel cell value (formulas shown as "=FORMULA → result"). */
export function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if ("formula" in v || "sharedFormula" in v) {
      const f = (v as ExcelJS.CellFormulaValue).formula ?? (v as ExcelJS.CellSharedFormulaValue).sharedFormula;
      const r = (v as ExcelJS.CellFormulaValue).result;
      return `=${f}${r !== undefined && r !== null ? ` → ${cellText(r as ExcelJS.CellValue)}` : ""}`;
    }
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("hyperlink" in v) return `${(v as ExcelJS.CellHyperlinkValue).text} (${(v as ExcelJS.CellHyperlinkValue).hyperlink})`;
    if ("error" in v) return String((v as ExcelJS.CellErrorValue).error);
  }
  return String(v);
}

async function readXlsx(path: string, sheetName: string | undefined, maxRows: number): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const sheets = sheetName ? [wb.getWorksheet(sheetName)] : wb.worksheets;
  if (sheetName && !sheets[0]) throw new Error(`Sheet "${sheetName}" not found. Sheets: ${wb.worksheets.map((w) => w.name).join(", ")}`);
  const out: string[] = [`Hojas: ${wb.worksheets.map((w) => w.name).join(", ")}`];
  for (const ws of sheets) {
    if (!ws) continue;
    out.push(`\n=== Hoja "${ws.name}" (${ws.rowCount} filas x ${ws.columnCount} columnas) ===`);
    let shown = 0;
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (shown++ >= maxRows) return;
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => cells.push(`${cell.address}=${cellText(cell.value)}`));
      out.push(`${n}: ${cells.join(" | ")}`);
    });
    if (shown > maxRows) out.push(`...[${shown - maxRows} filas mas]`);
  }
  return out.join("\n");
}

const XML_ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const decodeXml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);|&#(\d+);|&#x([0-9a-f]+);/gi, (m, _n, d, h) => (d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : XML_ENTITIES[m.toLowerCase()]));
const encodeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const slideNo = (name: string) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

async function readPptx(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const slides = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b));
  const out: string[] = [];
  for (const name of slides) {
    const xml = await zip.file(name)!.async("string");
    const paras = [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
      .map((p) => [...p[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => decodeXml(t[1])).join(""))
      .filter((t) => t.trim());
    const notesFile = zip.file(`ppt/notesSlides/notesSlide${slideNo(name)}.xml`);
    const notes = notesFile ? [...(await notesFile.async("string")).matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => decodeXml(t[1])).join(" ").trim() : "";
    out.push(`--- Diapositiva ${slideNo(name)} ---\n${paras.join("\n")}${notes ? `\n[Notas] ${notes}` : ""}`);
  }
  return out.join("\n") || "(presentacion sin texto)";
}

// ---------- Excel editing ----------------------------------------------------------------------------------------

export interface CellUpdate {
  cell: string;
  /** Plain value; a string starting with "=" is written as a formula. */
  value?: string | number | boolean | null;
}

/** Features that ExcelJS cannot round-trip: saving would silently drop them, so we refuse instead. */
export async function xlsxUnsafeFeatures(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);
  const found: string[] = [];
  if (names.some((n) => n.startsWith("xl/charts/"))) found.push("graficos");
  if (names.some((n) => n.startsWith("xl/pivotTables/"))) found.push("tablas dinamicas");
  if (names.some((n) => n.endsWith("vbaProject.bin"))) found.push("macros");
  if (names.some((n) => n.startsWith("xl/slicers/"))) found.push("segmentaciones");
  return found;
}

const CELL_RE = /^[A-Z]{1,3}[1-9]\d{0,6}$/;

export async function planXlsxUpdate(path: string, sheetName: string | undefined, updates: CellUpdate[]) {
  if (!Array.isArray(updates) || updates.length === 0) throw new Error("No cells to update.");
  if (updates.length > 500) throw new Error("Too many cells in one change (max 500).");
  const buf = await readFile(path);
  const unsafe = await xlsxUnsafeFeatures(buf);
  if (unsafe.length) throw new Error(`This workbook has ${unsafe.join(", ")}, which would be lost when saving with this method. Edit it with Excel open instead.`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) throw new Error(`Sheet "${sheetName}" not found. Sheets: ${wb.worksheets.map((w) => w.name).join(", ")}`);
  const lines = updates.map((u) => {
    const addr = String(u.cell ?? "").toUpperCase().replace(/\$/g, "");
    if (!CELL_RE.test(addr)) throw new Error(`Invalid cell address "${u.cell}".`);
    const before = cellText(ws.getCell(addr).value);
    const after = u.value === null || u.value === undefined ? "(vacia)" : String(u.value);
    return `${ws.name}!${addr}: ${before || "(vacia)"}  →  ${after}`;
  });
  return { wb, ws, lines };
}

export async function applyXlsxUpdate(path: string, sheetName: string | undefined, updates: CellUpdate[]) {
  const { wb, ws } = await planXlsxUpdate(path, sheetName, updates);
  for (const u of updates) {
    const cell = ws.getCell(String(u.cell).toUpperCase().replace(/\$/g, ""));
    const v = u.value;
    if (typeof v === "string" && v.startsWith("=")) cell.value = { formula: v.slice(1) } as ExcelJS.CellFormulaValue;
    else cell.value = v ?? null;
  }
  await writeFile(path, Buffer.from(await wb.xlsx.writeBuffer()));
  return updates.length;
}

// ---------- Word editing -----------------------------------------------------------------------------------------

const DOCX_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
// Innermost paragraphs only (paragraphs inside text boxes are nested inside an outer <w:p>).
const PARAGRAPH = /<w:p\b[^>]*>(?:(?!<w:p\b)[\s\S])*?<\/w:p>/g;
const TEXT_NODE = /(<w:t(?:\s[^>]*)?>)([^<]*)(<\/w:t>)/g;

/**
 * Replaces text in a .docx even when Word split it across several formatting runs.
 * The replacement takes the formatting of the run where the match starts. Returns the new XML parts and
 * a few before/after snippets for the approval card.
 */
export async function docxReplace(buf: Buffer, find: string, replace: string, maxCount = 1000) {
  if (!find) throw new Error("Text to find is empty.");
  const zip = await JSZip.loadAsync(buf);
  let count = 0;
  const samples: string[] = [];
  for (const name of Object.keys(zip.files).filter((n) => DOCX_PARTS.test(n))) {
    const xml = await zip.file(name)!.async("string");
    const next = xml.replace(PARAGRAPH, (para) => {
      const nodes = [...para.matchAll(TEXT_NODE)].map((m) => ({ open: m[1], text: decodeXml(m[2]), close: m[3], at: m.index!, len: m[0].length }));
      const full = nodes.map((n) => n.text).join("");
      if (!full.includes(find) || count >= maxCount) return para;
      // positions of matches in the paragraph's plain text (non-overlapping, left to right)
      const hits: number[] = [];
      for (let i = full.indexOf(find); i !== -1 && count + hits.length < maxCount; i = full.indexOf(find, i + find.length)) hits.push(i);
      if (samples.length < 5) samples.push(`- ${full.slice(0, 160)}\n+ ${full.split(find).join(replace).slice(0, 160)}`);
      count += hits.length;
      const texts = nodes.map((n) => n.text);
      const starts = nodes.reduce<number[]>((acc, n, i) => (acc.push(i ? acc[i - 1] + nodes[i - 1].text.length : 0), acc), []);
      const locate = (pos: number) => {
        for (let i = nodes.length - 1; i >= 0; i--) if (pos >= starts[i] && (pos < starts[i] + texts[i].length || i === nodes.length - 1)) return i;
        return 0;
      };
      for (const h of hits.reverse()) {
        const end = h + find.length;
        const a = locate(h);
        const b = locate(end - 1);
        const offA = h - starts[a];
        const offB = end - starts[b];
        if (a === b) texts[a] = texts[a].slice(0, offA) + replace + texts[a].slice(offB);
        else {
          texts[a] = texts[a].slice(0, offA) + replace;
          for (let i = a + 1; i < b; i++) texts[i] = "";
          texts[b] = texts[b].slice(offB);
        }
      }
      let outPara = "";
      let last = 0;
      nodes.forEach((n, i) => {
        const open = /^\s|\s$/.test(texts[i]) && !n.open.includes("xml:space") ? n.open.replace("<w:t", '<w:t xml:space="preserve"') : n.open;
        outPara += para.slice(last, n.at) + open + encodeXml(texts[i]) + n.close;
        last = n.at + n.len;
      });
      return outPara + para.slice(last);
    });
    if (next !== xml) zip.file(name, next);
  }
  return { count, samples, output: count ? await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }) : undefined };
}

// ---------- creating documents -----------------------------------------------------------------------------------

export interface NewDocument {
  /** docx / txt / md: lines; "# " and "## " make headings, "- " bullets. */
  text?: string;
  /** pptx */
  slides?: { title: string; bullets?: string[]; notes?: string }[];
  /** xlsx: cells starting with "=" become formulas. */
  sheets?: { name: string; rows: (string | number | boolean | null)[][] }[];
}

export async function buildDocument(path: string, c: NewDocument): Promise<Buffer> {
  const e = ext(path);
  if (e === ".docx") {
    const lines = String(c.text ?? "").split(/\r?\n/);
    const children = lines.map((l) => {
      if (l.startsWith("## ")) return new Paragraph({ text: l.slice(3), heading: HeadingLevel.HEADING_2 });
      if (l.startsWith("# ")) return new Paragraph({ text: l.slice(2), heading: HeadingLevel.HEADING_1 });
      if (/^[-*] /.test(l)) return new Paragraph({ text: l.slice(2), bullet: { level: 0 } });
      return new Paragraph({ text: l });
    });
    return Packer.toBuffer(new Document({ sections: [{ children }] }));
  }
  if (e === ".pptx") {
    if (!c.slides?.length) throw new Error("A presentation needs at least one slide.");
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    for (const s of c.slides) {
      const slide = pptx.addSlide();
      slide.addText(String(s.title ?? ""), { x: 0.6, y: 0.4, w: 12, h: 1, fontSize: 32, bold: true });
      if (s.bullets?.length) slide.addText(s.bullets.map((b) => ({ text: String(b), options: { bullet: true } })), { x: 0.8, y: 1.6, w: 11.5, h: 5, fontSize: 20, valign: "top" });
      if (s.notes) slide.addNotes(String(s.notes));
    }
    return Buffer.from((await pptx.write({ outputType: "nodebuffer" })) as Uint8Array);
  }
  if (e === ".xlsx") {
    if (!c.sheets?.length) throw new Error("A workbook needs at least one sheet.");
    const wb = new ExcelJS.Workbook();
    for (const s of c.sheets) {
      const ws = wb.addWorksheet(String(s.name || "Hoja1").slice(0, 31));
      for (const row of s.rows ?? []) {
        ws.addRow(row.map((v) => (typeof v === "string" && v.startsWith("=") ? ({ formula: v.slice(1) } as ExcelJS.CellFormulaValue) : v)));
      }
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  if (TEXT_EXTS.has(e)) return Buffer.from(String(c.text ?? ""), "utf8");
  throw new Error(`Cannot create "${e}" files (use .docx, .xlsx, .pptx, .md, .txt or another text format).`);
}

/** Compact line diff (LCS) for the approval card. Large inputs fall back to a size summary. */
export function lineDiff(before: string, after: string, context = 2, maxLines = 120): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length * b.length > 4_000_000) return `(${a.length} lineas → ${b.length} lineas; demasiado grande para mostrar el cambio)`;
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: { t: " " | "-" | "+"; s: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) (ops.push({ t: " ", s: a[i] }), i++, j++);
    // deletions before insertions, the usual diff convention
    else if (i < a.length && (j === b.length || dp[i + 1][j] >= dp[i][j + 1])) (ops.push({ t: "-", s: a[i] }), i++);
    else (ops.push({ t: "+", s: b[j] }), j++);
  }
  const keep = ops.map((o, k) => o.t !== " " || ops.slice(Math.max(0, k - context), k + context + 1).some((x) => x.t !== " "));
  const out: string[] = [];
  ops.forEach((o, k) => {
    if (keep[k]) out.push(`${o.t} ${o.s}`);
    else if (out.at(-1) !== "  ...") out.push("  ...");
  });
  if (!ops.some((o) => o.t !== " ")) return "(sin cambios)";
  return out.length > maxLines ? out.slice(0, maxLines).join("\n") + `\n... (${out.length - maxLines} lineas mas)` : out.join("\n");
}

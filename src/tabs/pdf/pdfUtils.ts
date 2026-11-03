// The LEGACY pdf.js build, deliberately: the modern build targets bleeding-edge
// engines and calls Map.prototype.getOrInsertComputed natively — today's
// WKWebView lacks it, surfacing as "getOrInsertComputed is not a function" the
// moment a page is fetched for preview. Legacy is pdf.js's supported path for
// every engine that isn't this year's Chrome.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
// Run pdf.js entirely on the main thread (its "fake worker" mode): the worker
// module is bundled statically and handed over via the global pdf.js checks
// FIRST, before any Worker construction. Real Worker boot inside the Tauri
// webview proved unreliable in both flavors — a workerSrc URL can stall after
// construction (the ready/test handshake has no timeout) and a workerPort is
// trusted blindly (no handshake at all) — and both failure modes look like
// "Loading…" forever. Main-thread parsing is exactly how pdf.js runs under
// Node; this module lives in the PDF tab's lazy chunk, so the cost is paid
// only when the tab opens.
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFHexString,
  PDFNull,
  type PDFRef,
  type PDFDict,
} from "pdf-lib";

(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TocEntry {
  id: string;
  title: string;
  startPage: number;
  endPage: number;
  level: number;
  chapterNum: number;
  children: TocEntry[];
}

/** A row of the flat structure editor (nesting is the `level` column). */
export interface FlatEntry {
  id: string;
  title: string;
  startPage: number;
  level: number;
}

/** The shape pdf.js getOutline() returns (just the fields we read). */
export interface OutlineItem {
  title: string;
  dest: string | unknown[] | null;
  items: OutlineItem[];
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Parse PDF bytes with pdf.js. The caller owns the proxy and must destroy()
 * it when done — each live proxy holds the full document in memory. Bounded:
 * a load that never settles (worker failed to boot) becomes a visible error
 * instead of a forever-"Loading…" state. */
export function openPdf(bytes: ArrayBuffer): Promise<PDFDocumentProxy> {
  // wasmUrl: pdf.js v6 decodes JBig2 (scanned-PDF images), JPEG2000, and runs
  // color management / quickjs via separate WASM modules. Without wasmUrl the
  // decoders never load → "Jbig2Error: JBig2 failed to initialize" + blank
  // images on scanned PDFs. The files are copied to /pdfjs-wasm/ by the
  // pdfjsWasmCopy Vite plugin (dev + build). BASE_URL handles sub-path hosting.
  //
  // FULLY-QUALIFIED, not root-relative: pdf.js sometimes loads the *_nowasm_
  // fallback decoders via dynamic import(), and Vite's dev pipeline refuses
  // to import /public paths ("can only be referenced via HTML tags" overlay —
  // field, scanned kit manual with JPEG2000 images). An absolute URL is
  // external to Vite's import analysis, so both fetch() and import() work in
  // dev and build alike.
  const wasmUrl = new URL(`${import.meta.env.BASE_URL}pdfjs-wasm/`, window.location.href).href;
  // verbosity 0 = errors only: the deliberate fake worker and malformed-number
  // warnings in some PDFs otherwise flood the bug reporter's client log.
  const task = getDocument({ data: new Uint8Array(bytes), wasmUrl, verbosity: 0 });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void task.destroy();
      reject(new Error("pdf.js timed out opening the file — it may be enormous or corrupt"));
    }, 20_000);
    task.promise.then(
      (doc) => {
        clearTimeout(timer);
        resolve(doc);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// ToC building
// ---------------------------------------------------------------------------

export async function buildTocTree(
  pdfDoc: PDFDocumentProxy,
  items: OutlineItem[],
  counter: { value: number },
  level = 0,
): Promise<TocEntry[]> {
  const result: TocEntry[] = [];

  for (const item of items) {
    let startPage = 1;

    if (item.dest) {
      try {
        let dest: unknown = item.dest;
        if (typeof dest === "string") {
          dest = await pdfDoc.getDestination(dest);
        }
        if (Array.isArray(dest) && dest[0] != null) {
          const pageIndex = await pdfDoc.getPageIndex(dest[0] as { num: number; gen: number });
          startPage = pageIndex + 1;
        }
      } catch {
        // leave startPage = 1
      }
    }

    counter.value += 1;
    const chapterNum = counter.value;

    const children =
      Array.isArray(item.items) && item.items.length > 0
        ? await buildTocTree(pdfDoc, item.items, counter, level + 1)
        : [];

    result.push({
      id: `toc-${chapterNum}`,
      title: item.title || "Untitled",
      startPage,
      endPage: 0, // second pass
      level,
      chapterNum,
      children,
    });
  }

  return result;
}

/** Assign endPage values recursively. parentEnd is the last page available
 *  to all entries at this level (either total pages at root, or the parent's
 *  own end page for nested levels). */
export function assignEndPages(entries: TocEntry[], parentEnd: number): void {
  for (let i = 0; i < entries.length; i++) {
    const myEnd =
      i < entries.length - 1 ? entries[i + 1].startPage - 1 : parentEnd;
    entries[i].endPage = myEnd;
    if (entries[i].children.length > 0) {
      assignEndPages(entries[i].children, myEnd);
    }
  }
}

// ---------------------------------------------------------------------------
// Structure editor: flat <-> nested
// ---------------------------------------------------------------------------

export function flattenToc(entries: TocEntry[], level = 0, out: FlatEntry[] = []): FlatEntry[] {
  for (const e of entries) {
    out.push({ id: e.id, title: e.title, startPage: e.startPage, level });
    if (e.children.length > 0) flattenToc(e.children, level + 1, out);
  }
  return out;
}

export function nestFlat(flat: FlatEntry[]): TocEntry[] {
  // Clamp levels so the first entry is at 0 and no jump is deeper than +1
  let maxAllowed = 0;
  const normalized = flat.map((e) => {
    const lvl = Math.max(0, Math.min(e.level, maxAllowed));
    maxAllowed = lvl + 1;
    return { ...e, level: lvl };
  });

  const root: TocEntry[] = [];
  const childArrays: TocEntry[][] = [root];
  let counter = 0;

  for (const e of normalized) {
    counter += 1;
    const entry: TocEntry = {
      id: e.id,
      title: e.title.trim() || "Untitled",
      startPage: e.startPage,
      endPage: 0,
      level: e.level,
      chapterNum: counter,
      children: [],
    };
    childArrays[e.level].push(entry);
    childArrays.length = e.level + 1;
    childArrays.push(entry.children);
  }

  return root;
}

export function newFlatId(): string {
  return `flat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// PDF outline writer (pdf-lib low-level API)
// ---------------------------------------------------------------------------

interface OutlineLevelResult {
  first: PDFRef;
  last: PDFRef;
  count: number;
}

function buildOutlineLevel(
  doc: PDFDocument,
  entries: TocEntry[],
  parentRef: PDFRef,
): OutlineLevelResult | null {
  if (entries.length === 0) return null;
  const ctx = doc.context;
  const totalPages = doc.getPageCount();

  const refs = entries.map(() => ctx.nextRef());
  let descendantCount = 0;

  entries.forEach((entry, i) => {
    const ref = refs[i];
    const prev = i > 0 ? refs[i - 1] : null;
    const next = i < entries.length - 1 ? refs[i + 1] : null;

    const pageIdx = Math.max(0, Math.min(entry.startPage - 1, totalPages - 1));
    const pageRef = doc.getPage(pageIdx).ref;

    // [pageRef /XYZ null null null] = "go to top of page, keep current zoom"
    const dest = ctx.obj([pageRef, PDFName.of("XYZ"), PDFNull, PDFNull, PDFNull]);

    const item = ctx.obj({
      Title: PDFHexString.fromText(entry.title || "Untitled"),
      Parent: parentRef,
      Dest: dest,
    }) as PDFDict;
    if (prev) item.set(PDFName.of("Prev"), prev);
    if (next) item.set(PDFName.of("Next"), next);

    if (entry.children.length > 0) {
      const child = buildOutlineLevel(doc, entry.children, ref);
      if (child) {
        item.set(PDFName.of("First"), child.first);
        item.set(PDFName.of("Last"), child.last);
        item.set(PDFName.of("Count"), PDFNumber.of(child.count));
        descendantCount += child.count;
      }
    }

    ctx.assign(ref, item);
    descendantCount += 1;
  });

  return { first: refs[0], last: refs[refs.length - 1], count: descendantCount };
}

/** Embed `entries` as the document outline (bookmarks) in the PDF catalog. */
export function attachOutline(doc: PDFDocument, entries: TocEntry[]): void {
  if (entries.length === 0) return;
  const ctx = doc.context;
  const rootRef = ctx.nextRef();

  const built = buildOutlineLevel(doc, entries, rootRef);
  if (!built) return;

  const rootDict = ctx.obj({
    Type: PDFName.of("Outlines"),
    First: built.first,
    Last: built.last,
    Count: PDFNumber.of(built.count),
  });
  ctx.assign(rootRef, rootDict);

  doc.catalog.set(PDFName.of("Outlines"), rootRef);
}

// ---------------------------------------------------------------------------
// Filename template
// ---------------------------------------------------------------------------

export function sanitize(str: string): string {
  return str.replace(/[/\\?%*:|"<>]/g, "_").replace(/\s+/g, " ").trim();
}

export function buildFilename(
  template: string,
  chapterNum: number,
  bookName: string,
  title: string,
  start: number,
  end: number,
): string {
  const safeTitle = sanitize(title);
  return (
    template
      .replace(/{chapter-name}/gi, safeTitle)
      .replace(/{title}/gi, safeTitle)
      .replace(/{chapter}/gi, String(chapterNum).padStart(2, "0"))
      .replace(/{book}/gi, sanitize(bookName))
      .replace(/{start}/gi, String(start))
      .replace(/{end}/gi, String(end)) + ".pdf"
  );
}

/**
 * Extract text from a PDF page via pdf.js `getTextContent`. Returns "" for a
 * page with no text layer (a scanned PDF — the caller falls back to ragrat OCR).
 * Concatenates text items with spaces, preserving reading order. Page numbers
 * are 1-based.
 */
export async function extractPageText(doc: PDFDocumentProxy, pageNum: number): Promise<string> {
  try {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    page.cleanup();
    // Join items with spaces; pdf.js gives text runs in reading order.
    return content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return "";
  }
}

/**
 * Extract text from a range of pages (1-based, inclusive). Returns the
 * concatenated text with a page marker between pages so the agent can tell
 * which page each section of text came from.
 */
export async function extractPageRangeText(
  doc: PDFDocumentProxy,
  startPage: number,
  endPage: number,
): Promise<string> {
  const parts: string[] = [];
  for (let p = startPage; p <= endPage; p++) {
    const text = await extractPageText(doc, p);
    if (text) parts.push(`--- Page ${p} ---\n${text}`);
  }
  return parts.join("\n\n");
}

/**
 * Printed page label ("xi", "3") → 1-based physical page, from the PDF's
 * /PageLabels metadata. This is the only DETERMINISTIC printed↔physical
 * mapping a PDF can carry — when present, a contents listing's printed page
 * numbers (including roman-numeral front matter) resolve exactly. Returns
 * null when the PDF declares no labels (then the file offers no mapping and
 * the caller must fall back: printed == physical plus a user-applied shift).
 */
export async function getPageLabelMap(doc: PDFDocumentProxy): Promise<Map<string, number> | null> {
  const labels = await doc.getPageLabels();
  if (!labels || labels.length === 0) return null;
  const map = new Map<string, number>();
  labels.forEach((label, i) => {
    const key = String(label ?? "").trim().toLowerCase();
    if (key && !map.has(key)) map.set(key, i + 1);
  });
  return map.size > 0 ? map : null;
}

/**
 * Roman numeral → integer ("xi" → 11), case-insensitive. Null when the string
 * isn't a well-formed roman numeral. Deterministic front-matter page parsing
 * belongs in code, never in a model prompt: a book's "xi" is a REAL page
 * number, just in a different numbering system with its own physical offset.
 */
export function romanToInt(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (!t || !/^[mdclxvi]+$/.test(t)) return null;
  const vals: Record<string, number> = { m: 1000, d: 500, c: 100, l: 50, x: 10, v: 5, i: 1 };
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const v = vals[t[i]];
    const next = i + 1 < t.length ? vals[t[i + 1]] : 0;
    total += v < next ? -v : v;
  }
  // Round-trip check rejects malformed sequences ("iiii", "vx", "im").
  return intToRoman(total) === t ? total : null;
}

function intToRoman(n: number): string {
  if (n <= 0 || n >= 4000) return "";
  const table: Array<[number, string]> = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"],
    [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  for (const [v, sym] of table) {
    while (n >= v) { out += sym; n -= v; }
  }
  return out;
}

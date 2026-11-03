import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PDFDocument } from "pdf-lib";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  listProjectFiles,
  listProjectAttachments,
  fetchProjectFileBytes,
  fetchAttachmentBytes,
  uploadProjectFile,
  dispatchAgentTask,
  getAgentTaskStatus,
  ocrPdf,
  type ProjectFile,
} from "../lib/daemon";

import {
  assignEndPages,
  attachOutline,
  buildFilename,
  buildTocTree,
  extractPageRangeText,
  flattenToc,
  getPageLabelMap,
  nestFlat,
  newFlatId,
  openPdf,
  romanToInt,
  sanitize,
  type FlatEntry,
  type TocEntry,
} from "./pdf/pdfUtils";
import ScrollArea from "../components/ScrollArea";

const isPdfFile = (name: string, mime?: string | null) =>
  name.toLowerCase().endsWith(".pdf") || mime === "application/pdf";

/** Bytes for either kind of shelf entry. Project files and task attachments
 * are separate tables with colliding rowid sequences, so attachment-sourced
 * docs ride under NEGATIVE ids — the sign picks the byte source. */
const loadDocBytes = (docId: number): Promise<ArrayBuffer> =>
  docId >= 0 ? fetchProjectFileBytes(docId) : fetchAttachmentBytes(-docId);

/** A project PDF once it has been parsed: page count + table of contents.
 * Metadata only — the live pdf.js proxy is held separately (one at a time). */
interface Book {
  fileId: number;
  name: string;
  pageCount: number;
  toc: TocEntry[];
}

interface MergeItem {
  fileId: number;
  name: string;
  pageCount: number;
}

type View = "docs" | "toc" | "merge";

const TABS: { id: View; label: string }[] = [
  { id: "docs", label: "Documents" },
  { id: "toc", label: "Contents" },
  { id: "merge", label: "Merge" },
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SAVED_NOTE = "it's in the Files tab and joins the project knowledge base";

/**
 * PDF Studio — chapter extraction, page ranges, merging and outline editing
 * over this project's host-stored files. Inputs are the project's PDFs;
 * every output is uploaded straight back as a new project file.
 */
export default function PdfTab({ projectId }: { projectId: number }) {
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [books, setBooks] = useState<Record<number, Book>>({});
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null);
  const [selectedChapter, setSelectedChapter] = useState<TocEntry | null>(null);
  const [view, setView] = useState<View>("docs");
  const [template, setTemplate] = useState("{chapter}_{book}_{chapter-name}_{start}_{end}");
  const [status, setStatus] = useState<{ msg: string; ok: boolean } | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Page-range extraction
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(1);

  // Merge state
  const [mergeItems, setMergeItems] = useState<MergeItem[]>([]);
  const [mergeOutputName, setMergeOutputName] = useState("merged");

  // Structure editor state
  const [editingStructure, setEditingStructure] = useState(false);
  const [draftEntries, setDraftEntries] = useState<FlatEntry[]>([]);
  // The page the user is looking at — follows their scroll, and the whole
  // point is building the ToC with the document in front of you.
  const [previewPage, setPreviewPage] = useState(1);
  // Scroll commands for the viewer (chapter clicks, ◎ rows, the page input).
  // The nonce distinguishes "scroll there" from previewPage merely following
  // the user's own scrolling.
  const [jump, setJump] = useState({ page: 1, nonce: 0 });
  const [structureFilename, setStructureFilename] = useState("");

  // Only the selected book keeps a live pdf.js doc (full PDFs sit in memory);
  // everything else is reduced to Book metadata and re-fetched on demand.
  const proxyRef = useRef<{ fileId: number; doc: PDFDocumentProxy } | null>(null);

  const selectedBook = selectedFileId != null ? books[selectedFileId] ?? null : null;

  // ----- Project file list: project files + shared task-attachment PDFs.
  // Allocating a Files-page upload to a task MOVES its row from project_files
  // to file_attachments, so listing only one table made PDFs vanish from this
  // shelf the moment they were allocated.
  const refreshFiles = useCallback(async () => {
    try {
      const [pf, atts] = await Promise.all([
        listProjectFiles(projectId),
        listProjectAttachments(projectId).catch(() => []), // older host — project files only
      ]);
      const own = pf.filter((f) => isPdfFile(f.file_name, f.file_type));
      const fromTasks = atts
        .filter((a) => a.is_shared && isPdfFile(a.file_name, a.file_type))
        .map(
          (a): ProjectFile => ({
            id: -a.id, // negative = attachment-sourced (see loadDocBytes)
            project_id: projectId,
            file_name: a.file_name,
            file_type: a.file_type,
            rel_path: a.task_title || null,
            size_bytes: a.storage_size,
            created_at: a.created_at,
            ai_included: a.ai_included,
          }),
        );
      setFiles([...own, ...fromTasks]);
      setFilesError(null);
    } catch (e) {
      setFilesError(e instanceof Error ? e.message : String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void refreshFiles();
  }, [refreshFiles]);

  const unmountedRef = useRef(false);
  useEffect(() => {
    // Reset on (re)mount — StrictMode's dev-only mount→unmount→remount would
    // otherwise leave the flag stuck true and every openBook bailing silently
    // right after a successful parse ("Loading…" forever).
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      // pdfjs v6: destroy lives on the loading task
      void proxyRef.current?.doc.loadingTask.destroy();
      proxyRef.current = null;
    };
  }, []);

  // ----- Open a project PDF as the working book -----
  const openBook = useCallback(
    async (file: ProjectFile) => {
      if (proxyRef.current?.fileId === file.id) {
        setSelectedFileId(file.id);
        setView("toc");
        return;
      }
      setIsLoading(true);
      setStatus({ msg: `Loading ${file.file_name}…`, ok: true });
      try {
        const bytes = await loadDocBytes(file.id);
        const doc = await openPdf(bytes);
        if (unmountedRef.current) {
          // Unmounted mid-load: the cleanup already ran, so destroy the fresh
          // proxy here or it (and the worker) would leak.
          void doc.loadingTask.destroy();
          return;
        }
        void proxyRef.current?.doc.loadingTask.destroy();
        proxyRef.current = { fileId: file.id, doc };

        // Reuse cached metadata so a structure saved in-session survives a
        // reopen; otherwise parse the outline into a ToC tree.
        let book = books[file.id];
        if (!book || book.pageCount !== doc.numPages) {
          const outline = await doc.getOutline();
          const toc = outline ? await buildTocTree(doc, outline, { value: 0 }) : [];
          assignEndPages(toc, doc.numPages);
          book = {
            fileId: file.id,
            name: file.file_name.replace(/\.pdf$/i, ""),
            pageCount: doc.numPages,
            toc,
          };
          setBooks((prev) => ({ ...prev, [file.id]: book }));
        }
        setSelectedFileId(file.id);
        setSelectedChapter(null);
        setPreviewPage(1);
        setRangeStart(1);
        setRangeEnd(book.pageCount);
        setView("toc");
        setStatus(null);
      } catch (err) {
        setStatus({ msg: `Error loading ${file.file_name}: ${err}`, ok: false });
      } finally {
        setIsLoading(false);
      }
    },
    [books],
  );

  // ----- Upload a finished pdf-lib document back to the project -----
  const uploadOutput = useCallback(
    async (doc: PDFDocument, filename: string): Promise<string> => {
      const bytes = await doc.save();
      const uploaded = await uploadProjectFile(
        projectId,
        new File([new Uint8Array(bytes)], filename, { type: "application/pdf" }),
      );
      void refreshFiles();
      return uploaded.file_name;
    },
    [projectId, refreshFiles],
  );

  // ----- Extraction (chapters and custom ranges share this) -----
  const extractPages = useCallback(
    async (book: Book, start: number, end: number, filename: string) => {
      setIsLoading(true);
      setStatus({ msg: `Extracting pages ${start}–${end}…`, ok: true });
      try {
        const srcDoc = await PDFDocument.load(await loadDocBytes(book.fileId));
        const newDoc = await PDFDocument.create();
        // pdf-lib uses 0-based page indices
        const indices = Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i);
        const copied = await newDoc.copyPages(srcDoc, indices);
        for (const page of copied) newDoc.addPage(page);
        const saved = await uploadOutput(newDoc, filename);
        setStatus({
          msg: `Saved ${saved} (${indices.length} page${indices.length !== 1 ? "s" : ""}) — ${SAVED_NOTE}.`,
          ok: true,
        });
      } catch (err) {
        setStatus({ msg: `Error: ${err}`, ok: false });
      } finally {
        setIsLoading(false);
      }
    },
    [uploadOutput],
  );

  const extractChapter = useCallback(() => {
    if (!selectedBook || !selectedChapter) return;
    const start = Math.max(1, Math.min(selectedChapter.startPage, selectedBook.pageCount));
    const end = Math.max(start, Math.min(selectedChapter.endPage, selectedBook.pageCount));
    const filename = buildFilename(
      template,
      selectedChapter.chapterNum,
      selectedBook.name,
      selectedChapter.title,
      selectedChapter.startPage,
      selectedChapter.endPage,
    );
    void extractPages(selectedBook, start, end, filename);
  }, [selectedBook, selectedChapter, template, extractPages]);

  const extractRange = useCallback(() => {
    if (!selectedBook) return;
    const start = Math.max(1, Math.min(rangeStart, selectedBook.pageCount));
    const end = Math.max(start, Math.min(rangeEnd, selectedBook.pageCount));
    const filename = `${sanitize(selectedBook.name)}_p${start}-${end}.pdf`;
    void extractPages(selectedBook, start, end, filename);
  }, [selectedBook, rangeStart, rangeEnd, extractPages]);

  // ----- Structure editor -----
  const startEditingStructure = useCallback(() => {
    if (!selectedBook) return;
    const flat = flattenToc(selectedBook.toc);
    setDraftEntries(
      flat.length > 0 ? flat : [{ id: newFlatId(), title: "", startPage: 1, level: 0 }],
    );
    setStructureFilename(`${selectedBook.name} - structured`);
    setSelectedChapter(null);
    setPreviewPage(1);
    setEditingStructure(true);
  }, [selectedBook]);

  /** Scroll the page browser to a page (clamped to the open document). */
  const jumpPreview = useCallback(
    (page: number) => {
      const max = selectedBook?.pageCount ?? 1;
      const p = Math.max(1, Math.min(max, Math.floor(page) || 1));
      setPreviewPage(p);
      setJump((j) => ({ page: p, nonce: j.nonce + 1 }));
    },
    [selectedBook],
  );

  /** Stamp the previewed page onto a draft row — find the chapter start by
   * flipping pages, then claim it. */
  const setRowFromPreview = useCallback(
    (id: string) => {
      setDraftEntries((prev) => prev.map((e) => (e.id === id ? { ...e, startPage: previewPage } : e)));
    },
    [previewPage],
  );

  /** Claim-and-cascade: set this row's start to the previewed page AND shift
   * every row BELOW it by the same delta, leaving rows above untouched.
   * This is the anchor tool for printed↔physical offsets: front matter
   * (roman pages) and body (arabic pages) carry DIFFERENT offsets, so a flat
   * shift-all corrupts one while fixing the other. Anchoring top-down (front
   * matter first, then Chapter 1) converges in one click per numbering
   * system. */
  const setRowFromPreviewCascade = useCallback(
    (id: string) => {
      const pc = selectedBook?.pageCount ?? Number.MAX_SAFE_INTEGER;
      setDraftEntries((prev) => {
        const idx = prev.findIndex((e) => e.id === id);
        if (idx < 0) return prev;
        const delta = previewPage - prev[idx].startPage;
        if (delta === 0) return prev;
        return prev.map((e, i) =>
          i < idx ? e : { ...e, startPage: Math.max(1, Math.min(pc, e.startPage + delta)) },
        );
      });
    },
    [previewPage, selectedBook],
  );

  /** New draft row starting at the previewed page (appended at top level). */
  const addDraftAtPreview = useCallback(() => {
    setDraftEntries((prev) => {
      const level = prev.length > 0 ? prev[prev.length - 1].level : 0;
      return [...prev, { id: newFlatId(), title: "", startPage: previewPage, level }];
    });
  }, [previewPage]);

  const cancelEditingStructure = useCallback(() => {
    setEditingStructure(false);
    setDraftEntries([]);
    setAiNotice(null);
  }, []);

  /** Auto-build the structure via an agent task. Extracts text from the first
   * ~10 pages (where the Contents page usually lives), dispatches a
   * `structure_toc` agent task through the protocol layer (free Ollama by
   * default, paid pi if the protocol names it), parses the JSON response, and
   * populates draftEntries as a PROPOSAL — nothing is saved until the user
   * approves via "Save with structure".
   *
   * The agent returns physical page numbers; we clamp them to [1, pageCount]
   * deterministically (untrusted output never reaches a draft entry). */
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiStage, setAiStage] = useState<string | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const autoBuildStructure = useCallback(async () => {
    if (!selectedBook || !proxyRef.current) return;
    setAiBusy(true);
    setAiError(null);
    setAiNotice(null);
    setAiStage("Reading pages…");
    try {
      const doc = proxyRef.current.doc;
      const maxPages = Math.min(10, doc.numPages);

      // Step 1: extract text via pdf.js (fast — uses the PDF's text layer).
      let pageText = await extractPageRangeText(doc, 1, maxPages);

      // Step 2: if the PDF has no text layer (scanned), fall back to ragrat OCR.
      // Slice the first `maxPages` pages with pdf-lib and send to ragrat's
      // Docling+rapidocr pipeline via the /ai/ocr endpoint.
      if (!pageText.trim()) {
        setAiError(null); // clear any previous error
        setAiStage("OCR — scanned pages, this can take a few minutes…");
        try {
          const pdfBytes = await loadDocBytes(selectedBook.fileId);
          const srcDoc = await PDFDocument.load(pdfBytes);
          const sliceDoc = await PDFDocument.create();
          const pageIndices = Array.from({ length: Math.min(maxPages, srcDoc.getPageCount()) }, (_, i) => i);
          const copied = await sliceDoc.copyPages(srcDoc, pageIndices);
          for (const page of copied) sliceDoc.addPage(page);
          const sliceBytes = await sliceDoc.save();
          pageText = await ocrPdf(new Uint8Array(sliceBytes), `${selectedBook.name}.pdf`);
        } catch (ocrErr) {
          // OCR unavailable (ragrat not running, Docling not installed, or
          // the ragrat /ocr endpoint isn't on this build). Surface the error
          // so the user knows WHY it failed — don't silently fall through to
          // the agent with empty text (the agent would just say 'no text').
          const ocrMsg = ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
          throw new Error(
            `This appears to be a scanned PDF (no text layer). OCR fallback failed: ${ocrMsg}. ` +
            `Reading a scanned PDF needs the optional knowledge engine (ragrat) on the host, set up in Settings → AI Engines.`
          );
        }
      }

      const prompt = `Extract the table of contents (ToC) from this PDF's text.

The text below is from the first ${maxPages} pages of a ${doc.numPages}-page PDF. Find the Contents page and extract every chapter/section entry.

For each entry:
- title: the COMPLETE title EXACTLY as printed, verbatim — including any chapter/section number prefix ("Chapter 1", "1.2", "2.4") AND the full text after it. Example: the contents line "1.2 The origins of sea trade, 3000 BC to AD 1450 ... 7" has title "1.2 The origins of sea trade, 3000 BC to AD 1450". NEVER abbreviate, shorten, or drop the descriptive part of a title.
- printedPage: the page number EXACTLY as printed next to the entry in the contents listing (a string — arabic like "45" or roman like "xi"). Copy it VERBATIM. Do NOT convert it, do NOT add offsets, do NOT guess PDF page indexes.
- level: 0 for top-level, 1 for sub-sections, 2 for sub-sub (integer)

IMPORTANT: Respond with ONLY a JSON array. No prose, no markdown, no code fences. Start with [ and end with ].

Example: [{"title":"Preface to the Third Edition","printedPage":"xi","level":0},{"title":"Chapter 1 Sea Transport and the Global Economy","printedPage":"3","level":0},{"title":"1.1 Introduction","printedPage":"3","level":1}]

If no table of contents is found, respond with: []

--- PDF text (pages 1-${maxPages}) ---
${pageText || "(No text layer found — this may be a scanned PDF)"}`;

      // Dispatch ASYNC — the server runs pi/Ollama in the background and returns
      // a job_id immediately. We poll until done. This avoids HTTP connection
      // timeouts on long model generations (pi takes 30-60s+; Tailscale drops
      // idle connections well before the model responds).
      setAiStage("Asking the agent…");
      const { job_id } = await dispatchAgentTask({
        task_class: "structure_toc",
        prompt,
      });

      // Poll every 2 seconds until the task completes (or 5 minutes elapse).
      let resultText = "";
      const deadline = Date.now() + 300_000;
      while (Date.now() < deadline) {
        const status = await getAgentTaskStatus(job_id);
        if (status.status === "done") {
          if (status.error) throw new Error(status.error);
          resultText = status.result?.text ?? "";
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!resultText) throw new Error("The agent task timed out after 5 minutes.");

      // Parse + clamp the untrusted JSON response. Models often wrap JSON in
      // prose or markdown fences — extract the JSON array robustly.
      let entries: Array<{ title?: unknown; printedPage?: unknown; startPage?: unknown; level?: unknown }>;
      try {
        let text = resultText.trim();
        // Strip markdown code fences.
        text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
        // If there's prose around the JSON, find the first '[' and last ']'.
        const firstBracket = text.indexOf('[');
        const lastBracket = text.lastIndexOf(']');
        if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
          text = text.slice(firstBracket, lastBracket + 1);
        }
        entries = JSON.parse(text);
      } catch {
        // Show the raw response (truncated) so the user can see what went wrong.
        const preview = resultText.length > 300 ? resultText.slice(0, 300) + '…' : resultText;
        throw new Error(
          `The agent did not return valid JSON. Raw response:\n${preview}\n\nTry again, or build the structure manually.`
        );
      }

      if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error("No table of contents entries were found. Try building the structure manually.");
      }

      // Resolve printed → physical pages. The model returns the contents
      // listing's page numbers VERBATIM (it cannot know the front-matter
      // offset — that information isn't in the ToC text). The mapping is done
      // deterministically here:
      //   1. /PageLabels metadata, when the PDF carries it — exact, including
      //      roman-numeral front matter.
      //   2. Roman numerals parse deterministically ("xi" → 11) — a real page
      //      number in a second numbering system with its own offset.
      //   3. Without labels, arabic printed pages restart AFTER the roman
      //      front matter: physical ≈ printed + (highest roman page). An
      //      approximation — the ⇣ anchor refines it in one click.
      const pageCount = selectedBook.pageCount;
      const labelMap = await getPageLabelMap(doc).catch(() => null);
      const parsed = entries
        .filter((e) => e && typeof e === "object")
        .map((e) => {
          const printed = String(e.printedPage ?? e.startPage ?? "").trim().toLowerCase();
          let page: number | null = null;
          let kind: "label" | "arabic" | "roman" | "unknown" = "unknown";
          if (printed && labelMap?.has(printed)) {
            page = labelMap.get(printed)!;
            kind = "label";
          } else {
            const n = parseInt(printed, 10);
            if (Number.isFinite(n) && n > 0) {
              page = n;
              kind = "arabic";
            } else {
              const r = printed ? romanToInt(printed) : null;
              if (r) {
                page = r;
                kind = "roman";
              }
            }
          }
          return { e, page, kind };
        });
      const romans = parsed.filter((p) => p.kind === "roman").length;
      const unresolved = parsed.filter((p) => p.kind === "unknown").length;
      const maxRoman = parsed.reduce((m, p) => (p.kind === "roman" && p.page! > m ? p.page! : m), 0);
      const arabicOffset = labelMap ? 0 : maxRoman;
      const clamped: FlatEntry[] = parsed.map(({ e, page, kind }) => ({
        id: newFlatId(),
        title: String(e.title ?? "Untitled").trim() || "Untitled",
        startPage: Math.max(1, Math.min(pageCount, (page ?? 1) + (kind === "arabic" ? arabicOffset : 0))),
        level: Math.max(0, Math.min(5, Math.floor(Number(e.level) || 0))),
      }));

      if (clamped.length === 0) {
        throw new Error("No valid entries after parsing. Try building the structure manually.");
      }

      if (labelMap) {
        if (unresolved > 0) {
          setAiNotice(`Pages mapped via the PDF's page labels; ${unresolved} entr${unresolved === 1 ? "y" : "ies"} could not be resolved and were parked at page 1.`);
        }
      } else {
        setAiNotice(
          "This PDF carries no page-label metadata, so pages are estimated from the printed contents" +
          (romans > 0 ? ` (roman front matter parsed: xi → 11; arabic pages offset by the highest roman page, +${maxRoman})` : "") +
          " — expect a small remaining offset. Fix each numbering system with ONE anchor: preview a section's true first page, then ⇣ on its row — that row is claimed and every row below shifts by the same amount. Anchor top-down: front matter first, then Chapter 1.",
        );
      }

      // Populate as a PROPOSAL — the user reviews in StructureEditor before saving.
      setDraftEntries(clamped);
      setStructureFilename(`${selectedBook.name} - structured`);
      setSelectedChapter(null);
      setPreviewPage(clamped[0]?.startPage ?? 1);
      setJump((j) => ({ page: clamped[0]?.startPage ?? 1, nonce: j.nonce + 1 }));
      setEditingStructure(true);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiBusy(false);
      setAiStage(null);
    }
  }, [selectedBook]);

  const updateDraftEntry = useCallback((id: string, patch: Partial<FlatEntry>) => {
    setDraftEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  /** Shift every draft entry's page by a delta (clamped to [1, pageCount]).
   * One interaction fixes the printed↔physical front-matter offset on PDFs
   * without page-label metadata (typical for scanned books). */
  const shiftDraftPages = useCallback((delta: number) => {
    if (!selectedBook || !delta) return;
    const pc = selectedBook.pageCount;
    setDraftEntries((prev) => prev.map((e) => ({ ...e, startPage: Math.max(1, Math.min(pc, e.startPage + delta)) })));
  }, [selectedBook]);

  /** New draft row inserted at the very top (level of the current first row). */
  const addDraftAtTop = useCallback(() => {
    setDraftEntries((prev) => [
      { id: newFlatId(), title: "", startPage: 1, level: prev[0]?.level ?? 0 },
      ...prev,
    ]);
  }, []);

  const addDraftAfter = useCallback((id: string | null) => {
    setDraftEntries((prev) => {
      if (id == null) {
        const level = prev.length > 0 ? prev[prev.length - 1].level : 0;
        return [...prev, { id: newFlatId(), title: "", startPage: 1, level }];
      }
      const idx = prev.findIndex((e) => e.id === id);
      if (idx < 0) return prev;
      const level = prev[idx].level;
      const arr = [...prev];
      arr.splice(idx + 1, 0, { id: newFlatId(), title: "", startPage: prev[idx].startPage, level });
      return arr;
    });
  }, []);

  const deleteDraft = useCallback((id: string) => {
    setDraftEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const indentDraft = useCallback((id: string) => {
    setDraftEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === id);
      if (idx <= 0) return prev;
      const maxLevel = prev[idx - 1].level + 1;
      if (prev[idx].level >= maxLevel) return prev;
      return prev.map((e, i) => (i === idx ? { ...e, level: e.level + 1 } : e));
    });
  }, []);

  const outdentDraft = useCallback((id: string) => {
    setDraftEntries((prev) => {
      const idx = prev.findIndex((e) => e.id === id);
      if (idx < 0 || prev[idx].level === 0) return prev;
      return prev.map((e, i) => (i === idx ? { ...e, level: e.level - 1 } : e));
    });
  }, []);

  // Upload a copy of the book with the manually-built outline embedded.
  const saveWithStructure = useCallback(async () => {
    if (!selectedBook) return;
    if (draftEntries.length === 0) {
      setStatus({ msg: "Add at least one entry to the structure.", ok: false });
      return;
    }

    const nested = nestFlat(draftEntries);
    assignEndPages(nested, selectedBook.pageCount);

    const baseName = (structureFilename || `${selectedBook.name} - structured`).trim();
    const filename = `${sanitize(baseName)}.pdf`;

    setIsLoading(true);
    setStatus({ msg: "Writing structured PDF…", ok: true });

    try {
      const srcDoc = await PDFDocument.load(await loadDocBytes(selectedBook.fileId));
      const newDoc = await PDFDocument.create();
      const copied = await newDoc.copyPages(srcDoc, srcDoc.getPageIndices());
      for (const page of copied) newDoc.addPage(page);

      attachOutline(newDoc, nested);

      const saved = await uploadOutput(newDoc, filename);

      // Commit the new structure to the in-memory book so the user can
      // immediately extract chapters from it without re-loading.
      setBooks((prev) => ({
        ...prev,
        [selectedBook.fileId]: { ...selectedBook, toc: nested },
      }));
      setEditingStructure(false);
      setDraftEntries([]);
      setAiNotice(null);

      setStatus({
        msg: `Saved ${saved} (${draftEntries.length} entries) — ${SAVED_NOTE}.`,
        ok: true,
      });
    } catch (err) {
      setStatus({ msg: `Error: ${err}`, ok: false });
    } finally {
      setIsLoading(false);
    }
  }, [selectedBook, draftEntries, structureFilename, uploadOutput]);

  // Exit edit mode if the user switches views or books mid-edit
  useEffect(() => {
    if (editingStructure && (view !== "toc" || !selectedBook)) {
      setEditingStructure(false);
      setDraftEntries([]);
      setAiNotice(null);
    }
  }, [view, selectedBook, editingStructure]);

  // ----- Merge -----
  const addToMerge = useCallback(
    async (file: ProjectFile) => {
      if (mergeItems.some((m) => m.fileId === file.id)) return;
      const name = file.file_name.replace(/\.pdf$/i, "");
      const cached = books[file.id];
      if (cached) {
        setMergeItems((prev) => [...prev, { fileId: file.id, name, pageCount: cached.pageCount }]);
        return;
      }
      setIsLoading(true);
      try {
        // Open just long enough to read the page count, then free it.
        const doc = await openPdf(await loadDocBytes(file.id));
        const pageCount = doc.numPages;
        await doc.loadingTask.destroy();
        setMergeItems((prev) =>
          prev.some((m) => m.fileId === file.id)
            ? prev
            : [...prev, { fileId: file.id, name, pageCount }],
        );
      } catch (err) {
        setStatus({ msg: `Error loading ${file.file_name}: ${err}`, ok: false });
      } finally {
        setIsLoading(false);
      }
    },
    [mergeItems, books],
  );

  const moveMergeItem = useCallback((fileId: number, direction: -1 | 1) => {
    setMergeItems((prev) => {
      const idx = prev.findIndex((m) => m.fileId === fileId);
      if (idx < 0) return prev;
      const next = idx + direction;
      if (next < 0 || next >= prev.length) return prev;
      const arr = [...prev];
      [arr[idx], arr[next]] = [arr[next], arr[idx]];
      return arr;
    });
  }, []);

  const performMerge = useCallback(async () => {
    if (mergeItems.length < 2) {
      setStatus({ msg: "Add at least 2 PDFs to merge.", ok: false });
      return;
    }
    setIsLoading(true);
    setStatus({ msg: `Merging ${mergeItems.length} files…`, ok: true });
    try {
      const mergedDoc = await PDFDocument.create();
      for (const item of mergeItems) {
        const srcDoc = await PDFDocument.load(await loadDocBytes(item.fileId));
        const copied = await mergedDoc.copyPages(srcDoc, srcDoc.getPageIndices());
        for (const page of copied) mergedDoc.addPage(page);
      }
      const pageTotal = mergedDoc.getPageCount();
      const saved = await uploadOutput(mergedDoc, `${sanitize(mergeOutputName || "merged")}.pdf`);
      setStatus({ msg: `Saved ${saved} (${pageTotal} pages) — ${SAVED_NOTE}.`, ok: true });
    } catch (err) {
      setStatus({ msg: `Error: ${err}`, ok: false });
    } finally {
      setIsLoading(false);
    }
  }, [mergeItems, mergeOutputName, uploadOutput]);

  const mergeTotalPages = mergeItems.reduce((s, m) => s + m.pageCount, 0);
  const mergeRows = useMemo(() => {
    let cursor = 0;
    return mergeItems.map((m) => {
      const from = cursor + 1;
      const to = cursor + m.pageCount;
      cursor = to;
      return { ...m, from, to };
    });
  }, [mergeItems]);
  const availableForMerge = files.filter((f) => !mergeItems.some((m) => m.fileId === f.id));

  const previewFilename =
    selectedChapter && selectedBook
      ? buildFilename(
          template,
          selectedChapter.chapterNum,
          selectedBook.name,
          selectedChapter.title,
          selectedChapter.startPage,
          selectedChapter.endPage,
        )
      : null;

  const clampPage = (raw: string, pageCount: number): number => {
    const n = Number(raw);
    return Math.max(1, Math.min(pageCount, Number.isFinite(n) && n > 0 ? Math.floor(n) : 1));
  };

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden bg-base text-text">
      {/* Stacks on phone widths (the 320px sidebar would leave no room). */}
      <div className="flex-1 min-h-0 flex flex-col sm:flex-row">
        {/* LEFT: documents / contents / merge */}
        <div className="w-full max-h-[45%] sm:max-h-none sm:w-80 shrink-0 border-b sm:border-b-0 sm:border-r border-gilt-a flex flex-col min-h-0 bg-mantle">
          <div className="flex border-b border-gilt-b shrink-0">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setView(t.id)}
                className={`g-dtab flex-1 transition-colors ${view === t.id ? "!text-gold !shadow-[inset_0_-2px_0_var(--color-gold)]" : ""}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {view === "docs" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="g-cap">
                    Project PDFs
                  </span>
                  <button
                    onClick={() => void refreshFiles()}
                    className="g-btn g-btn-sm g-btn-ghost"
                  >
                    Refresh
                  </button>
                </div>
                {filesError && (
                  <div className="text-sm text-error bg-error/10 border border-error/30 rounded-lg px-3 py-2">
                    {filesError}
                  </div>
                )}
                {files.length === 0 && !filesError && (
                  <p className="text-sm text-subtext-0 italic">
                    No PDFs in this project yet — upload some in the Files tab.
                  </p>
                )}
                {files.map((f) => {
                  const book = books[f.id];
                  return (
                    <button
                      key={f.id}
                      onClick={() => void openBook(f)}
                      disabled={isLoading}
                      className={`g-row w-full text-left !block !py-2 disabled:opacity-50 ${selectedFileId === f.id ? "g-sel" : ""}`}
                    >
                      <div className="text-sm text-text truncate" title={f.file_name}>
                        {f.file_name}
                      </div>
                      <div className="text-xs text-subtext-0 truncate">
                        {formatSize(f.size_bytes)}
                        {book ? ` · ${book.pageCount} pages` : ""}
                        {f.id < 0 ? ` · 📌 ${f.rel_path || "task file"}` : ""}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {view === "toc" && (
              <>
                {!selectedBook ? (
                  <p className="text-sm text-subtext-0 italic">
                    Open a document to view its table of contents.
                  </p>
                ) : editingStructure ? (
                  <>
                    {aiNotice && (
                      <div className="px-3 py-2 mb-2 bg-gilt-b border border-gilt-a text-subtext-1 rounded-lg text-xs">{aiNotice}</div>
                    )}
                    <StructureEditor
                      entries={draftEntries}
                      pageCount={selectedBook.pageCount}
                      previewPage={previewPage}
                      onUpdate={updateDraftEntry}
                      onAdd={() => addDraftAfter(null)}
                      onAddTop={addDraftAtTop}
                      onAddAfter={addDraftAfter}
                      onAddAtPreview={addDraftAtPreview}
                      onDelete={deleteDraft}
                      onIndent={indentDraft}
                      onOutdent={outdentDraft}
                      onJump={jumpPreview}
                      onSetFromPreview={setRowFromPreview}
                      onSetFromPreviewCascade={setRowFromPreviewCascade}
                      onShiftAll={shiftDraftPages}
                    />
                  </>
                ) : (
                  <div className="space-y-3">
                    <div className="flex gap-2">
                      <button
                        onClick={startEditingStructure}
                        className="g-btn g-btn-sm g-btn-ghost flex-1"
                      >
                        {selectedBook.toc.length === 0 ? "+ Create structure" : "Edit structure"}
                      </button>
                      <button
                        onClick={autoBuildStructure}
                        disabled={aiBusy}
                        title="Use an AI agent to read the Contents page and build the structure automatically — review before saving"
                        className="g-btn g-btn-sm g-btn-pri"
                      >
                        {aiBusy ? (
                          <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 12a8 8 0 018-8" /></svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
                        )}
                        {aiBusy ? (aiStage ?? "Working…") : "Auto-build"}
                      </button>
                    </div>
                    {aiError && (
                      <div className="px-3 py-2 bg-error/10 border border-error/30 text-error rounded-lg text-xs">{aiError}</div>
                    )}
                    {selectedBook.toc.length === 0 ? (
                      <p className="text-sm text-subtext-0 italic">
                        No table of contents found in this PDF. Click "Create structure" to build
                        one.
                      </p>
                    ) : (
                      <div className="space-y-0.5">
                        {selectedBook.toc.map((entry) => (
                          <TocNode
                            key={entry.id}
                            entry={entry}
                            selectedId={selectedChapter?.id ?? null}
                            onSelect={(e) => {
                              setSelectedChapter(e);
                              jumpPreview(e.startPage);
                            }}
                          />
                        ))}
                      </div>
                    )}

                    {/* Custom page-range extraction */}
                    <div className="pt-3 border-t border-gilt-b space-y-2">
                      <div className="g-cap">
                        Extract page range
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={1}
                          max={selectedBook.pageCount}
                          value={rangeStart}
                          onChange={(e) =>
                            setRangeStart(clampPage(e.target.value, selectedBook.pageCount))
                          }
                          className="g-field g-field-sm !w-16 !px-2"
                        />
                        <span className="text-sm text-subtext-0">–</span>
                        <input
                          type="number"
                          min={1}
                          max={selectedBook.pageCount}
                          value={rangeEnd}
                          onChange={(e) =>
                            setRangeEnd(clampPage(e.target.value, selectedBook.pageCount))
                          }
                          className="g-field g-field-sm !w-16 !px-2"
                        />
                        <button
                          onClick={extractRange}
                          disabled={isLoading}
                          className="g-btn g-btn-sm g-btn-ghost flex-1"
                        >
                          Extract
                        </button>
                      </div>
                      <div className="text-xs text-subtext-0 truncate">
                        of {selectedBook.pageCount} pages →{" "}
                        {`${sanitize(selectedBook.name)}_p${rangeStart}-${Math.max(rangeStart, rangeEnd)}.pdf`}
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}

            {view === "merge" && (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <div className="g-cap">
                    Merge queue
                  </div>
                  {mergeItems.length === 0 && (
                    <p className="text-sm text-subtext-0 italic">
                      Pick PDFs below to combine into a single document. Order matters — reorder
                      with the arrows.
                    </p>
                  )}
                  {mergeItems.map((m, i) => (
                    <div
                      key={m.fileId}
                      className="g-frow !gap-2 !px-2 !min-h-[40px]"
                    >
                      <div className="flex flex-col shrink-0">
                        <button
                          onClick={() => moveMergeItem(m.fileId, -1)}
                          disabled={i === 0}
                          title="Move up"
                          className="px-1 text-[10px] leading-tight text-subtext-1 disabled:opacity-30"
                        >
                          ▲
                        </button>
                        <button
                          onClick={() => moveMergeItem(m.fileId, 1)}
                          disabled={i === mergeItems.length - 1}
                          title="Move down"
                          className="px-1 text-[10px] leading-tight text-subtext-1 disabled:opacity-30"
                        >
                          ▼
                        </button>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-text truncate" title={m.name}>
                          {m.name}
                        </div>
                        <div className="text-xs text-subtext-0">{m.pageCount} pages</div>
                      </div>
                      <button
                        onClick={() =>
                          setMergeItems((prev) => prev.filter((p) => p.fileId !== m.fileId))
                        }
                        title="Remove"
                        className="shrink-0 px-1 text-xs text-subtext-0 hover:text-error"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  {mergeItems.length > 0 && (
                    <div className="text-xs text-subtext-0">
                      {mergeItems.length} file{mergeItems.length !== 1 ? "s" : ""} ·{" "}
                      {mergeTotalPages} pages total
                    </div>
                  )}
                </div>

                <div className="space-y-1.5">
                  <div className="g-cap">
                    Project PDFs
                  </div>
                  {availableForMerge.length === 0 && (
                    <p className="text-sm text-subtext-0 italic">
                      {files.length === 0
                        ? "No PDFs in this project yet."
                        : "All project PDFs are queued."}
                    </p>
                  )}
                  {availableForMerge.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => void addToMerge(f)}
                      disabled={isLoading}
                      className="g-row w-full justify-between !gap-2 !px-2 !min-h-[36px] text-left disabled:opacity-50"
                    >
                      <span className="text-sm text-text truncate" title={f.file_name}>
                        {f.file_name}
                      </span>
                      <span className="text-xs text-gold shrink-0">+ Add</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: preview */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {editingStructure && selectedBook ? (
            <>
              <div className="g-bar shrink-0 px-4 py-2 min-h-[48px] justify-between !gap-3">
                <span className="text-sm font-medium truncate">
                  Editing structure — {selectedBook.name}
                </span>
                {/* Page browser controls: build the ToC with the document open. */}
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => jumpPreview(previewPage - 1)}
                    disabled={previewPage <= 1}
                    title="Previous page"
                    className="g-iconbtn !w-8 !h-8 bg-surface-0"
                  >
                    ‹
                  </button>
                  <input
                    type="number"
                    min={1}
                    max={selectedBook.pageCount}
                    value={previewPage}
                    onChange={(e) => jumpPreview(Number(e.target.value))}
                    className="g-field g-field-sm !w-16 !px-2 text-center"
                  />
                  <span className="text-xs text-subtext-0">/ {selectedBook.pageCount}</span>
                  <button
                    onClick={() => jumpPreview(previewPage + 1)}
                    disabled={previewPage >= selectedBook.pageCount}
                    title="Next page"
                    className="g-iconbtn !w-8 !h-8 bg-surface-0"
                  >
                    ›
                  </button>
                </div>
              </div>
              {proxyRef.current?.fileId === selectedFileId && (
                <ScrollViewer
                  key={selectedFileId}
                  doc={proxyRef.current.doc}
                  pageCount={selectedBook.pageCount}
                  jump={jump}
                  onVisiblePage={setPreviewPage}
                />
              )}
              <p className="shrink-0 px-4 py-1.5 text-center text-xs text-subtext-0 border-t border-gilt-b bg-mantle">
                Scroll to a chapter's first page, then ◎ on a row (or “+ Add at this page”) to
                claim p. {previewPage} as its start.
              </p>
            </>
          ) : view === "merge" ? (
            <>
              <div className="g-bar shrink-0 px-4 py-2 min-h-[48px] !items-baseline justify-between !gap-3">
                <span className="text-sm font-medium">
                  {mergeItems.length === 0
                    ? "Merge preview"
                    : `Merging ${mergeItems.length} file${mergeItems.length !== 1 ? "s" : ""}`}
                </span>
                {mergeItems.length > 0 && (
                  <span className="text-xs text-subtext-0 shrink-0">
                    {mergeTotalPages} pages total
                  </span>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-4">
                {mergeItems.length === 0 ? (
                  <p className="text-sm text-subtext-0 italic">
                    Add PDFs in the left panel to see the merge order here.
                  </p>
                ) : (
                  <div className="max-w-xl space-y-1">
                    {mergeRows.map((m) => (
                      <div key={m.fileId} className="flex items-center gap-2 text-sm">
                        <span className="text-xs text-subtext-0 shrink-0 font-mono">PDF</span>
                        <span className="flex-1 truncate text-text" title={m.name}>
                          {m.name}
                        </span>
                        <span className="text-xs text-subtext-0 shrink-0">
                          pp. {m.from}–{m.to}
                        </span>
                      </div>
                    ))}
                    <div className="mt-3 pt-2 border-t border-gilt-b flex items-center gap-2 text-xs text-subtext-0">
                      <span>Output</span>
                      <span className="flex-1 truncate text-text">
                        {sanitize(mergeOutputName || "merged")}.pdf
                      </span>
                      <span className="shrink-0">{mergeTotalPages} pages</span>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="g-bar shrink-0 px-4 py-2 min-h-[48px] justify-between !gap-3">
                {selectedChapter ? (
                  <span className="text-sm font-medium truncate">
                    {selectedChapter.title}{" "}
                    <span className="text-xs text-subtext-0">
                      pp. {selectedChapter.startPage}–{selectedChapter.endPage}
                    </span>
                  </span>
                ) : (
                  <span className="text-sm font-medium truncate text-subtext-1">
                    {selectedBook ? selectedBook.name : "No document open"}
                  </span>
                )}
                {/* The document is always browsable while open — structure or not. */}
                {selectedBook && (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => jumpPreview(previewPage - 1)}
                      disabled={previewPage <= 1}
                      title="Previous page"
                      className="g-iconbtn !w-8 !h-8 bg-surface-0"
                    >
                      ‹
                    </button>
                    <input
                      type="number"
                      min={1}
                      max={selectedBook.pageCount}
                      value={previewPage}
                      onChange={(e) => jumpPreview(Number(e.target.value))}
                      className="g-field g-field-sm !w-16 !px-2 text-center"
                    />
                    <span className="text-xs text-subtext-0">/ {selectedBook.pageCount}</span>
                    <button
                      onClick={() => jumpPreview(previewPage + 1)}
                      disabled={previewPage >= selectedBook.pageCount}
                      title="Next page"
                      className="g-iconbtn !w-8 !h-8 bg-surface-0"
                    >
                      ›
                    </button>
                  </div>
                )}
              </div>
              {selectedBook && proxyRef.current?.fileId === selectedFileId ? (
                <ScrollViewer
                  key={selectedFileId}
                  doc={proxyRef.current.doc}
                  pageCount={selectedBook.pageCount}
                  jump={jump}
                  onVisiblePage={setPreviewPage}
                />
              ) : (
                <div className="flex-1 overflow-auto p-4 bg-mantle">
                  <p className="text-sm text-subtext-0 italic">
                    Open a project PDF from the Documents list to get started.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* BOTTOM BAR */}
      <div className="shrink-0 border-t border-gilt-a bg-mantle px-4 py-2.5 flex items-center gap-3">
        {editingStructure && selectedBook ? (
          <>
            <span className="text-xs text-subtext-0 shrink-0">Filename</span>
            <input
              value={structureFilename}
              onChange={(e) => setStructureFilename(e.target.value)}
              placeholder={`${selectedBook.name} - structured`}
              spellCheck={false}
              className="g-field g-field-sm flex-1 min-w-0 !w-auto"
            />
            <span className="text-xs text-subtext-0 shrink-0">.pdf</span>
            <button
              onClick={cancelEditingStructure}
              className="g-btn g-btn-sm g-btn-ghost shrink-0"
            >
              Cancel
            </button>
            <button
              onClick={() => void saveWithStructure()}
              disabled={isLoading || draftEntries.length === 0}
              className="g-btn g-btn-sm g-btn-pri shrink-0"
            >
              {isLoading ? "Saving…" : "Save with structure"}
            </button>
          </>
        ) : view === "merge" ? (
          <>
            <span className="text-xs text-subtext-0 shrink-0">Filename</span>
            <input
              value={mergeOutputName}
              onChange={(e) => setMergeOutputName(e.target.value)}
              placeholder="merged"
              spellCheck={false}
              className="g-field g-field-sm flex-1 min-w-0 !w-auto"
            />
            <span className="text-xs text-subtext-0 shrink-0">.pdf</span>
            <button
              onClick={() => void performMerge()}
              disabled={mergeItems.length < 2 || isLoading}
              className="g-btn g-btn-sm g-btn-pri shrink-0"
            >
              {isLoading ? "Merging…" : "Merge PDFs"}
            </button>
          </>
        ) : (
          <>
            <span
              className="text-xs text-subtext-0 shrink-0"
              title="Tokens: {chapter} {book} {chapter-name} {start} {end}"
            >
              Template
            </span>
            <input
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder="{chapter}_{book}_{start}_{end}"
              spellCheck={false}
              className="g-field g-field-sm flex-1 min-w-0 !w-auto font-mono"
            />
            <span
              className="flex-1 min-w-0 truncate text-xs text-subtext-0 text-right"
              title={previewFilename ?? ""}
            >
              {previewFilename ?? "no chapter selected"}
            </span>
            <button
              onClick={extractChapter}
              disabled={!selectedChapter || isLoading}
              className="g-btn g-btn-sm g-btn-pri shrink-0"
            >
              {isLoading ? "Working…" : "Extract chapter"}
            </button>
          </>
        )}
      </div>

      {/* STATUS BAR */}
      {status && (
        <div
          className={`shrink-0 px-4 py-1.5 text-xs border-t border-gilt-b ${
            status.ok ? "text-success bg-success/10" : "text-error bg-error/10"
          }`}
        >
          {status.msg}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToC tree
// ---------------------------------------------------------------------------

function TocNode({
  entry,
  selectedId,
  onSelect,
}: {
  entry: TocEntry;
  selectedId: string | null;
  onSelect: (entry: TocEntry) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = entry.children.length > 0;

  return (
    <div>
      <div
        onClick={() => onSelect(entry)}
        style={{ paddingLeft: `${entry.level * 14 + 6}px` }}
        className={`flex items-center gap-1.5 pr-2 py-1 rounded-lg cursor-pointer text-sm ${
          selectedId === entry.id ? "g-on" : "text-text hover:bg-surface-0"
        }`}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className={`shrink-0 text-[10px] text-subtext-0 transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
          >
            ▶
          </button>
        ) : (
          <span className="shrink-0 text-[10px] text-subtext-0">·</span>
        )}
        <span className="flex-1 truncate" title={entry.title}>
          {entry.title}
        </span>
        <span className="text-xs text-subtext-0 shrink-0">{entry.startPage}</span>
      </div>

      {hasChildren &&
        expanded &&
        entry.children.map((child) => (
          <TocNode key={child.id} entry={child} selectedId={selectedId} onSelect={onSelect} />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Structure editor (flat editable list)
// ---------------------------------------------------------------------------

/**
 * Continuous page scroller, virtualized: every page gets a fixed-height slot
 * (so the scrollbar is honest for the whole document), but only pages near the
 * viewport are actually rendered, and canvases far behind the reader are freed
 * — a 1000-page scan never piles into memory. Reports the page under the
 * reader's eyes via onVisiblePage; `jump` (nonce-keyed) scrolls on command.
 */
function ScrollViewer({
  doc,
  pageCount,
  jump,
  onVisiblePage,
}: {
  doc: PDFDocumentProxy;
  pageCount: number;
  jump: { page: number; nonce: number };
  onVisiblePage: (page: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);
  const drawn = useRef<Set<number>>(new Set());
  const inFlight = useRef<Set<number>>(new Set());
  // Placeholder size from page 1 at fit-to-width scale; real renders match it
  // closely enough that the scrollbar stays stable.
  const [slotHeight, setSlotHeight] = useState(800);
  // Ignore our own programmatic scrolls so a jump doesn't immediately get
  // reported back (and re-clamped) as user scrolling.
  const suppressUntil = useRef(0);

  const fitScale = useCallback((pageWidth: number) => {
    const cw = containerRef.current?.clientWidth ?? 800;
    return Math.min(2, Math.max(0.4, (cw - 48) / pageWidth));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const page = await doc.getPage(1);
        if (!cancelled) {
          const vp = page.getViewport({ scale: fitScale(page.getViewport({ scale: 1 }).width) });
          setSlotHeight(Math.round(vp.height));
        }
        page.cleanup();
      } catch {
        /* keep the default estimate */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, fitScale]);

  const renderPage = useCallback(
    async (n: number) => {
      if (drawn.current.has(n) || inFlight.current.has(n)) return;
      const canvas = slotRefs.current[n - 1]?.querySelector("canvas");
      if (!canvas) return;
      inFlight.current.add(n);
      try {
        const page = await doc.getPage(n);
        const viewport = page.getViewport({ scale: fitScale(page.getViewport({ scale: 1 }).width) });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvas, viewport }).promise;
        page.cleanup();
        drawn.current.add(n);
      } catch {
        /* transient (e.g. doc being destroyed) — redrawn if scrolled back to */
      } finally {
        inFlight.current.delete(n);
      }
    },
    [doc, fitScale],
  );

  // Draw pages as their slots approach the viewport (±1.5 screens).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) void renderPage(Number((e.target as HTMLElement).dataset.page));
        }
      },
      { root: container, rootMargin: "150% 0px" },
    );
    for (const el of slotRefs.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, [pageCount, renderPage]);

  const handleScroll = () => {
    const c = containerRef.current;
    if (!c || Date.now() < suppressUntil.current) return;
    // The page whose slot spans the upper third of the viewport is "current".
    const mark = c.scrollTop + c.clientHeight / 3;
    let current = 1;
    for (let i = 0; i < pageCount; i++) {
      const el = slotRefs.current[i];
      if (el && el.offsetTop <= mark) current = i + 1;
      else break;
    }
    onVisiblePage(current);
    // Free canvases far behind/ahead so long documents stay bounded.
    for (const n of [...drawn.current]) {
      if (Math.abs(n - current) > 8) {
        const canvas = slotRefs.current[n - 1]?.querySelector("canvas");
        if (canvas) {
          canvas.width = 0;
          canvas.height = 0;
        }
        drawn.current.delete(n);
      }
    }
  };

  // Scroll on command (chapter click, ◎ row focus, the page input).
  useEffect(() => {
    const el = slotRefs.current[jump.page - 1];
    const c = containerRef.current;
    if (!el || !c) return;
    suppressUntil.current = Date.now() + 300;
    c.scrollTo({ top: Math.max(0, el.offsetTop - 12) });
    void renderPage(jump.page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump.nonce]);

  return (
    <ScrollArea
      scrollRef={containerRef}
      onScroll={handleScroll}
      className="flex-1 px-4 py-3 bg-mantle"
    >
      <div className="space-y-3 max-w-4xl mx-auto">
        {Array.from({ length: pageCount }, (_, i) => (
          <div
            key={i}
            ref={(el) => {
              slotRefs.current[i] = el;
            }}
            data-page={i + 1}
            style={{ minHeight: slotHeight }}
            className="relative"
          >
            <canvas className="g-paper block mx-auto max-w-full h-auto rounded-sm" />
            <span className="absolute bottom-1.5 right-2 text-[10px] px-1.5 py-0.5 rounded bg-black/55 text-white">
              {i + 1}
            </span>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function StructureEditor({
  entries,
  pageCount,
  previewPage,
  onUpdate,
  onAdd,
  onAddTop,
  onAddAfter,
  onAddAtPreview,
  onDelete,
  onIndent,
  onOutdent,
  onJump,
  onSetFromPreview,
  onSetFromPreviewCascade,
  onShiftAll,
}: {
  entries: FlatEntry[];
  pageCount: number;
  previewPage: number;
  onUpdate: (id: string, patch: Partial<FlatEntry>) => void;
  onAdd: () => void;
  onAddTop: () => void;
  onAddAfter: (id: string) => void;
  onAddAtPreview: () => void;
  onDelete: (id: string) => void;
  onIndent: (id: string) => void;
  onOutdent: (id: string) => void;
  onJump: (page: number) => void;
  onSetFromPreview: (id: string) => void;
  onSetFromPreviewCascade: (id: string) => void;
  onShiftAll: (delta: number) => void;
}) {
  const btn =
    "shrink-0 px-1.5 py-1 text-xs bg-surface-0 hover:bg-surface-1 text-subtext-1 rounded disabled:opacity-30";
  const [shift, setShift] = useState(0);

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-subtext-0">
        Build the table of contents with the document open on the right. ◀ ▶ nest, + adds a row
        below, ◎ claims the previewed page as a row's start, ⇣ claims it AND shifts every row
        below by the same amount, ✕ removes. Focusing a row's page number flips the preview to it.
      </p>
      <div className="flex items-center gap-1.5">
        <span
          className="text-xs text-subtext-0"
          title="Add this to every row's page (negative shifts back). Fixes the printed-vs-PDF page offset in one move: find one chapter's true PDF page in the preview, subtract its listed number, apply the difference."
        >
          Shift all pages
        </span>
        <input
          type="number"
          value={shift}
          onChange={(e) => setShift(Math.trunc(Number(e.target.value) || 0))}
          className="g-field g-field-sm !w-16 shrink-0 !px-1.5"
        />
        <button
          onClick={() => {
            onShiftAll(shift);
            setShift(0);
          }}
          disabled={shift === 0}
          className={btn}
        >
          Apply
        </button>
      </div>

      {entries.map((entry, i) => (
        <div
          key={entry.id}
          className="flex items-center gap-1"
          style={{ paddingLeft: `${entry.level * 14}px` }}
        >
          <button
            title="Outdent"
            onClick={() => onOutdent(entry.id)}
            disabled={entry.level === 0}
            className={btn}
          >
            ◀
          </button>
          <button
            title="Indent"
            onClick={() => onIndent(entry.id)}
            disabled={i === 0 || entry.level > entries[i - 1].level}
            className={btn}
          >
            ▶
          </button>
          <input
            value={entry.title}
            placeholder="Chapter title"
            onChange={(e) => onUpdate(entry.id, { title: e.target.value })}
            spellCheck={false}
            className="g-field g-field-sm flex-1 min-w-0 !w-auto !px-2"
          />
          <input
            type="number"
            min={1}
            max={pageCount}
            value={entry.startPage}
            onFocus={() => onJump(entry.startPage)}
            onChange={(e) => {
              const n = Number(e.target.value);
              const clamped = Math.max(
                1,
                Math.min(pageCount, Number.isFinite(n) && n > 0 ? Math.floor(n) : 1),
              );
              onUpdate(entry.id, { startPage: clamped });
              onJump(clamped);
            }}
            className="g-field g-field-sm !w-14 shrink-0 !px-1.5"
          />
          <button
            title={`Set this chapter's start to the previewed page (p. ${previewPage})`}
            onClick={() => onSetFromPreview(entry.id)}
            className={`shrink-0 px-1.5 py-1 text-xs rounded ${
              entry.startPage === previewPage ? "bg-gilt-b text-gold" : "bg-surface-0 text-subtext-1"
            }`}
          >
            ◎
          </button>
          <button
            title={`Anchor: set this row's start to the previewed page (p. ${previewPage}) AND shift every row below by the same amount — rows above stay. Fixes a printed↔PDF page offset in one click; anchor top-down (front matter first, then Chapter 1).`}
            onClick={() => onSetFromPreviewCascade(entry.id)}
            className={btn}
          >
            ⇣
          </button>
          <button title="Add row below" onClick={() => onAddAfter(entry.id)} className={btn}>
            +
          </button>
          <button
            title="Delete"
            onClick={() => onDelete(entry.id)}
            className="shrink-0 px-1.5 py-1 text-xs bg-surface-0 text-error rounded hover:bg-error/10"
          >
            ✕
          </button>
        </div>
      ))}

      <div className="flex gap-1.5">
        <button
          onClick={onAddTop}
          title="Insert an entry at the very top (front matter often needs one)"
          className="g-btn g-btn-sm g-btn-ghost flex-1"
        >
          + Add at top
        </button>
        <button onClick={onAdd} className="g-btn g-btn-sm g-btn-ghost flex-1">
          + Add entry
        </button>
        <button
          onClick={onAddAtPreview}
          title="Add an entry starting at the page shown in the preview"
          className="g-btn g-btn-sm g-btn-ghost flex-1"
        >
          + Add at p. {previewPage}
        </button>
      </div>
    </div>
  );
}

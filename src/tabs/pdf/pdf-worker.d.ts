// The legacy pdf.js builds ship untyped. The API surface is identical to the
// typed modern entry, so re-export its types for the main module; the worker
// module is only handed to globalThis.pdfjsWorker (pdf.js reads
// .WorkerMessageHandler off the namespace).
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
  export * from "pdfjs-dist";
}
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";

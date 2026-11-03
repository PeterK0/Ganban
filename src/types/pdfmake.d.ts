// Minimal typings for pdfmake's browser bundle (0.3.x). The UMD build's
// module.exports IS the pdfmake instance; vfs_fonts exports the base64 vfs.
// Kept local instead of @types/pdfmake: we use four members, and the document
// definition is built as plain objects in reportExport.ts.
declare module 'pdfmake/build/pdfmake' {
  interface PdfOutput {
    getBlob(): Promise<Blob>;
    getBuffer(): Promise<Uint8Array>;
  }
  interface PdfMake {
    addVirtualFileSystem(vfs: Record<string, string>): void;
    createPdf(definition: Record<string, unknown>): PdfOutput;
  }
  const pdfMake: PdfMake;
  export default pdfMake;
}

declare module 'pdfmake/build/vfs_fonts' {
  const vfs: Record<string, string>;
  export default vfs;
}

/**
 * Files behind a browser drop, folders included. `dataTransfer.files` lists a
 * dropped folder as one empty entry, so walk the entries instead: every file
 * under a dropped folder comes back with its path under it
 * ("Brief/maps/route.png"), dotfiles skipped (as the desktop's
 * list_upload_files does). Nothing is read: a File is a handle on the disk.
 */
export interface PickedFile {
  file: File;
  /** The path under a dropped or picked folder; undefined for a loose file. */
  relPath?: string;
}

export async function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  // Entries must be taken synchronously, before the event's data goes away.
  const entries = Array.from(dt.items ?? [])
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.() ?? null);
  if (entries.length === 0 || entries.some((e) => e == null)) {
    return Array.from(dt.files).map((file) => ({ file }));
  }
  const out: PickedFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.name.startsWith('.')) return;
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ file, relPath: prefix ? `${prefix}${file.name}` : undefined });
      return;
    }
    if (!entry.isDirectory) return;
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const dir = `${prefix}${entry.name}/`;
    // readEntries returns the children in batches until an empty one.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (batch.length === 0) break;
      for (const child of batch) await walk(child, dir);
    }
  };
  for (const e of entries as FileSystemEntry[]) await walk(e, '');
  return out;
}

/** Files from an `<input type=file>`; a folder picker (webkitdirectory) gives
 * each its path under the folder. */
export function filesFromInput(list: FileList | null, folder: boolean): PickedFile[] {
  if (!list) return [];
  return Array.from(list)
    .filter((f) => !folder || !((f as File & { webkitRelativePath?: string }).webkitRelativePath ?? '').split('/').some((p) => p.startsWith('.')))
    .map((file) => {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
      return { file, relPath: folder && rel ? rel : undefined };
    });
}

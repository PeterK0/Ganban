// Atlas › Files: which rows the browser lists (pure, so it unit-tests).
// scripts/test-atlas-files.mjs covers it.
//
// Two kinds of entries: project files (fully manageable) and task attachments
// (owned by their task, so download/open only). A task attachment that was never
// shared (`is_shared` false) has no copy on the host: its bytes sit at
// `file_path` on the machine that attached it. It's listed only when the data on
// screen is served from this machine (local mode, or the host's own desktop),
// where that path can be opened. A client of a host can't reach the file, so the
// row stays hidden there.

export type AtlasEntry = {
  key: string;
  kind: 'project' | 'attachment';
  id: number;
  name: string;
  /** Full library-relative path (folders from rel_path; attachments are flat). */
  relPath: string;
  size: number;
  createdAt: string;
  taskTitle?: string;
  /** Stored only on this device (no host copy): open it at `filePath`. */
  onDevice?: boolean;
  filePath?: string;
};

export type AtlasProjectFile = {
  id: number;
  file_name: string;
  rel_path?: string | null;
  size_bytes: number;
  created_at: string;
};

export type AtlasAttachment = {
  id: number;
  task_title: string;
  file_name: string;
  storage_size: number;
  is_shared?: boolean;
  file_path?: string;
  created_at: string;
};

export function atlasEntries(
  files: AtlasProjectFile[],
  attachments: AtlasAttachment[],
  servedFromThisMachine: boolean
): AtlasEntry[] {
  const rows: AtlasEntry[] = files.map((f) => ({
    key: `p-${f.id}`,
    kind: 'project',
    id: f.id,
    name: f.file_name,
    relPath: f.rel_path || f.file_name,
    size: f.size_bytes,
    createdAt: f.created_at,
  }));
  for (const a of attachments) {
    const onDevice = !a.is_shared;
    if (onDevice && !(servedFromThisMachine && a.file_path)) continue;
    rows.push({
      key: `a-${a.id}`,
      kind: 'attachment',
      id: a.id,
      name: a.file_name,
      relPath: a.file_name, // attachments are flat (no folders)
      size: a.storage_size,
      createdAt: a.created_at,
      taskTitle: a.task_title,
      ...(onDevice ? { onDevice: true, filePath: a.file_path } : {}),
    });
  }
  return rows;
}

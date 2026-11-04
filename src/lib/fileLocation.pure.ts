// "Show in folder" for a Ganban file: when to offer it and what to do when the
// file isn't on this machine. A file's saved path (`file_path`) is only the
// attacher's: empty for files uploaded to the host, and another machine's path
// for files shared from someone else's desktop. The bytes of a shared file live
// in the host's blob store, so the desktop resolves the location itself
// (file_sync::reveal_file, over storage::locate_on_this_machine).

export interface Locatable {
  kind: 'attachment' | 'project';
  /** Has a host copy (project files always do). */
  shared: boolean;
  /** The path saved by the machine that attached it, if any. */
  localPath?: string;
}

/** Whether "Show in folder" makes sense here: a saved path to try, or a host
 * copy on this very machine. A browser has no folders to show. */
export function showInFolderOffered(f: Locatable, ctx: { hasPaths: boolean; onHost: boolean }): boolean {
  if (!ctx.hasPaths) return false;
  if (f.localPath) return true;
  return ctx.onHost && hasHostCopy(f);
}

export function hasHostCopy(f: Locatable): boolean {
  return f.kind === 'project' || f.shared;
}

/** After the reveal: done, explain (local file missing, nearest folder opened),
 * or, when nothing of it is on this machine but the host has a copy, fetch that
 * copy and open it instead of reporting an error. */
export function afterReveal(outcome: 'file' | 'folder' | 'none', f: Locatable): 'done' | 'note' | 'open-host-copy' {
  if (outcome === 'file') return 'done';
  if (outcome === 'none' && hasHostCopy(f)) return 'open-host-copy';
  return 'note';
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../lib/confirm';
import { type MenuItem } from './ContextMenu';
import FileBrowser, { type FileEntry, type UploadTarget } from './files/FileBrowser';
import { KnowledgeEngineSettingsLink, useKnowledgeEngine } from './KnowledgeEngine';
import { ProjectShareLinks } from './ShareLinks';
import { useProjectRole } from '../lib/projectRole';
import { capturePageToProject } from '../lib/daemon';
import { isAbortError, useUploadSummary } from '../lib/uploads';
import { canShowInFolder, revealFile } from '../lib/shell';
import { afterReveal, type Locatable } from '../lib/fileLocation.pure';
import { notify, updateNotif } from '../store/notifications';
import { useAppStore } from '../store/appStore';
import {
  hasDaemon,
  listProjectFiles,
  listProjectAttachments,
  uploadProjectFile,
  uploadTaskFile,
  pushLocalFiles,
  pushLocalFile,
  assignFileToTask,
  unassignAttachment,
  fetchProjectFileBytes,
  getMemberAtlasExport,
  localDaemonBase,
  listLocalAtlasCollections,
  createLocalAtlasCollection,
  uploadLocalAtlasFile,
  isMobilePlatform,
  reindexProject,
  auditProjectFiles,
  clearMissingFiles,
  restoreProjectFile,
  restoreSharedFile,
  openProjectFile,
  openSharedFile,
  isTauri,
  canUploadFromDisk,
  listUploadFiles,
  type DiskFile,
  type ProjectFile,
  type ProjectAttachment,
  type MissingFile,
} from '../lib/daemon';
import { getProjectStorage, getTasks, type ProjectStorage } from '../lib/api';
import { invoke } from '@tauri-apps/api/core';
import type { Task } from '../types';
import {
  canSyncFiles,
  getSyncRoot,
  setSyncRoot,
  isProjectSyncEnabled,
  setProjectSyncEnabled,
  syncProjectFiles,
} from '../lib/fileSync';
import { open } from '@tauri-apps/plugin-dialog';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** A file shown in the central project view — either a project-level upload or a
 * shared attachment that belongs to a task. */
interface Row {
  kind: 'project' | 'task';
  id: number;
  name: string;
  type?: string | null;
  size: number;
  uploaded: string;
  relPath?: string | null;
  taskTitle?: string;
  /** Task rows only: false = legacy local-path attachment (no host copy). */
  shared?: boolean;
  /** Task rows only: the original local path (readable on the attaching machine). */
  path?: string;
}

/** Pick a small glyph for a file by extension/type. */
function fileGlyph(name: string, type?: string | null): string {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const t = type || '';
  if (t.startsWith('image/')) return '🖼️';
  if (t.startsWith('video/')) return '🎬';
  if (t.startsWith('audio/')) return '🎵';
  if (['pdf'].includes(ext)) return '📕';
  if (['md', 'txt', 'rtf'].includes(ext)) return '📄';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊';
  if (['ppt', 'pptx'].includes(ext)) return '📙';
  if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return '🗜️';
  if (['js', 'ts', 'tsx', 'jsx', 'rs', 'py', 'go', 'json', 'toml', 'yaml', 'yml'].includes(ext)) return '🧩';
  return '📎';
}

/** The browser's entry as the handlers below know it. */
function toRow(e: FileEntry): Row {
  return {
    kind: e.kind === 'project' ? 'project' : 'task',
    id: e.id,
    name: e.name,
    type: e.type,
    size: e.size,
    uploaded: e.createdAt,
    relPath: e.relPath,
    taskTitle: e.taskTitle,
    shared: e.kind === 'project' ? undefined : e.shared,
    path: e.localPath,
  };
}

/** A row as "Show in folder" sees it. */
function rowLocatable(r: Row): Locatable & { id: number } {
  return { kind: r.kind === 'project' ? 'project' : 'attachment', id: r.id, shared: r.shared !== false, localPath: r.path };
}

export default function FilesTab() {
  const { selectedProject } = useAppStore();
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [attachments, setAttachments] = useState<ProjectAttachment[]>([]);
  const [storage, setStorage] = useState<ProjectStorage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  // This project's uploads (the upload manager is app-wide; the avatar pop-up
  // shows all of them — this inline strip shows just ours). A whole-percent
  // summary: the tab re-renders when it moves, not on every progress tick.
  const uploadGroup = selectedProject ? `project:${selectedProject.workspaceId ?? 'local'}:${selectedProject.id}` : '';
  const uploadSummary = useUploadSummary(uploadGroup);
  const uploading = uploadSummary.active > 0 ? uploadSummary : null;
  const [indexing, setIndexing] = useState(false);
  const [indexNote, setIndexNote] = useState<string | null>(null);
  // false = no knowledge engine on the host: "Update AI database" explains instead of failing.
  const engine = useKnowledgeEngine();
  const [engineNote, setEngineNote] = useState(false);
  const [syncRoot, setSyncRootState] = useState<string | null>(getSyncRoot());
  const [syncEnabled, setSyncEnabledState] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  // Integrity audit: null = not run; [] = ran clean; entries = broken links.
  const [missing, setMissing] = useState<MissingFile[] | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditNote, setAuditNote] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<number | null>(null);
  // Bumped to make the browser re-read its folders.
  const [reloadKey, setReloadKey] = useState(0);
  const [projectTasks, setProjectTasks] = useState<Task[]>([]);
  const [pushing, setPushing] = useState(false);
  const [panelBusy, setPanelBusy] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const restoreTarget = useRef<MissingFile | null>(null);
  // Where the next web-picked upload lands (the browser's open folder).
  const pickTarget = useRef<UploadTarget>({ dir: '' });

  const connected = hasDaemon();
  const pid = selectedProject?.id;
  // Share links (project admins and the owner, on a host): the files the modal opens with.
  const { canManage } = useProjectRole(pid);
  const canShare = canManage && connected;
  const [shareWith, setShareWith] = useState<FileEntry[] | null>(null);
  useEffect(() => setShareWith(null), [pid]);
  // Owner-granted: may members copy this project's files into their OWN
  // Atlas? (Feeds the “Add to my Atlas” affordance; needs a local daemon.)
  const [memberAtlas, setMemberAtlas] = useState(false);
  // Attended "save a webpage" (desktop): the owner browses in a capture
  // window, the rendered page lands in Files under pages/ (html + txt) —
  // ready for Oracle's file.read. The interim before the render sidecar.
  const [pageUrl, setPageUrl] = useState<string | null>(null); // null = input hidden
  const [capturing, setCapturing] = useState(false);
  const savePage = async () => {
    const url = (pageUrl ?? '').trim();
    if (!url) { setPageUrl(null); return; }
    const full = /^https?:\/\//.test(url) ? url : `https://${url}`;
    setPageUrl(null);
    setCapturing(true);
    const nid = notify({ kind: 'progress', category: 'system', title: 'Save webpage: waiting for you to press Save in the capture window…' });
    try {
      const files = await capturePageToProject(pid!, full, (st) => updateNotif(nid, { title: `Save webpage: ${st}` }));
      updateNotif(nid, { kind: 'success', title: `Saved ${files.map((f) => f.file_name).join(' + ')} to pages/` });
      await refresh();
    } catch (e) {
      updateNotif(nid, { kind: 'error', title: 'Save webpage failed', body: e instanceof Error ? e.message : String(e) });
    } finally {
      setCapturing(false);
    }
  };

  /** The browser's file menu: what only a project's Files can do. */
  const extraMenu = (e: FileEntry): MenuItem[] => {
    const r = toRow(e);
    const items: MenuItem[] = [];
    if (canShowInFolder(rowLocatable(r))) {
      items.push({ label: 'Show in folder', icon: '📂', onClick: () => void onShowInFolder(r) });
    }
    if (r.kind === 'task' && r.shared === false) {
      items.push({ label: 'Push to host', icon: '⇪', onClick: () => void pushOne(r) });
    }
    if (memberAtlas && r.kind === 'project' && localDaemonBase() != null) {
      items.push({ label: 'Add to my Atlas', icon: '📚', onClick: () => void onAddToMyAtlas(r) });
    }
    return items;
  };
  useEffect(() => {
    setMemberAtlas(false);
    if (pid != null) getMemberAtlasExport(pid).then(setMemberAtlas).catch(() => setMemberAtlas(false));
  }, [pid]);

  useEffect(() => {
    setSyncEnabledState(pid != null && isProjectSyncEnabled(pid));
    setSyncResult(null);
    setMissing(null);
    setAuditNote(null);
  }, [pid]);

  useEffect(() => {
    if (pid != null) getTasks(pid, false).then(setProjectTasks).catch(() => setProjectTasks([]));
  }, [pid]);

  const pickSyncFolder = async () => {
    try {
      const sel = await open({ directory: true, multiple: false });
      if (typeof sel === 'string') {
        setSyncRoot(sel);
        setSyncRootState(sel);
      }
    } catch {
      /* picker dismissed */
    }
  };
  const toggleSync = (on: boolean) => {
    if (pid == null) return;
    setProjectSyncEnabled(pid, on);
    setSyncEnabledState(on);
  };
  const runSync = async () => {
    if (!selectedProject || syncing) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const r = await syncProjectFiles(selectedProject);
      setSyncResult(
        `Synced to ${r.dest} — ${r.downloaded} downloaded, ${r.skipped} up-to-date${r.failed ? `, ${r.failed} failed` : ''}.`
      );
    } catch (e) {
      setSyncResult(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  /** Check every host-stored file's bytes; group the broken ones. */
  const runAudit = async () => {
    if (pid == null || auditing) return;
    setAuditing(true);
    setAuditNote(null);
    try {
      const m = await auditProjectFiles(pid);
      setMissing(m);
      if (m.length === 0) setAuditNote('Audit clean — every file\u2019s bytes are accounted for.');
    } catch (e) {
      setAuditNote(e instanceof Error ? e.message : String(e));
    } finally {
      setAuditing(false);
    }
  };

  const pickReplacement = (m: MissingFile) => {
    restoreTarget.current = m;
    restoreInput.current?.click();
  };

  const onReplacementPicked = async (list: FileList | null) => {
    const m = restoreTarget.current;
    const file = list?.[0];
    restoreTarget.current = null;
    if (!m || !file) return;
    setRestoringId(m.id);
    setAuditNote(null);
    try {
      if (m.kind === 'project') await restoreProjectFile(m.id, file);
      else await restoreSharedFile(m.id, file);
      setMissing((prev) => prev?.filter((x) => !(x.id === m.id && x.kind === m.kind)) ?? null);
      setAuditNote(`Restored ${m.file_name} — the link is fixed in place.`);
      void refresh();
    } catch (e) {
      setAuditNote(e instanceof Error ? e.message : String(e));
    } finally {
      setRestoringId(null);
    }
  };

  const clearAllMissing = async () => {
    if (pid == null || !missing?.length) return;
    const n = missing.length;
    if (!(await confirmDialog(`Remove ${n} missing file record${n === 1 ? '' : 's'}? Project files are deleted; shared task attachments revert to unshared.`))) return;
    try {
      const r = await clearMissingFiles(pid);
      setMissing([]);
      setAuditNote(`Cleared ${r.cleared} missing record${r.cleared === 1 ? '' : 's'}.`);
      void refresh();
    } catch (e) {
      setAuditNote(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (pid != null && connected) void refresh();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, connected]);

  async function refresh() {
    if (pid == null) return;
    setLoading(true);
    setError(null);
    try {
      const [fs, atts, st] = await Promise.all([
        listProjectFiles(pid),
        listProjectAttachments(pid),
        getProjectStorage(pid),
      ]);
      setFiles(fs);
      setAttachments(atts);
      setStorage(st);
      setReloadKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  /** Project uploads + task attachments (shared and legacy local), for the browser. */
  const entries = useMemo<FileEntry[]>(
    () => [
      ...files.map((f): FileEntry => ({
        key: `p-${f.id}`,
        kind: 'project',
        id: f.id,
        name: f.file_name,
        relPath: f.rel_path ?? null,
        type: f.file_type,
        size: f.size_bytes,
        createdAt: f.created_at,
        uploadedBy: f.uploaded_by,
        shared: true,
        aiIncluded: f.ai_included,
      })),
      ...attachments.map((a): FileEntry => ({
        key: `a-${a.id}`,
        kind: 'attachment',
        id: a.id,
        name: a.file_name,
        relPath: a.rel_path ?? null,
        type: a.file_type,
        size: a.storage_size,
        createdAt: a.created_at,
        uploadedBy: a.uploaded_by,
        taskId: a.task_id,
        taskTitle: a.task_title,
        shared: a.is_shared !== false,
        localPath: a.file_path || undefined,
        aiIncluded: a.ai_included,
      })),
    ],
    [files, attachments],
  );
  const localRows = useMemo(() => entries.filter((e) => !e.shared).map(toRow), [entries]);
  const localCount = localRows.length;

  /** Push ONE local attachment by reading its bytes from THIS machine's disk
   * and uploading them — the only direction that works when the host is a
   * different machine (the host can't reach our filesystem). */
  const pushFromThisMachine = async (r: Row) => {
    if (!r.path) throw new Error(`${r.name}: no local path recorded`);
    const buf = await invoke<ArrayBuffer>('read_local_file', { path: r.path });
    await restoreSharedFile(r.id, new File([buf], r.name, { type: r.type || 'application/octet-stream' }));
  };

  /** Batch-push every legacy local attachment to the host. On the desktop app
   * the bytes are read from THIS machine (works in both local and online
   * modes); the server-side sweep remains the fallback for web clients. */
  const pushAllLocal = async () => {
    if (pid == null || pushing) return;
    setPushing(true);
    setError(null);
    try {
      if (isTauri()) {
        const locals = localRows;
        let pushed = 0;
        const failures: string[] = [];
        for (const r of locals) {
          try {
            await pushFromThisMachine(r);
            pushed += 1;
          } catch (e) {
            failures.push(`${r.name} (${e instanceof Error ? e.message : String(e)})`);
          }
        }
        const hint = failures.some((f) => f.includes('CloudStorage') && f.includes('No such file'))
          ? ' (a OneDrive/iCloud path that is no longer on disk — the file may be cloud-only or moved; open the folder, make it available offline, then push again, or remove the attachment)'
          : '';
        const fails = failures.length ? ` ${failures.length} could not be pushed: ${failures.join('; ')}${hint}` : '';
        setAuditNote(`Pushed ${pushed} local file${pushed === 1 ? '' : 's'} to the host.${fails}`);
      } else {
        const r = await pushLocalFiles(pid);
        const fails = r.failures.length
          ? ` ${r.failures.length} could not be pushed: ${r.failures.map(([n, why]) => `${n} (${why})`).join('; ')}${
              r.failures.some(([, why]) => why.includes('CloudStorage') && why.includes('No such file'))
                ? ' — a OneDrive/iCloud path that is no longer on disk: make the file available offline (or remove the attachment) and push again'
                : ''
            }`
          : '';
        setAuditNote(`Pushed ${r.shared} local file${r.shared === 1 ? '' : 's'} to the host.${fails}`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPushing(false);
    }
  };

  /** Panel: push one local attachment to the host (id is stable, keep selection). */
  const pushOne = async (r: Row) => {
    setPanelBusy(true);
    setError(null);
    try {
      if (isTauri()) await pushFromThisMachine(r);
      else await pushLocalFile(r.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPanelBusy(false);
    }
  };

  /** Panel: allocate to a task. Project files assign directly; attachments
   * reassign by detaching to a project file first (ids change → close panel). */
  const allocateToTask = async (r: Row, taskId: number) => {
    setPanelBusy(true);
    setError(null);
    try {
      if (r.kind === 'project') {
        await assignFileToTask(r.id, taskId);
      } else {
        const pf = (await unassignAttachment(r.id)) as { id: number };
        await assignFileToTask(pf.id, taskId);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPanelBusy(false);
    }
  };

  /** Panel: detach an attachment from its task into the project files pool. */
  const detachFromTask = async (r: Row) => {
    setPanelBusy(true);
    setError(null);
    try {
      await unassignAttachment(r.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPanelBusy(false);
    }
  };

  /** Upload a batch of [file, relPath] pairs through the upload manager: it
   * queues them (two at a time), streams each without blocking the UI, and
   * shows them in the avatar pop-up. Files appear in the list as they land. */
  async function uploadBatch(batch: { file: File | DiskFile; relPath?: string }[], to: UploadTarget = { dir: '' }) {
    if (pid == null || batch.length === 0) return;
    setError(null);
    const group = uploadGroup;
    const target = selectedProject?.name;
    // Files that can't fit in the project's remaining storage are refused here,
    // with the reason: the host would refuse them too, but its answer can be
    // lost when it closes the connection mid-upload — and a 1 GB file
    // shouldn't start crossing the network just to be turned away.
    const fresh = await getProjectStorage(pid).catch(() => null);
    let room = fresh && fresh.quota > 0 ? fresh.quota - fresh.used : Infinity;
    const items: typeof batch = [];
    const tooBig: string[] = [];
    for (const it of batch) {
      if (it.file.size > room) tooBig.push(`${it.relPath || it.file.name} (${formatBytes(it.file.size)})`);
      else {
        items.push(it);
        room -= it.file.size;
      }
    }
    if (tooBig.length) {
      const left = fresh ? formatBytes(Math.max(0, fresh.quota - fresh.used)) : '';
      const msg = `Not uploaded — over ${target ?? 'the project'}’s remaining storage (${left} left): ${tooBig.slice(0, 3).join(', ')}${tooBig.length > 3 ? ` and ${tooBig.length - 3} more` : ''}`;
      notify({ kind: 'error', category: 'system', title: `${tooBig.length} file${tooBig.length === 1 ? '' : 's'} too big for ${target ?? 'the project'}`, body: msg });
    }
    if (items.length === 0) {
      setError(`${tooBig.length === 1 ? 'That file doesn’t' : 'Those files don’t'} fit in ${target ?? 'the project'}’s remaining storage. Ask an admin to raise its allocation.`);
      return;
    }
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refreshSoon = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refresh(), 800);
    };
    const results = await Promise.allSettled(
      items.map(({ file, relPath }) => {
        // Into the browser's open folder: the project's, or a task's.
        const inner = relPath || (to.dir ? file.name : undefined);
        const path = to.dir && inner ? `${to.dir}/${inner}` : inner;
        const sent = to.taskId != null
          ? uploadTaskFile(to.taskId, file, path, { target, group })
          : uploadProjectFile(pid, file, path, { target, group });
        return sent.then((r) => {
          refreshSoon();
          return r;
        });
      })
    );
    if (refreshTimer) clearTimeout(refreshTimer);
    await refresh(); // (clears the error line — so report failures after it)
    const failed = results.filter((r) => r.status === 'rejected' && !isAbortError(r.reason));
    if (failed.length) {
      const first = (failed[0] as PromiseRejectedResult).reason;
      setError(
        `${failed.length} of ${items.length} upload${items.length === 1 ? '' : 's'} failed — ${first instanceof Error ? first.message : String(first)}`
      );
    }
  }

  function onFilesPicked(list: FileList | null, useRelPath: boolean) {
    if (!list) return;
    const items = Array.from(list).map((file) => ({
      file,
      relPath: useRelPath && (file as any).webkitRelativePath ? (file as any).webkitRelativePath : undefined,
    }));
    void uploadBatch(items, pickTarget.current);
  }

  // Desktop: files are picked natively (or dropped onto the window) and Rust
  // streams them from disk — no file bytes pass through the webview, so a big
  // upload doesn't slow the app down. Web and mobile pick File objects.
  const fromDisk = canUploadFromDisk();

  /** Upload the files behind picked or dropped paths (folders expand). */
  async function uploadPaths(paths: string[], to: UploadTarget = { dir: '' }) {
    try {
      const entries = await listUploadFiles(paths);
      if (!entries.length) {
        setNotice('Nothing to upload there: the folder is empty, or it couldn’t be read.');
        return;
      }
      void uploadBatch(entries.map((e) => ({ file: e, relPath: e.relPath ?? undefined })), to);
    } catch (e) {
      setError(`Could not read the files: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function pickFromDisk(folder: boolean, to: UploadTarget) {
    const picked = await open({ multiple: true, directory: folder, title: folder ? 'Upload folders' : 'Upload files' });
    if (picked) await uploadPaths(Array.isArray(picked) ? picked : [picked], to);
  }

  /** The browser's Upload buttons, aimed at its open folder. */
  function pickUpload(folder: boolean, to: UploadTarget) {
    if (fromDisk) void pickFromDisk(folder, to);
    else {
      pickTarget.current = to;
      (folder ? folderInput : fileInput).current?.click();
    }
  }

  // Desktop drops arrive as native drag-drop events with paths (the webview
  // doesn't get dropped files). They're window-wide, so only a drop over this
  // tab counts. A ref keeps the handler on the latest project.
  const rootRef = useRef<HTMLDivElement>(null);
  const uploadPathsRef = useRef(uploadPaths);
  uploadPathsRef.current = uploadPaths;
  const canDrop = fromDisk && pid != null;
  useEffect(() => {
    if (!canDrop) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    /** Whether a drag position (physical pixels, webview-relative) is over this tab. */
    const overTab = (pos: { x: number; y: number }) => {
      const r = rootRef.current?.getBoundingClientRect();
      const x = pos.x / window.devicePixelRatio;
      const y = pos.y / window.devicePixelRatio;
      return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((e) => {
          const p = e.payload;
          if (p.type === 'enter' || p.type === 'over') setDragOver(overTab(p.position));
          else if (p.type === 'leave') setDragOver(false);
          else if (p.type === 'drop') {
            setDragOver(false);
            if (p.paths.length && overTab(p.position)) void uploadPathsRef.current(p.paths);
          }
        })
      )
      .then((un) => (alive ? (unlisten = un) : un()))
      .catch((e) => console.warn('Files: native drop unavailable', e));
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [canDrop]);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    // On desktop the native drop handler above uploads from disk.
    if (pid == null || fromDisk) return;
    const items = Array.from(e.dataTransfer.files).map((file) => ({ file }));
    void uploadBatch(items);
  }

  /** Copy a host file into MY OWN Atlas (my machine's loopback daemon, where
   * I'm the owner): bytes from the host → a local “Shared with me” library.
   * This is how a work brief's documents reach the corpus my local agents
   * actually search — indexing stays MY call, over there. */
  async function onAddToMyAtlas(r: Row) {
    if (r.kind !== 'project' || pid == null) return;
    try {
      const bytes = await fetchProjectFileBytes(r.id);
      const cols = await listLocalAtlasCollections();
      let target = cols.find((c) => c.slug === 'shared-with-me');
      if (!target) {
        target = (await createLocalAtlasCollection('shared-with-me', 'Shared with me')).collection;
      }
      const proj = (selectedProject?.name ?? 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await uploadLocalAtlasFile(target.id, bytes, `${proj}/${r.name}`);
      setError(null);
      alert(`Added to YOUR Atlas (library “Shared with me”). Open your own Ganban's Atlas › Library to index it when ready.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Where this file lives on THIS machine (task attachments keep the path
   * they were attached from) — the member-side way to find a project's local
   * folders. Falls back to the nearest folder that still exists. */
  async function onShowInFolder(r: Row) {
    try {
      const f = rowLocatable(r);
      const res = await revealFile(f);
      const then = afterReveal(res.outcome, f);
      // Nothing of it here, but the host has a copy: open that, not an error.
      if (then === 'open-host-copy') await (r.kind === 'project' ? openProjectFile(r.id, r.name) : openSharedFile(r.id, r.name));
      setNotice(
        then !== 'note'
          ? null
          : res.outcome === 'folder'
            ? `${r.name} isn't at its saved path on this machine — opened the nearest folder: ${res.opened}`
            : `${r.name} isn't on this machine — it was saved as ${r.path}${r.shared === false ? '' : '. Download gets you the shared copy.'}`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onReindex() {
    if (pid == null) return;
    setIndexNote(null);
    setEngineNote(engine === false);
    if (engine === false) return;
    setIndexing(true);
    try {
      await reindexProject(pid);
      setIndexNote(
        'Indexing started. It runs in the background on the host and may take a few minutes for large files — the assistant will pick up the new content automatically when it finishes.'
      );
    } catch (e) {
      setIndexNote(`Could not start indexing: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setIndexing(false);
    }
  }

  if (!selectedProject) {
    return <div className="flex-1 flex items-center justify-center text-subtext-0">Select a project.</div>;
  }

  if (!connected) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center text-subtext-0">
        <div className="max-w-md">
          <div className="text-4xl mb-3">📁</div>
          <p className="font-medium text-text mb-1">Files live on the host</p>
          <p className="text-sm">
            Connect this device to your host (Settings → Sync) to upload and browse project files.
          </p>
        </div>
      </div>
    );
  }

  const usedPct =
    storage && storage.quota > 0 ? Math.min(100, Math.round((storage.used / storage.quota) * 100)) : 0;
  const nearFull = usedPct >= 90;

  return (
    <div ref={rootRef} className="flex-1 flex flex-col h-full bg-base min-w-0">
      {/* Header: storage + actions */}
      <div className="px-6 pt-5 pb-4 border-b border-gilt-b bg-mantle">
        <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
          <div>
            <h2 className="g-ptitle text-text">Files</h2>
            <p className="text-xs text-subtext-0">
              Stored on the host • {files.length} project file{files.length === 1 ? '' : 's'}
              {attachments.length > 0 && ` + ${attachments.length} from tasks`}
            </p>
          </div>
          <div className="flex gap-2 flex-wrap justify-end">
            {isTauri() && !isMobilePlatform() && (
              <button
                onClick={() => setPageUrl((v) => (v === null ? '' : null))}
                disabled={capturing}
                title="Open a page in a capture window and save its rendered HTML + text into this project (pages/) — the way past bot-walled sites for Oracle workflows."
                className="g-btn g-btn-ghost"
              >
                {capturing ? 'Capturing…' : '📸 Save webpage'}
              </button>
            )}
            <button
              onClick={onReindex}
              disabled={indexing}
              title="Re-index this project's content for the AI assistant"
              className="g-btn g-btn-ghost"
            >
              {indexing ? 'Starting…' : 'Update AI database'}
            </button>
            <button
              onClick={() => void runAudit()}
              disabled={auditing}
              title="Verify every file's bytes still exist on the host; broken links group under Missing"
              className="g-btn g-btn-ghost"
            >
              {auditing ? 'Auditing…' : 'Audit files'}
            </button>
          </div>
        </div>

        {pageUrl !== null && (
          <div className="flex items-center gap-2 mb-3">
            <input
              autoFocus
              value={pageUrl}
              onChange={(e) => setPageUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void savePage();
                if (e.key === 'Escape') setPageUrl(null);
              }}
              placeholder="https://… — the capture window opens there; browse to the exact page, then press Save"
              className="g-field flex-1 !w-auto min-w-0"
            />
            <button onClick={() => void savePage()} className="g-btn g-btn-pri">
              Open capture window
            </button>
            <button onClick={() => setPageUrl(null)} className="g-btn g-btn-ghost !shadow-none">
              Cancel
            </button>
          </div>
        )}

        {/* Storage usage (dynamic ceiling — usage grows toward the cap, nothing reserved) */}
        {storage && (
          <div>
            <div className="flex justify-between text-xs text-subtext-0 mb-1">
              <span>Storage</span>
              <span className={nearFull ? 'text-error font-medium' : ''}>
                {formatBytes(storage.used)} / {formatBytes(storage.quota)}
              </span>
            </div>
            <div className="h-1 bg-surface-0 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${nearFull ? 'bg-error' : 'bg-gold'}`}
                style={{ width: `${usedPct}%` }}
              />
            </div>
          </div>
        )}

        {/* Sync to this computer (desktop only) — a local mirror of the files */}
        {canSyncFiles() && (
          <div className="mt-3 pt-3 border-t border-gilt-b space-y-1.5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <label className="flex items-center gap-2 text-sm text-text">
                <input type="checkbox" checked={syncEnabled} onChange={(e) => toggleSync(e.target.checked)} />
                Keep this project's files synced to my computer
              </label>
              <button
                onClick={runSync}
                disabled={syncing || !syncRoot}
                className="g-btn g-btn-sm g-btn-ghost"
              >
                {syncing ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
            <div className="flex items-center gap-2 text-xs text-subtext-0">
              <span className="shrink-0">Folder:</span>
              {syncRoot ? (
                <span className="font-mono truncate" title={`${syncRoot}/${selectedProject.name}`}>
                  {syncRoot}/{selectedProject.name}
                </span>
              ) : (
                <span className="italic">not set</span>
              )}
              <button onClick={pickSyncFolder} className="g-lnk shrink-0">
                {syncRoot ? 'Change' : 'Choose…'}
              </button>
            </div>
            {syncResult && <p className="text-xs text-subtext-0">{syncResult}</p>}
          </div>
        )}

        {/* hidden inputs */}
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            onFilesPicked(e.target.files, false);
            e.target.value = '';
          }}
        />
        <input
          ref={restoreInput}
          type="file"
          className="hidden"
          onChange={(e) => {
            void onReplacementPicked(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          ref={folderInput}
          type="file"
          multiple
          className="hidden"
          // @ts-expect-error non-standard but widely supported folder picker
          webkitdirectory=""
          directory=""
          onChange={(e) => {
            onFilesPicked(e.target.files, true);
            e.target.value = '';
          }}
        />
      </div>

      {/* Background indexing note */}
      {(indexing || indexNote || (engineNote && engine === false)) && (
        <div className="px-6 py-2 bg-mantle border-b border-gilt-b">
          {engineNote && engine === false && (
            <p className="text-xs text-subtext-0">
              The AI database needs the knowledge engine (ragrat), an optional part of Ganban that isn’t set up on this
              host. Set it up in <KnowledgeEngineSettingsLink />.
            </p>
          )}
          {indexing && (
            <div className="h-1 bg-surface-0 rounded-full overflow-hidden mb-1">
              <div className="h-full w-1/3 bg-gold rounded-full animate-pulse" />
            </div>
          )}
          {indexNote && <p className="text-xs text-subtext-0">{indexNote}</p>}
        </div>
      )}

      {/* Upload progress (this project's; the avatar pop-up has every upload) */}
      {uploading && (
        <div className="px-6 py-2 bg-mantle border-b border-gilt-b">
          <div className="flex justify-between gap-3 text-xs text-subtext-0 mb-1">
            <span className="truncate">Uploading {uploading.name}</span>
            <span className="shrink-0 tabular-nums">
              {uploading.done} / {uploading.total} · {uploading.pct}%
            </span>
          </div>
          <div className="h-1 bg-surface-0 rounded-full overflow-hidden">
            <div className="h-full bg-gold rounded-full transition-[width] duration-300" style={{ width: `${uploading.pct}%` }} />
          </div>
        </div>
      )}

      {error && (
        <div className="mx-6 mt-3 px-3 py-2 bg-error/10 border border-error/30 text-error rounded-lg text-sm">{error}</div>
      )}
      {notice && (
        <div className="mx-6 mt-3 g-inset !py-2 text-subtext-1 text-sm flex items-start gap-3">
          <span className="flex-1 min-w-0 break-words">{notice}</span>
          <button onClick={() => setNotice(null)} className="g-iconbtn !w-8 !h-8 -my-1.5 shrink-0" title="Dismiss">
            ✕
          </button>
        </div>
      )}

      {/* The browser; drops land at the project's top level. */}
      <div
        className="flex-1 min-h-0 flex flex-col"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={onDrop}
      >
        <FileBrowser
          projectId={selectedProject.id}
          rootLabel={selectedProject.name}
          workspaceId={selectedProject.workspaceId}
          entries={loading && files.length === 0 && attachments.length === 0 ? null : entries}
          onReload={() => void refresh()}
          reloadKey={reloadKey}
          onUpload={pickUpload}
          dragOver={dragOver}
          onShare={canShare ? setShareWith : undefined}
          extraMenu={extraMenu}
          extraDetails={(e) => (
            <AllocationSection
              row={toRow(e)}
              tasks={projectTasks}
              busy={panelBusy || pushing}
              onPush={() => void pushOne(toRow(e))}
              onAllocate={(taskId) => void allocateToTask(toRow(e), taskId)}
              onDetach={() => void detachFromTask(toRow(e))}
              onShowInFolder={canShowInFolder(rowLocatable(toRow(e))) ? () => void onShowInFolder(toRow(e)) : null}
              onAddToMyAtlas={
                memberAtlas && e.kind === 'project' && localDaemonBase() != null ? () => void onAddToMyAtlas(toRow(e)) : null
              }
            />
          )}
          banner={
            (auditNote || (missing && missing.length > 0) || localCount > 0) && (
              <div className="shrink-0 px-3 pt-3">
                {/* Audit result: broken links grouped for repair-or-clear */}
                {auditNote && <div className="mb-3 g-inset !py-2 text-xs text-subtext-0">{auditNote}</div>}
                {missing !== null && missing.length > 0 && (
                  <div className="mb-3 px-3 py-2.5 bg-error/5 border border-error/30 rounded-lg space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="g-cap !text-error">Missing · {missing.length}</span>
                      <button onClick={() => void clearAllMissing()} className="g-btn g-btn-sm g-btn-danger shrink-0">
                        Clear all missing
                      </button>
                    </div>
                    <p className="text-xs text-subtext-0">
                      These entries point at bytes that are no longer on the host. Upload a replacement to fix a link in
                      place (same file id, references survive), or clear them all.
                    </p>
                    <div className="space-y-1">
                      {missing.map((m) => (
                        <div key={`${m.kind}-${m.id}`} className="flex items-center gap-2 text-sm">
                          <span className="shrink-0">{fileGlyph(m.file_name)}</span>
                          <span className="flex-1 truncate text-text" title={m.file_name}>
                            {m.file_name}
                          </span>
                          <span className="text-xs text-subtext-0 shrink-0">
                            {m.kind === 'attachment' ? 'task attachment' : 'project file'}
                          </span>
                          <button
                            onClick={() => pickReplacement(m)}
                            disabled={restoringId === m.id}
                            className="g-btn g-btn-sm g-btn-ghost shrink-0"
                          >
                            {restoringId === m.id ? 'Uploading…' : 'Upload replacement'}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {localCount > 0 && (
                  <div className="mb-3 g-inset !py-2.5 flex items-center gap-3">
                    <span className="text-xs text-subtext-0 flex-1">
                      {localCount} task file{localCount === 1 ? ' exists' : 's exist'} only on this machine (legacy local
                      attachments). Push them to the host so the whole team — and the knowledge base — can see them.
                    </span>
                    <button onClick={() => void pushAllLocal()} disabled={pushing} className="g-btn g-btn-sm g-btn-pri shrink-0">
                      {pushing ? 'Pushing…' : 'Push local files to host'}
                    </button>
                  </div>
                )}
              </div>
            )
          }
          empty={
            <div className={`g-drop py-16 text-center text-subtext-0 transition-colors ${dragOver ? 'g-over !text-gold' : ''}`}>
              <div className="text-4xl mb-2">📂</div>
              <p className="font-medium text-text">Drop files here</p>
              <p className="text-sm">or use “Upload files” / “Upload folder” above.</p>
              <p className="text-xs mt-2">Files you attach to tasks appear under Task files.</p>
            </div>
          }
        />
      </div>
      {canShare && (
        <ProjectShareLinks
          projectId={selectedProject.id}
          projectName={selectedProject.name}
          entries={entries}
          shareWith={shareWith}
          onShareClosed={() => setShareWith(null)}
          taskTitle={(id) => projectTasks.find((t) => t.id === id)?.title ?? attachments.find((a) => a.task_id === id)?.task_title}
        />
      )}
    </div>
  );
}

/** The details pane's project-only part: push a local file to the host, allocate a file to
 * a task or detach it back to the project, show it on this machine, copy it to my Atlas. */
function AllocationSection({
  row,
  tasks,
  busy,
  onPush,
  onAllocate,
  onDetach,
  onShowInFolder,
  onAddToMyAtlas,
}: {
  row: Row;
  tasks: Task[];
  busy: boolean;
  onPush: () => void;
  onAllocate: (taskId: number) => void;
  onDetach: () => void;
  /** Desktop + the row has a saved local path: reveal it on this machine. */
  onShowInFolder?: (() => void) | null;
  /** Non-null when the owner granted member-atlas export AND this machine
   * runs its own daemon: copy the file into MY OWN Atlas library. */
  onAddToMyAtlas?: (() => void) | null;
}) {
  const [taskId, setTaskId] = useState<number | ''>('');
  const isLocal = row.kind === 'task' && row.shared === false;
  return (
    <div className="space-y-3">
      {isLocal && (
        <div className="g-inset !px-3 !py-2 space-y-2">
          <p className="text-xs text-subtext-0">
            This file lives only on the uploader's machine — there is no host copy to download or index.
          </p>
          <button onClick={onPush} disabled={busy} className="g-btn g-btn-sm g-btn-pri w-full">
            {busy ? 'Pushing…' : 'Push to host'}
          </button>
        </div>
      )}
      {/* Allocation: a file belongs either to the project pool or to a task. */}
      <div className="space-y-2">
        <div className="g-cap">{row.kind === 'project' ? 'Allocate to a task' : 'Allocation'}</div>
        {isLocal ? (
          <p className="text-xs text-subtext-0">Push it to the host first — then it can be reallocated.</p>
        ) : (
          <>
            <select
              value={taskId}
              onChange={(e) => setTaskId(e.target.value ? Number(e.target.value) : '')}
              className="g-field g-field-sm w-full"
              aria-label="Task"
            >
              <option value="">{row.kind === 'project' ? 'Pick a task…' : 'Move to another task…'}</option>
              {tasks
                .filter((t) => !t.archived)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
            </select>
            <button onClick={() => taskId && onAllocate(Number(taskId))} disabled={!taskId || busy} className="g-btn g-btn-sm g-btn-ghost w-full">
              {busy ? 'Working…' : row.kind === 'project' ? 'Assign to task' : 'Reassign'}
            </button>
            {row.kind === 'task' && (
              <button onClick={onDetach} disabled={busy} className="g-btn g-btn-sm g-btn-ghost w-full">
                Detach → project files
              </button>
            )}
          </>
        )}
      </div>
      {(onShowInFolder || onAddToMyAtlas) && (
        <div className="flex flex-wrap gap-2">
          {onShowInFolder && (
            <button onClick={onShowInFolder} title="Show where this file lives on this machine" className="g-btn g-btn-sm g-btn-ghost flex-1">
              Show in folder
            </button>
          )}
          {onAddToMyAtlas && (
            <button
              onClick={onAddToMyAtlas}
              disabled={busy}
              title="Copy this file into YOUR OWN Atlas (on your machine) so your local agents can reference it. Indexing stays your call, over there."
              className="g-btn g-btn-sm g-btn-ghost flex-1"
            >
              → My Atlas
            </button>
          )}
        </div>
      )}
    </div>
  );
}

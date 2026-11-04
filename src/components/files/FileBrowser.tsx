import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { openPath } from '@tauri-apps/plugin-opener';
import {
  createFileFolder,
  deleteFileFolder,
  getStorageLocation,
  listFileFolders,
  moveFilesTo,
  renameFile,
  renameFileFolder,
  setFileAiIncluded,
  type FolderScope,
  type StorageLocation,
} from '../../lib/api';
import {
  daemonFetchBlob,
  deleteProjectFile,
  deleteSharedAttachment,
  downloadProjectFile,
  downloadSharedFile,
  isMobilePlatform,
  isTauri,
  openProjectFile,
  openSharedFile,
  servingFromThisMachine,
} from '../../lib/daemon';
import { confirmDialog } from '../../lib/confirm';
import { AI_FILE_TOO_LARGE, hostErrorCode } from '../../lib/hostError.pure';
import { hasFilePaths } from '../../lib/shell';
import { openInProjectTasks } from '../../lib/gotoTask';
import { useProjectRole } from '../../lib/projectRole';
import type { Task } from '../../types';
import { useContextMenu, type MenuItem } from '../ContextMenu';
import ScrollArea from '../ScrollArea';
import { Modal, ResizablePane } from '../gilt';
import { useKnowledgeEngine } from '../KnowledgeEngine';
import { CATEGORIES, categoryOf, extOf, fmtDate, fmtSize, iconFor, isDrawable, type FileCategory } from './fileKinds';

// The Files browser shared by Project › Files and a task's Files tab (side pane and
// full view), modelled on Atlas › Files: folders with a breadcrumb, list and grid
// views, search, sort and filters, a details pane, multi-select, rename, move,
// folders that survive empty, and the AI overview switch.
//
// In a project, task attachments sit under a virtual "Task files" folder with one
// folder per task (lead's call, option A); search and filters flatten everything.

/** One file in the browser: a project's own file or a task attachment. */
export interface FileEntry {
  key: string;
  kind: 'project' | 'attachment';
  id: number;
  name: string;
  /** The stored folder path, file name included; null for a loose file. */
  relPath: string | null;
  type?: string | null;
  size: number;
  createdAt: string;
  uploadedBy?: number | null;
  taskId?: number;
  taskTitle?: string;
  /** False: a legacy local attachment, whose bytes are only on the uploader's machine. */
  shared: boolean;
  /** Where a local attachment was attached from (on that machine). */
  localPath?: string;
  aiIncluded: boolean;
}

/** Where an upload lands: a task's folder, or the project's (taskId left out). */
export interface UploadTarget {
  taskId?: number;
  dir: string;
}

interface Props {
  projectId: number;
  /** The breadcrumb's root. */
  rootLabel: string;
  workspaceId?: string;
  /** Show one task's files (the task editor). */
  taskId?: number;
  entries: FileEntry[] | null;
  /** Re-read the entries (after a rename, move, delete…). */
  onReload: () => void;
  /** Bumped by the parent to re-read folders too. */
  reloadKey?: number;
  onUpload?: (folder: boolean, target: UploadTarget) => void;
  /** Delete one file; defaults to the host routes. */
  deleteEntry?: (e: FileEntry) => Promise<void>;
  /** Open a local attachment on this machine (desktop). */
  openLocal?: (e: FileEntry) => void;
  /** Extra buttons at the toolbar's end. */
  actions?: ReactNode;
  /** Make a share link with these files ticked (Project > Files, for admins). */
  onShare?: (entries: FileEntry[]) => void;
  /** Notices above the list (audit results, push banners). */
  banner?: ReactNode;
  /** Extra items for a file's menu. */
  extraMenu?: (e: FileEntry) => MenuItem[];
  /** Extra sections for a file's details. */
  extraDetails?: (e: FileEntry) => ReactNode;
  /** Small tags after a file's name. */
  extraTags?: (e: FileEntry) => ReactNode;
  /** Bring this file into view and select it (the task editor's /files/<id> links). */
  focusKey?: string | null;
  /** Shown when there are no files at all. */
  empty?: ReactNode;
  /** The parent scrolls (the task side pane): no inner scroll area. */
  flow?: boolean;
  dragOver?: boolean;
}

type SortKey = 'name' | 'type' | 'size' | 'date';
type Stored = '' | 'host' | 'device';
type Ai = '' | 'in' | 'out';
interface Filters {
  cat: FileCategory | '';
  stored: Stored;
  ai: Ai;
  uploader: number | '';
}
const NO_FILTERS: Filters = { cat: '', stored: '', ai: '', uploader: '' };

const VIEW_KEY = 'ganban:files-view';
const SORT_KEY = 'ganban:files-sort';
const TASKS = 'Task files';
/** Grid thumbnails: images under this size only. */
const THUMB_CAP = 8 * 1024 * 1024;
const PREVIEW_CAP = 20 * 1024 * 1024;

const blobPath = (e: FileEntry) => (e.kind === 'project' ? `/projects/files/${e.id}/download` : `/files/${e.id}`);
/** The list's name column: it grows with the pane up to a readable width, so on an
 * ultrawide the details sit beside the names and the spare width ends the row. */
const NAME_COL = 'flex-1 min-w-0 max-w-[60rem]';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** A task's folder name in the project tree: its title, made path-safe and unique. */
function taskSegments(entries: FileEntry[]): Map<number, string> {
  const titles = new Map<number, string>();
  for (const e of entries) if (e.taskId != null && !titles.has(e.taskId)) titles.set(e.taskId, e.taskTitle ?? '');
  const count = new Map<string, number>();
  const base = (t: string) => t.replace(/\//g, '∕').trim() || 'Untitled task';
  for (const t of titles.values()) count.set(base(t), (count.get(base(t)) ?? 0) + 1);
  const out = new Map<number, string>();
  for (const [id, t] of titles) out.set(id, count.get(base(t))! > 1 ? `${base(t)} (#${id})` : base(t));
  return out;
}

/** A lazily drawn image thumbnail (grid cards), from the download route. */
function Thumb({ entry, className }: { entry: FileEntry; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setSeen(true), { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!seen) return;
    let made: string | null = null;
    let stale = false;
    daemonFetchBlob(blobPath(entry))
      .then((b) => {
        if (stale) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => {});
    return () => {
      stale = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [seen, entry.key, entry.size]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div ref={ref} className={`flex items-center justify-center overflow-hidden ${className ?? ''}`}>
      {url ? <img src={url} alt="" className="w-full h-full object-cover" /> : <span className="text-3xl">{iconFor(entry.name, entry.type)}</span>}
    </div>
  );
}

export default function FileBrowser({
  projectId,
  rootLabel,
  workspaceId,
  taskId,
  entries,
  onReload,
  reloadKey,
  onUpload,
  deleteEntry,
  openLocal,
  actions,
  onShare,
  banner,
  extraMenu,
  extraDetails,
  extraTags,
  focusKey,
  empty,
  flow,
  dragOver,
}: Props) {
  const taskMode = taskId != null;
  const { members, canManage } = useProjectRole(projectId);
  const [cwd, setCwd] = useState<string[]>([]);
  const [view, setView] = useState<'list' | 'grid'>(() => (localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'));
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>(() => {
    try {
      const raw = localStorage.getItem(SORT_KEY);
      if (raw) return JSON.parse(raw) as { key: SortKey; asc: boolean };
    } catch {
      /* the default below */
    }
    return { key: 'name', asc: true };
  });
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [projectFolders, setProjectFolders] = useState<string[]>([]);
  const [taskFolders, setTaskFolders] = useState<Record<number, string[]>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const anchor = useRef<string | null>(null);
  // A file to select once its folder is open (focusKey).
  const pendingFocus = useRef<string | null>(null);
  const [renaming, setRenaming] = useState<{ key: string; draft: string } | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [storageOpen, setStorageOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menu = useContextMenu();
  const canOpen = isTauri() && !isMobilePlatform();
  const err = (e: unknown) => setMsg(errText(e));

  // Narrow (the task side pane): the details stack above the list instead of a pane.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setNarrow(e.contentRect.width < 680));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const names = useMemo(() => new Map(members.map((m) => [m.user_id, m.display_name || m.username])), [members]);
  const segs = useMemo(() => (taskMode ? new Map<number, string>() : taskSegments(entries ?? [])), [entries, taskMode]);
  const segTask = useMemo(() => new Map([...segs].map(([id, s]) => [s, id])), [segs]);

  /** Where a file sits in this browser's tree. */
  const treePath = useCallback(
    (e: FileEntry) => {
      const own = e.relPath || e.name;
      if (taskMode || e.kind === 'project' || e.taskId == null) return own;
      return `${TASKS}/${segs.get(e.taskId)}/${own}`;
    },
    [segs, taskMode],
  );

  /** The scope and stored folder behind a tree folder; null for the virtual ones. */
  const scopeOf = useCallback(
    (path: string[]): { scope: FolderScope; dir: string } | null => {
      if (taskMode) return { scope: { projectId, taskId }, dir: path.join('/') };
      if (path[0] !== TASKS) return { scope: { projectId }, dir: path.join('/') };
      const tid = path.length > 1 ? segTask.get(path[1]) : undefined;
      return tid == null ? null : { scope: { projectId, taskId: tid }, dir: path.slice(2).join('/') };
    },
    [projectId, taskId, taskMode, segTask],
  );

  const loadFolders = useCallback(() => {
    if (taskMode) {
      listFileFolders({ projectId, taskId })
        .then((f) => setTaskFolders({ [taskId!]: f }))
        .catch(() => {});
    } else {
      listFileFolders({ projectId })
        .then(setProjectFolders)
        .catch(() => setProjectFolders([]));
      setTaskFolders({});
    }
  }, [projectId, taskId, taskMode]);
  useEffect(loadFolders, [loadFolders, reloadKey]);

  // In a project, a task's own (empty) folders load when you open its folder.
  const openTask = !taskMode && cwd[0] === TASKS && cwd.length > 1 ? segTask.get(cwd[1]) : undefined;
  useEffect(() => {
    if (openTask == null || taskFolders[openTask]) return;
    listFileFolders({ projectId, taskId: openTask })
      .then((f) => setTaskFolders((m) => ({ ...m, [openTask]: f })))
      .catch(() => {});
  }, [openTask, projectId, taskFolders]);

  useEffect(() => {
    setCwd([]);
    setSelected(new Set());
    setCursor(null);
  }, [projectId, taskId]);

  // A task folder renamed under us (its title changed) or gone: back to Task files.
  useEffect(() => {
    if (!taskMode && cwd[0] === TASKS && cwd.length > 1 && entries && !segTask.has(cwd[1])) setCwd([TASKS]);
  }, [taskMode, cwd, entries, segTask]);

  // Leaving a folder clears the selection (it pointed at rows no longer shown).
  const cwdKey = cwd.join('/');
  useEffect(() => {
    const want = pendingFocus.current;
    pendingFocus.current = null;
    setSelected(new Set(want ? [want] : []));
    setCursor(want);
    anchor.current = want;
    setNewFolder(null);
    setRenaming(null);
    if (want) requestAnimationFrame(() => listRef.current?.querySelector(`[data-key="${want}"]`)?.scrollIntoView({ block: 'center' }));
  }, [cwdKey]);

  const reloadAll = () => {
    onReload();
    loadFolders();
    if (!taskMode) setTaskFolders({});
  };

  // ── the tree ──────────────────────────────────────────────────────────────

  const allFolders = useMemo(() => {
    const set = new Set<string>();
    const add = (p: string) => {
      const parts = p.split('/');
      for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/'));
    };
    for (const e of entries ?? []) {
      const d = dirOf(treePath(e));
      if (d) add(d);
    }
    if (taskMode) for (const f of taskFolders[taskId!] ?? []) add(f);
    else {
      for (const f of projectFolders) add(f);
      for (const [tid, fs] of Object.entries(taskFolders)) {
        const seg = segs.get(Number(tid));
        if (seg) for (const f of fs) add(`${TASKS}/${seg}/${f}`);
      }
    }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [entries, treePath, taskMode, taskId, taskFolders, projectFolders, segs]);

  const q = query.trim().toLowerCase();
  const filtering = filters.cat !== '' || filters.stored !== '' || filters.ai !== '' || filters.uploader !== '';
  const flat = q.length > 0 || filtering;

  const passes = useCallback(
    (e: FileEntry) =>
      (!q || treePath(e).toLowerCase().includes(q) || (e.taskTitle ?? '').toLowerCase().includes(q)) &&
      (filters.cat === '' || categoryOf(e.name, e.type) === filters.cat) &&
      (filters.stored === '' || (filters.stored === 'host') === e.shared) &&
      (filters.ai === '' || (filters.ai === 'in') === e.aiIncluded) &&
      (filters.uploader === '' || e.uploadedBy === filters.uploader),
    [q, filters, treePath],
  );

  const { folders, files } = useMemo(() => {
    const all = entries ?? [];
    const cmp = (a: FileEntry, b: FileEntry) => {
      const byName = a.name.localeCompare(b.name, undefined, { numeric: true });
      const s =
        sort.key === 'size' ? a.size - b.size || byName
        : sort.key === 'date' ? a.createdAt.localeCompare(b.createdAt) || byName
        : sort.key === 'type' ? extOf(a.name).localeCompare(extOf(b.name)) || byName
        : byName;
      return sort.asc ? s : -s;
    };
    if (flat) return { folders: [] as string[], files: all.filter(passes).sort(cmp) };
    const prefix = cwdKey ? `${cwdKey}/` : '';
    const dirs = new Set<string>();
    const here: FileEntry[] = [];
    for (const e of all) {
      const p = treePath(e);
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      if (rest.includes('/')) dirs.add(rest.slice(0, rest.indexOf('/')));
      else here.push(e);
    }
    for (const f of allFolders) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      if (rest) dirs.add(rest.split('/')[0]);
    }
    // The virtual Task files folder sorts last at the project's root.
    const sorted = [...dirs].sort((a, b) => (a === TASKS ? 1 : b === TASKS ? -1 : a.localeCompare(b, undefined, { numeric: true })));
    return { folders: sorted, files: here.sort(cmp) };
  }, [entries, flat, passes, sort, cwdKey, treePath, allFolders]);

  const byKey = useMemo(() => new Map((entries ?? []).map((e) => [e.key, e])), [entries]);
  const selEntries = useMemo(() => [...selected].map((k) => byKey.get(k)).filter((e): e is FileEntry => !!e), [selected, byKey]);
  const detail = selEntries.length === 1 ? selEntries[0] : null;
  const isVirtual = (path: string[]) => !taskMode && path[0] === TASKS && path.length <= 2;
  const items = useMemo(() => [...folders.map((f) => `d:${f}`), ...files.map((e) => e.key)], [folders, files]);

  /** Every file under a tree folder, sub-folders included. */
  const filesUnder = useCallback(
    (path: string[]) => {
      const prefix = path.length ? `${path.join('/')}/` : '';
      return (entries ?? []).filter((e) => treePath(e).startsWith(prefix));
    },
    [entries, treePath],
  );

  /** What "Share link…" ticks: the selected files, else the folder under the cursor, else
   * the matches of a search, else everything in the open folder. */
  const shareSelection = (): FileEntry[] => {
    if (selEntries.length) return selEntries;
    if (cursor?.startsWith('d:') && !flat) return filesUnder([...cwd, cursor.slice(2)]);
    return flat ? files : filesUnder(cwd);
  };

  // A file named from outside (a /files/<id> link): open its folder, select it, scroll to it.
  useEffect(() => {
    if (!focusKey) return;
    const e = byKey.get(focusKey);
    if (!e) return;
    const d = dirOf(treePath(e));
    setQuery('');
    setFilters(NO_FILTERS);
    const next = d ? d.split('/') : [];
    if (next.join('/') === cwdKey) {
      setSelected(new Set([e.key]));
      setCursor(e.key);
      listRef.current?.querySelector(`[data-key="${e.key}"]`)?.scrollIntoView({ block: 'center' });
    } else {
      // The folder change selects it once the folder is open.
      pendingFocus.current = e.key;
      setCwd(next);
    }
  }, [focusKey, byKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The details preview for one selected image.
  useEffect(() => {
    setPreview(null);
    if (!detail || !detail.shared || !isDrawable(detail.name, detail.type) || detail.size > PREVIEW_CAP) return;
    let made: string | null = null;
    let stale = false;
    daemonFetchBlob(blobPath(detail))
      .then((b) => {
        if (stale) return;
        made = URL.createObjectURL(b);
        setPreview(made);
      })
      .catch(() => {});
    return () => {
      stale = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [detail?.key, detail?.size]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── actions ───────────────────────────────────────────────────────────────

  const download = (e: FileEntry) => {
    if (!e.shared) return;
    void (e.kind === 'project' ? downloadProjectFile(e.id, e.name) : downloadSharedFile(e.id, e.name)).catch(err);
  };
  const open = (e: FileEntry) => {
    if (!e.shared) {
      if (openLocal && hasFilePaths()) openLocal(e);
      return;
    }
    if (!canOpen) return download(e);
    void (e.kind === 'project' ? openProjectFile(e.id, e.name) : openSharedFile(e.id, e.name)).catch(err);
  };
  const canOpenEntry = (e: FileEntry) => (e.shared ? true : !!openLocal && hasFilePaths() && !!e.localPath);

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      await work();
      reloadAll();
    } catch (e) {
      err(e);
    } finally {
      setBusy(false);
    }
  }

  const commitRename = async () => {
    if (!renaming) return;
    const { key, draft } = renaming;
    setRenaming(null);
    const name = draft.trim();
    if (key.startsWith('d:')) {
      const old = key.slice(2);
      const at = scopeOf([...cwd, old]);
      if (!name || name === old || !at) return;
      if (reserved(cwd, name)) return setMsg(`“${TASKS}” is where task attachments show; pick another name.`);
      const parent = dirOf(at.dir);
      await run(() => renameFileFolder(at.scope, at.dir, parent ? `${parent}/${name}` : name));
      return;
    }
    const e = byKey.get(key);
    if (!e || !name || name === e.name) return;
    await run(() => renameFile(e.kind, e.id, name));
  };

  const startRename = (key: string) => {
    if (key.startsWith('d:')) {
      if (isVirtual([...cwd, key.slice(2)])) return;
      setRenaming({ key, draft: key.slice(2) });
      return;
    }
    const e = byKey.get(key);
    if (!e) return;
    setSelected(new Set([key]));
    setCursor(key);
    setRenaming({ key, draft: e.name });
  };

  /** "Task files" at a project's top level is the virtual folder of task attachments. */
  const reserved = (parent: string[], name: string) => !taskMode && parent.length === 0 && name === TASKS;

  const createFolder = async () => {
    const name = (newFolder ?? '').trim();
    setNewFolder(null);
    const at = scopeOf(cwd);
    if (!name || !at) return;
    if (reserved(cwd, name)) return setMsg(`“${TASKS}” is where task attachments show; pick another name.`);
    await run(() => createFileFolder(at.scope, at.dir ? `${at.dir}/${name}` : name));
  };

  const removeFolder = async (name: string) => {
    const at = scopeOf([...cwd, name]);
    if (!at) return;
    if (!(await confirmDialog(`Remove the empty folder "${name}"?`))) return;
    await run(() => deleteFileFolder(at.scope, at.dir));
  };

  /** Where a set of files may move: one scope (the project's files, or one task's). */
  const moveTargets = (targets: FileEntry[]): { scope: FolderScope; dirs: string[] } | null => {
    if (targets.length === 0) return null;
    const first = targets[0];
    const sameScope = targets.every((t) => t.kind === first.kind && (first.kind === 'project' || t.taskId === first.taskId));
    if (!sameScope) return null;
    let scope: FolderScope;
    let dirs: string[];
    if (first.kind === 'project') {
      scope = { projectId };
      dirs = allFolders.filter((f) => f !== TASKS && !f.startsWith(`${TASKS}/`));
    } else if (taskMode) {
      scope = { projectId, taskId };
      dirs = allFolders;
    } else {
      const prefix = `${TASKS}/${segs.get(first.taskId!)}/`;
      scope = { projectId, taskId: first.taskId };
      dirs = allFolders.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
    }
    const here = new Set(targets.map((t) => dirOf(t.relPath || t.name)));
    const opts = ['', ...dirs].filter((d) => !(here.size === 1 && here.has(d)));
    return opts.length ? { scope, dirs: opts } : null;
  };

  const move = (targets: FileEntry[], scope: FolderScope, dir: string) =>
    void run(async () => {
      await moveFilesTo(scope, targets.map((t) => t.id), dir);
      setSelected(new Set());
    });

  const remove = async (targets: FileEntry[]) => {
    if (targets.length === 0) return;
    const one = targets[0];
    const what =
      targets.length > 1
        ? `Delete ${targets.length} files?`
        : one.kind === 'project'
          ? `Delete "${one.name}"? This removes it from the host.`
          : `Delete "${one.name}"? This removes the attachment from its task (and the host copy, if any); a local original on the uploader’s machine is untouched.`;
    if (!(await confirmDialog(what))) return;
    const del = deleteEntry ?? ((e: FileEntry) => (e.kind === 'project' ? deleteProjectFile(e.id) : deleteSharedAttachment(e.id)));
    await run(async () => {
      const failed: string[] = [];
      for (const t of targets) await del(t).catch((e) => failed.push(`${t.name} (${errText(e)})`));
      setSelected(new Set());
      if (failed.length) throw new Error(`Not deleted: ${failed.join('; ')}`);
    });
  };

  /** The AI overview switch. Over the host's size guard it asks, then forces. */
  const setAi = (e: FileEntry, on: boolean) =>
    void run(async () => {
      try {
        await setFileAiIncluded(e.kind, e.id, on);
      } catch (x) {
        if (!on || hostErrorCode(x) !== AI_FILE_TOO_LARGE) throw x;
        if (await confirmDialog(`This file is ${fmtSize(e.size)}; index it anyway? Indexing a file this big can take hours.`)) {
          await setFileAiIncluded(e.kind, e.id, true, true);
        }
      }
    });

  // ── selection and keys ────────────────────────────────────────────────────

  const select = (key: string, ev: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    setRenaming(null);
    const fileKeys = files.map((f) => f.key);
    if (ev.shiftKey && anchor.current && fileKeys.includes(key)) {
      const a = fileKeys.indexOf(anchor.current);
      const b = fileKeys.indexOf(key);
      if (a !== -1) {
        setSelected(new Set(fileKeys.slice(Math.min(a, b), Math.max(a, b) + 1)));
        setCursor(key);
        return;
      }
    }
    if (ev.metaKey || ev.ctrlKey) {
      const next = new Set(selected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setSelected(next);
      anchor.current = key;
      setCursor(key);
      return;
    }
    setSelected(new Set([key]));
    anchor.current = key;
    setCursor(key);
  };

  const enter = (key: string) => {
    if (key.startsWith('d:')) setCwd(flat ? cwd : [...cwd, key.slice(2)]);
    else {
      const e = byKey.get(key);
      if (e && canOpenEntry(e)) open(e);
    }
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if ((ev.target as HTMLElement).closest('input, textarea, select')) return;
    const i = cursor ? items.indexOf(cursor) : -1;
    let cols = 1;
    if (view === 'grid' && listRef.current) {
      const grid = listRef.current.querySelector<HTMLElement>('[data-grid]');
      if (grid) cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length);
    }
    const go = (j: number) => {
      const k = items[Math.max(0, Math.min(items.length - 1, j))];
      if (!k) return;
      if (k.startsWith('d:')) {
        setSelected(new Set());
        setCursor(k);
      } else select(k, { shiftKey: ev.shiftKey, metaKey: false, ctrlKey: false });
      listRef.current?.querySelector(`[data-key="${CSS.escape(k)}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    if ((ev.metaKey || ev.altKey) && ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (cwd.length) setCwd(cwd.slice(0, -1));
      return;
    }
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        go(i < 0 ? 0 : i + cols);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        go(i < 0 ? 0 : i - cols);
        break;
      case 'ArrowRight':
        if (view !== 'grid') return;
        ev.preventDefault();
        go(i + 1);
        break;
      case 'ArrowLeft':
        if (view !== 'grid') return;
        ev.preventDefault();
        go(i - 1);
        break;
      case 'Enter':
        if (cursor) {
          ev.preventDefault();
          enter(cursor);
        }
        break;
      case 'F2':
        if (cursor) {
          ev.preventDefault();
          startRename(cursor);
        }
        break;
      case 'Delete':
      case 'Backspace':
        if (ev.key === 'Backspace' && !ev.metaKey) return;
        if (selEntries.length) {
          ev.preventDefault();
          void remove(selEntries);
        }
        break;
      case 'Escape':
        setSelected(new Set());
        setCursor(null);
        break;
      case 'a':
        if (ev.metaKey || ev.ctrlKey) {
          ev.preventDefault();
          setSelected(new Set(files.map((f) => f.key)));
        }
        break;
    }
  };

  // ── menus ─────────────────────────────────────────────────────────────────

  const entryMenu = (e: FileEntry): MenuItem[] => {
    const targets = selected.has(e.key) && selected.size > 1 ? selEntries : [e];
    const many = targets.length > 1;
    const items: MenuItem[] = [];
    if (!many && canOpenEntry(e)) items.push({ label: 'Open', icon: '↗', onClick: () => open(e) });
    const downloadable = targets.filter((t) => t.shared);
    if (downloadable.length) {
      items.push({ label: many ? `Download ${downloadable.length} files` : 'Download', icon: '⇩', onClick: () => downloadable.forEach(download) });
    }
    if (!many) items.push({ label: 'Rename…', icon: '✏️', onClick: () => startRename(e.key) });
    const mt = moveTargets(targets);
    if (mt) {
      items.push({
        label: many ? `Move ${targets.length} to` : 'Move to',
        icon: '📂',
        children: mt.dirs.map((d) => ({ label: d || '(top level)', onClick: () => move(targets, mt.scope, d) })),
      });
    }
    if (!many && e.taskId != null && !taskMode) {
      items.push({ label: 'Open its task', icon: '☑', onClick: () => void goTask(e) });
    }
    if (onShare) items.push({ label: many ? `Share ${targets.length} files…` : 'Share link…', icon: '🔗', onClick: () => onShare(targets) });
    if (!many) items.push(...(extraMenu?.(e) ?? []));
    items.push({ label: many ? `Delete ${targets.length} files` : 'Delete', icon: '🗑', danger: true, divider: true, onClick: () => void remove(targets) });
    return items;
  };

  const folderMenu = (name: string): MenuItem[] => {
    const share: MenuItem[] = onShare ? [{ label: 'Share link…', icon: '🔗', onClick: () => onShare(filesUnder([...cwd, name])) }] : [];
    if (isVirtual([...cwd, name])) return [{ label: 'Open', icon: '📂', onClick: () => setCwd([...cwd, name]) }, ...share];
    return [
      { label: 'Open', icon: '📂', onClick: () => setCwd([...cwd, name]) },
      ...share,
      { label: 'Rename…', icon: '✏️', onClick: () => startRename(`d:${name}`) },
      { label: 'Remove if empty', icon: '🗑', danger: true, divider: true, onClick: () => void removeFolder(name) },
    ];
  };

  const backgroundMenu = (): MenuItem[] => [
    ...(scopeOf(cwd) ? [{ label: 'New folder…', icon: '📁', onClick: () => setNewFolder('') }] : []),
    { label: view === 'list' ? 'Grid view' : 'List view', icon: view === 'list' ? '⊞' : '☰', onClick: () => setViewPersist(view === 'list' ? 'grid' : 'list') },
    { label: 'Refresh', icon: '↻', divider: true, onClick: reloadAll },
  ];

  const goTask = (e: FileEntry) =>
    openInProjectTasks({ id: e.taskId!, project_id: projectId, workspaceId } as Task);

  const setViewPersist = (v: 'list' | 'grid') => {
    setView(v);
    localStorage.setItem(VIEW_KEY, v);
  };
  const setSortPersist = (key: SortKey, asc?: boolean) => {
    setSort((cur) => {
      const next = { key, asc: asc ?? (cur.key === key ? !cur.asc : key === 'name' || key === 'type') };
      localStorage.setItem(SORT_KEY, JSON.stringify(next));
      return next;
    });
  };
  const arrow = (key: SortKey) => (sort.key === key ? (sort.asc ? ' ▲' : ' ▼') : '');

  const uploaders = useMemo(() => {
    const ids = new Set<number>();
    for (const e of entries ?? []) if (e.uploadedBy != null) ids.add(e.uploadedBy);
    return [...ids].map((id) => ({ id, name: names.get(id) ?? `User ${id}` })).sort((a, b) => a.name.localeCompare(b.name));
  }, [entries, names]);

  const uploadTarget = (): UploadTarget | null => {
    const at = scopeOf(cwd);
    return at ? { taskId: at.scope.taskId, dir: at.dir } : null;
  };

  // ── render ────────────────────────────────────────────────────────────────

  const tags = (e: FileEntry) => (
    <>
      {e.aiIncluded && (
        <span className="g-tag g-tag-ok !min-h-[18px] !px-1.5 !text-[10px] shrink-0" title="In the AI overview">
          AI
        </span>
      )}
      {!e.shared && (
        <span className="g-tag !min-h-[18px] !px-1.5 !text-[10px] shrink-0" title="Only on the uploader’s machine: there is no host copy">
          local
        </span>
      )}
      {extraTags?.(e)}
    </>
  );

  const renameField = (key: string, className: string) =>
    renaming?.key === key ? (
      <input
        autoFocus
        value={renaming.draft}
        onChange={(ev) => setRenaming({ key, draft: ev.target.value })}
        onClick={(ev) => ev.stopPropagation()}
        onFocus={(ev) => {
          // Select the name without its extension, as Finder does.
          const v = ev.target.value;
          const dot = key.startsWith('d:') ? -1 : v.lastIndexOf('.');
          ev.target.setSelectionRange(0, dot > 0 ? dot : v.length);
        }}
        onKeyDown={(ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') void commitRename();
          if (ev.key === 'Escape') setRenaming(null);
        }}
        onBlur={() => void commitRename()}
        aria-label="New name"
        className={className}
      />
    ) : null;

  const newFolderRow =
    newFolder !== null ? (
      <div className="flex items-center gap-2.5 px-3 min-h-10 rounded bg-mantle shadow-[inset_0_0_0_1px_var(--color-gold)]">
        <span>📂</span>
        <input
          autoFocus
          value={newFolder}
          onChange={(e) => setNewFolder(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') void createFolder();
            if (e.key === 'Escape') setNewFolder(null);
          }}
          onBlur={() => void createFolder()}
          placeholder="Folder name…"
          aria-label="New folder name"
          className="flex-1 bg-transparent text-sm text-text focus:outline-none placeholder:text-subtext-0"
        />
      </div>
    ) : null;

  const folderLabel = (f: string) => (!taskMode && cwd.length === 0 && f === TASKS ? '📎 Task files' : f);

  const listBody =
    entries == null ? (
      <p className="text-sm text-subtext-0 p-2">Loading…</p>
    ) : view === 'grid' ? (
      <div data-grid className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))' }}>
        {newFolderRow}
        {folders.map((f) => (
          <button
            key={`d:${f}`}
            data-key={`d:${f}`}
            onClick={() => setCwd([...cwd, f])}
            onContextMenu={(ev) => menu.open(ev, folderMenu(f))}
            className={`g-plain flex flex-col items-center gap-1 p-3 hover:!border-gilt-a ${cursor === `d:${f}` ? '!border-gilt-a' : ''}`}
          >
            <span className="text-4xl h-[72px] flex items-center">📂</span>
            {renameField(`d:${f}`, 'g-field g-field-sm w-full text-center') ?? (
              <span className="text-xs text-text truncate w-full text-center">{folderLabel(f)}</span>
            )}
          </button>
        ))}
        {files.map((e) => (
          <button
            key={e.key}
            data-key={e.key}
            onClick={(ev) => select(e.key, ev)}
            onDoubleClick={() => enter(e.key)}
            onContextMenu={(ev) => {
              if (!selected.has(e.key)) select(e.key, ev);
              menu.open(ev, entryMenu(e));
            }}
            title={`${treePath(e)} · ${fmtSize(e.size)}${e.taskTitle && !taskMode ? ` · on “${e.taskTitle}”` : ''}`}
            className={`g-plain flex flex-col items-stretch gap-1 p-2 text-left ${
              selected.has(e.key) ? '!bg-gilt-b !border-gilt-a shadow-[inset_0_0_0_1px_var(--color-gilt-a)]' : 'hover:!border-gilt-a'
            }`}
          >
            {e.shared && isDrawable(e.name, e.type) && e.size <= THUMB_CAP ? (
              <Thumb entry={e} className="h-[84px] rounded bg-mantle" />
            ) : (
              <div className="h-[84px] rounded bg-mantle flex items-center justify-center text-4xl">{iconFor(e.name, e.type)}</div>
            )}
            <span className="text-xs text-text truncate">{flat ? treePath(e) : e.name}</span>
            <span className="flex items-center gap-1 text-[10px] text-subtext-0">
              <span className="flex-1">{fmtSize(e.size)}</span>
              {tags(e)}
            </span>
          </button>
        ))}
      </div>
    ) : (
      <div className="space-y-0.5">
        {newFolderRow}
        {folders.map((f) => (
          <div
            key={`d:${f}`}
            data-key={`d:${f}`}
            role="button"
            tabIndex={-1}
            onClick={() => renaming?.key !== `d:${f}` && setCwd([...cwd, f])}
            onContextMenu={(ev) => menu.open(ev, folderMenu(f))}
            className={`g-row !min-h-10 !py-1.5 cursor-pointer ${cursor === `d:${f}` ? 'g-sel' : ''}`}
          >
            <span className="w-6 text-center">📂</span>
            {renameField(`d:${f}`, `g-field g-field-sm ${NAME_COL}`) ?? (
              <span className={`text-sm font-medium text-text truncate ${NAME_COL}`}>{folderLabel(f)}</span>
            )}
            {/* The same column slots as a file row, so "folder" sits under Size. */}
            {!narrow && <span className="shrink-0 w-28" />}
            {!narrow && <span className="shrink-0 w-14" />}
            <span className="shrink-0 w-20" />
            <span className="text-[11px] text-subtext-0 shrink-0 w-16 text-right">folder</span>
          </div>
        ))}
        {files.map((e) => (
          <div
            key={e.key}
            data-key={e.key}
            role="row"
            aria-selected={selected.has(e.key)}
            onClick={(ev) => select(e.key, ev)}
            onDoubleClick={() => enter(e.key)}
            onContextMenu={(ev) => {
              if (!selected.has(e.key)) select(e.key, ev);
              menu.open(ev, entryMenu(e));
            }}
            className={`g-row !min-h-10 !py-1.5 cursor-pointer select-none ${selected.has(e.key) ? 'g-sel' : ''}`}
          >
            <span className="w-6 text-center shrink-0">{iconFor(e.name, e.type)}</span>
            <span className={`${NAME_COL} flex items-center gap-1.5`}>
              <span className="text-sm text-text truncate">{flat ? treePath(e) : e.name}</span>
              {tags(e)}
            </span>
            {!narrow && (
              <span className="text-[11px] text-subtext-0 shrink-0 w-28 truncate text-right">
                {e.uploadedBy != null ? names.get(e.uploadedBy) ?? '' : ''}
              </span>
            )}
            {!narrow && <span className="text-[11px] text-subtext-0 shrink-0 w-14 text-right uppercase">{extOf(e.name) || '—'}</span>}
            <span className="text-[11px] text-subtext-0 shrink-0 w-20 text-right">{fmtDate(e.createdAt)}</span>
            <span className="text-[11px] text-subtext-0 shrink-0 w-16 text-right tabular-nums">{fmtSize(e.size)}</span>
          </div>
        ))}
      </div>
    );

  const isEmpty = entries != null && folders.length === 0 && files.length === 0 && newFolder === null;
  const list = (
    <div
      ref={listRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="Files"
      className={`min-h-full p-3 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-gold)] rounded ${dragOver ? 'bg-gilt-b' : ''}`}
      onContextMenu={(e) => menu.open(e, backgroundMenu())}
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          setSelected(new Set());
          setCursor(null);
        }
      }}
    >
      {listBody}
      {isEmpty &&
        (flat ? (
          <p className="text-sm text-subtext-0 italic p-2">No files match.</p>
        ) : cwd.length ? (
          <p className="text-sm text-subtext-0 italic p-2">Empty folder.</p>
        ) : (
          empty ?? <p className="text-sm text-subtext-0 italic p-2">No files yet.</p>
        ))}
      {!isEmpty && entries != null && (
        <p className="mt-3 px-1 text-[11px] text-subtext-0">
          Double-click or Enter to open · ⌘/⇧-click to select several · F2 renames · right-click for more.
        </p>
      )}
    </div>
  );

  const target = uploadTarget();
  const toolbar = (
    <div className="shrink-0 flex items-center gap-2 flex-wrap px-3 py-2 border-b border-gilt-b">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
        placeholder="Search names and folders…"
        aria-label="Search files"
        className={`g-field g-field-sm ${narrow ? '!w-full' : '!w-auto basis-32 grow max-w-56 min-w-0'}`}
      />
      <button
        onClick={() => setShowFilters((v) => !v)}
        aria-pressed={showFilters || filtering}
        className={`g-btn g-btn-sm g-btn-ghost ${filtering ? 'g-on' : ''}`}
        title="Filter by type, storage, AI and uploader"
      >
        ⚲ Filter{filtering ? ' •' : ''}
      </button>
      <label className="flex items-center gap-1 text-xs text-subtext-0">
        <span className="sr-only">Sort by</span>
        <select
          value={`${sort.key}:${sort.asc ? 'asc' : 'desc'}`}
          onChange={(e) => {
            const [k, d] = e.target.value.split(':');
            setSortPersist(k as SortKey, d === 'asc');
          }}
          className="g-field g-field-sm !w-auto"
          aria-label="Sort by"
        >
          <option value="name:asc">Name A–Z</option>
          <option value="name:desc">Name Z–A</option>
          <option value="date:desc">Newest</option>
          <option value="date:asc">Oldest</option>
          <option value="size:desc">Largest</option>
          <option value="size:asc">Smallest</option>
          <option value="type:asc">Type</option>
        </select>
      </label>
      <div className="flex rounded overflow-hidden shrink-0 shadow-[inset_0_0_0_1px_var(--color-surface-1)]">
        {(['list', 'grid'] as const).map((v) => (
          <button
            key={v}
            onClick={() => setViewPersist(v)}
            aria-pressed={view === v}
            className={`min-h-8 min-w-8 px-2 text-xs ${view === v ? 'g-on' : 'text-[color:var(--g-fg2)] hover:bg-surface-0 hover:text-text'}`}
            title={v === 'list' ? 'List view' : 'Grid view'}
          >
            {v === 'list' ? '☰' : '⊞'}
          </button>
        ))}
      </div>
      <span className="flex-1" />
      <button
        onClick={() => setNewFolder('')}
        disabled={!scopeOf(cwd) || flat}
        title={scopeOf(cwd) ? 'New folder here' : 'Open a task’s folder to add one there'}
        className="g-btn g-btn-sm g-btn-ghost"
      >
        ＋ New folder
      </button>
      {onUpload && (
        <>
          <button
            onClick={() => target && onUpload(false, target)}
            disabled={!target}
            title={target ? (target.dir ? `Upload into ${target.dir}` : 'Upload files') : 'Open a task’s folder to upload to it'}
            className="g-btn g-btn-sm g-btn-pri"
          >
            Upload files
          </button>
          <button onClick={() => target && onUpload(true, target)} disabled={!target} className="g-btn g-btn-sm g-btn-ghost">
            Upload folder
          </button>
        </>
      )}
      {onShare && (
        <button
          onClick={() => onShare(shareSelection())}
          className="g-btn g-btn-sm g-btn-gilt"
          title={
            selEntries.length
              ? `A public link to the ${selEntries.length === 1 ? 'selected file' : `${selEntries.length} selected files`}`
              : 'A public link to the files in this folder (select files or a folder to narrow it)'
          }
        >
          Share link…
        </button>
      )}
      {actions}
    </div>
  );

  const filterBar = (showFilters || filtering) && (
    <div className="shrink-0 flex items-center gap-2 flex-wrap px-3 py-2 border-b border-gilt-b text-xs text-subtext-0">
      <div className="g-seg flex-wrap" role="group" aria-label="Type">
        <button className="g-chip" aria-pressed={filters.cat === ''} onClick={() => setFilters({ ...filters, cat: '' })}>
          All types
        </button>
        {CATEGORIES.map((c) => (
          <button key={c.id} className="g-chip" aria-pressed={filters.cat === c.id} onClick={() => setFilters({ ...filters, cat: filters.cat === c.id ? '' : c.id })}>
            {c.label}
          </button>
        ))}
      </div>
      <select
        value={filters.stored}
        onChange={(e) => setFilters({ ...filters, stored: e.target.value as Stored })}
        className="g-field g-field-sm !w-auto"
        aria-label="Where it's stored"
      >
        <option value="">Stored anywhere</option>
        <option value="host">On the host</option>
        <option value="device">This device only</option>
      </select>
      <select value={filters.ai} onChange={(e) => setFilters({ ...filters, ai: e.target.value as Ai })} className="g-field g-field-sm !w-auto" aria-label="AI overview">
        <option value="">AI: any</option>
        <option value="in">In the AI overview</option>
        <option value="out">Left out of it</option>
      </select>
      <select
        value={filters.uploader}
        onChange={(e) => setFilters({ ...filters, uploader: e.target.value ? Number(e.target.value) : '' })}
        className="g-field g-field-sm !w-auto"
        aria-label="Uploader"
      >
        <option value="">Anyone</option>
        {uploaders.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </select>
      {filtering && (
        <button onClick={() => setFilters(NO_FILTERS)} className="g-lnk">
          Clear filters
        </button>
      )}
    </div>
  );

  const crumbs = (
    <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 text-sm min-w-0 overflow-x-auto border-b border-gilt-b">
      {flat ? (
        <span className="text-subtext-0 text-xs py-1">
          {files.length} match{files.length === 1 ? '' : 'es'} across {rootLabel}
        </span>
      ) : (
        <>
          <button
            onClick={() => setCwd([])}
            className={`shrink-0 min-h-8 px-1.5 rounded hover:bg-surface-0 ${cwd.length === 0 ? 'text-gold font-semibold' : 'text-[color:var(--g-fg2)]'}`}
          >
            {rootLabel}
          </button>
          {cwd.map((seg, i) => (
            <span key={i} className="flex items-center gap-1 shrink-0">
              <span className="text-subtext-0">/</span>
              <button
                onClick={() => setCwd(cwd.slice(0, i + 1))}
                className={`min-h-8 px-1.5 rounded hover:bg-surface-0 ${i === cwd.length - 1 ? 'text-gold font-semibold' : 'text-[color:var(--g-fg2)]'}`}
              >
                {seg}
              </button>
            </span>
          ))}
          <span className="flex-1" />
          <span className="text-[11px] text-subtext-0 shrink-0">
            {files.length} file{files.length === 1 ? '' : 's'}
            {folders.length ? ` · ${folders.length} folder${folders.length === 1 ? '' : 's'}` : ''}
          </span>
        </>
      )}
      {!taskMode && canManage && (
        <button
          onClick={() => setStorageOpen(true)}
          className="g-lnk shrink-0 !text-xs ml-2"
          title="Where this project’s file bytes live on the host"
        >
          🗂 Storage folder
        </button>
      )}
    </div>
  );

  const header = view === 'list' && !narrow && (
    <div className="shrink-0 flex items-center gap-2.5 px-6 py-1.5 border-b border-gilt-b g-deco text-[10px] font-semibold tracking-[0.18em] text-[color:var(--g-mut)] select-none">
      <span className="w-6" />
      <button onClick={() => setSortPersist('name')} className={`${NAME_COL} text-left hover:text-text`}>
        Name{arrow('name')}
      </button>
      <span className="w-28 text-right">Uploader</span>
      <button onClick={() => setSortPersist('type')} className="w-14 text-right hover:text-text">
        Kind{arrow('type')}
      </button>
      <button onClick={() => setSortPersist('date')} className="w-20 text-right hover:text-text">
        Added{arrow('date')}
      </button>
      <button onClick={() => setSortPersist('size')} className="w-16 text-right hover:text-text">
        Size{arrow('size')}
      </button>
    </div>
  );

  const panelOpen = selEntries.length > 0;
  const details = panelOpen && (
    <DetailsBody
      entries={selEntries}
      preview={preview}
      busy={busy}
      taskMode={taskMode}
      uploaderName={(id) => (id == null ? '—' : names.get(id) ?? `User ${id}`)}
      folderOf={(e) => dirOf(e.relPath || '') || '(top level)'}
      renameInput={(e) => renameField(e.key, 'g-field g-field-sm mt-2 w-full text-center')}
      onStartRename={(e) => startRename(e.key)}
      canOpen={canOpenEntry}
      onOpen={open}
      onDownload={download}
      moveTargets={moveTargets}
      onMove={move}
      onDelete={(t) => void remove(t)}
      onAi={setAi}
      onGoTask={(e) => void goTask(e)}
      onShare={onShare}
      onClose={() => {
        setSelected(new Set());
        setRenaming(null);
      }}
      extra={extraDetails}
    />
  );

  return (
    <div ref={rootRef} className={`flex min-w-0 ${flow ? (panelOpen && !narrow ? 'min-h-[560px]' : '') : 'h-full min-h-0'}`}>
      {menu.element}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {toolbar}
        {filterBar}
        {msg && (
          <div className="shrink-0 px-3 py-1.5 text-xs text-error bg-error/10 border-b border-gilt-b flex items-center gap-2" role="alert">
            <span className="flex-1">{msg}</span>
            <button onClick={() => setMsg(null)} className="g-iconbtn !w-8 !h-8" title="Dismiss">
              ✕
            </button>
          </div>
        )}
        {banner}
        {crumbs}
        {narrow && details && <div className="border-b border-gilt-b bg-base">{details}</div>}
        {header}
        {flow ? list : <ScrollArea className="flex-1">{list}</ScrollArea>}
      </div>
      {!narrow && (
        <ResizablePane
          id="file-details"
          side="right"
          min={260}
          max={520}
          defaultWidth={320}
          collapsible
          collapsed={!panelOpen}
          className="border-l border-gilt-b bg-base"
        >
          {details}
        </ResizablePane>
      )}
      {storageOpen && <StorageFolderModal projectId={projectId} onClose={() => setStorageOpen(false)} />}
    </div>
  );
}

/** The details of one selected file (or a summary of several). */
function DetailsBody({
  entries,
  preview,
  busy,
  taskMode,
  uploaderName,
  folderOf,
  renameInput,
  onStartRename,
  canOpen,
  onOpen,
  onDownload,
  moveTargets,
  onMove,
  onDelete,
  onAi,
  onGoTask,
  onShare,
  onClose,
  extra,
}: {
  entries: FileEntry[];
  preview: string | null;
  busy: boolean;
  taskMode: boolean;
  uploaderName: (id: number | null | undefined) => string;
  folderOf: (e: FileEntry) => string;
  renameInput: (e: FileEntry) => ReactNode;
  onStartRename: (e: FileEntry) => void;
  canOpen: (e: FileEntry) => boolean;
  onOpen: (e: FileEntry) => void;
  onDownload: (e: FileEntry) => void;
  moveTargets: (t: FileEntry[]) => { scope: FolderScope; dirs: string[] } | null;
  onMove: (t: FileEntry[], scope: FolderScope, dir: string) => void;
  onDelete: (t: FileEntry[]) => void;
  onAi: (e: FileEntry, on: boolean) => void;
  onGoTask: (e: FileEntry) => void;
  onShare?: (t: FileEntry[]) => void;
  onClose: () => void;
  extra?: (e: FileEntry) => ReactNode;
}) {
  const one = entries.length === 1 ? entries[0] : null;
  // false = no knowledge engine on the host: the AI overview switch still sets the file's
  // preference, and says it waits for the engine.
  const engine = useKnowledgeEngine();
  const mt = moveTargets(entries);
  const moveSelect = mt && (
    <select
      value=""
      onChange={(ev) => ev.target.value !== '' && onMove(entries, mt.scope, ev.target.value === '/' ? '' : ev.target.value)}
      disabled={busy}
      className="g-field g-field-sm w-full"
      aria-label="Move to a folder"
    >
      <option value="">Move to a folder…</option>
      {mt.dirs.map((d) => (
        <option key={d || '/'} value={d || '/'}>
          {d || '(top level)'}
        </option>
      ))}
    </select>
  );
  const row = (label: string, value: ReactNode, title?: string) => (
    <div className="flex justify-between gap-3">
      <span className="text-subtext-0 shrink-0">{label}</span>
      <span className="text-text truncate text-right" title={title}>
        {value}
      </span>
    </div>
  );

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="g-bar justify-between px-4 h-11 shrink-0">
        <span className="g-stitle">{one ? 'File details' : `${entries.length} files`}</span>
        <button onClick={onClose} className="g-iconbtn !w-8 !h-8" title="Close">
          ✕
        </button>
      </div>
      <ScrollArea className="flex-1" contentClassName="p-4 space-y-4">
        {one ? (
          <>
            <div className="text-center">
              {preview ? (
                <img src={preview} alt={one.name} className="max-h-44 mx-auto rounded border border-gilt-a object-contain" />
              ) : (
                <div className="text-5xl">{iconFor(one.name, one.type)}</div>
              )}
              {renameInput(one) ?? (
                <button
                  onClick={() => onStartRename(one)}
                  className="mt-2 text-sm font-medium text-text break-all hover:text-gold"
                  title="Rename (F2)"
                >
                  {one.name} <span className="text-subtext-0 text-xs">✏️</span>
                </button>
              )}
            </div>
            <div className="space-y-1.5 text-xs">
              {row('Folder', folderOf(one), folderOf(one))}
              {row('Size', fmtSize(one.size))}
              {row('Type', one.type || extOf(one.name).toUpperCase() || '—', one.type ?? undefined)}
              {row('Added', new Date(one.createdAt).toLocaleString())}
              {row('Uploader', uploaderName(one.uploadedBy))}
              {one.kind === 'attachment' &&
                !taskMode &&
                row(
                  'Task',
                  <button onClick={() => onGoTask(one)} className="g-lnk !px-0 !min-h-0 truncate max-w-full" title={one.taskTitle}>
                    {one.taskTitle || 'Untitled task'} ↗
                  </button>,
                )}
              {row('Stored', one.shared ? 'On the host' : 'Only on the uploader’s machine')}
            </div>
            <div className="g-inset !px-3 !py-2.5 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p id={`ai-${one.key}`} className="text-[13px] font-semibold text-text">
                  AI overview
                </p>
                <p className="text-[11px] text-subtext-0">
                  {!one.shared
                    ? 'Push it to the host first: the AI reads host copies.'
                    : engine === false
                      ? `${one.aiIncluded ? 'Included' : 'Left out'}. Takes effect once the knowledge engine is set up.`
                      : one.aiIncluded
                        ? 'The project’s AI reads this file.'
                        : 'Left out: the AI doesn’t read it.'}
                </p>
              </div>
              <button
                role="switch"
                aria-checked={one.aiIncluded}
                aria-labelledby={`ai-${one.key}`}
                disabled={busy || !one.shared}
                onClick={() => onAi(one, !one.aiIncluded)}
                className="g-tog"
              >
                <span className="g-tog-k" />
              </button>
            </div>
            {extra?.(one)}
          </>
        ) : (
          <div className="text-center py-3">
            <div className="text-4xl mb-2">🗂</div>
            <div className="text-xs text-subtext-0">{fmtSize(entries.reduce((n, e) => n + e.size, 0))} in all</div>
          </div>
        )}
        {moveSelect}
      </ScrollArea>
      <div className="shrink-0 border-t border-gilt-b p-3 flex flex-wrap gap-2">
        {one && canOpen(one) && (
          <button onClick={() => onOpen(one)} className="g-btn g-btn-sm g-btn-pri flex-1">
            Open
          </button>
        )}
        {entries.some((e) => e.shared) && (
          <button onClick={() => entries.forEach(onDownload)} className="g-btn g-btn-sm g-btn-ghost flex-1">
            {one ? 'Download' : 'Download all'}
          </button>
        )}
        {onShare && entries.some((e) => e.shared) && (
          <button
            onClick={() => onShare(entries)}
            className="g-btn g-btn-sm g-btn-gilt flex-1"
            title={one ? 'A public link to this file' : 'A public link to these files'}
          >
            Share link…
          </button>
        )}
        <button onClick={() => onDelete(entries)} disabled={busy} className="g-btn g-btn-sm g-btn-danger flex-1">
          {one ? 'Delete' : `Delete ${entries.length}`}
        </button>
      </div>
    </div>
  );
}

/** Where the host keeps this project's file bytes: reveal it here, or show the path on the host. */
function StorageFolderModal({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const [loc, setLoc] = useState<StorageLocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    getStorageLocation(projectId).then(setLoc, (e) => setError(errText(e)));
  }, [projectId]);
  const here = !!loc && (loc.isThisMachine || servingFromThisMachine()) && isTauri() && !isMobilePlatform();
  const reveal = async (path: string) => {
    try {
      await openPath(path);
    } catch {
      // pf/ appears with the first project file; fall back to the root.
      if (loc && path !== loc.root) await openPath(loc.root).catch((e) => setError(errText(e)));
      else setError('That folder doesn’t exist yet.');
    }
  };
  const copy = (path: string) =>
    void navigator.clipboard?.writeText(path).then(() => {
      setCopied(path);
      setTimeout(() => setCopied(null), 1500);
    });
  const line = (label: string, path: string, hint: string) => (
    <div className="space-y-1">
      <div className="g-flbl">{label}</div>
      <div className="flex items-center gap-2">
        <code className="g-inset !py-1.5 !px-2 flex-1 min-w-0 text-xs font-mono text-text break-all">{path}</code>
        {here ? (
          <button onClick={() => void reveal(path)} className="g-btn g-btn-sm g-btn-pri shrink-0">
            Reveal in Finder
          </button>
        ) : (
          <button onClick={() => copy(path)} className="g-btn g-btn-sm g-btn-ghost shrink-0">
            {copied === path ? 'Copied' : 'Copy'}
          </button>
        )}
      </div>
      <p className="text-[11px] text-subtext-0">{hint}</p>
    </div>
  );
  return (
    <Modal onClose={onClose} title="Storage folder" className="w-[620px] max-w-[92vw]">
      <div className="space-y-4 text-sm px-6 pb-6">
        {error && <p className="text-error text-xs">{error}</p>}
        {!loc && !error && <p className="text-subtext-0">Asking the host…</p>}
        {loc && (
          <>
            <p className="text-subtext-1">
              {here ? (
                <>The files are stored on this machine.</>
              ) : (
                <>
                  The files are stored on the host machine, <b className="text-text">{loc.hostName}</b>. Open the path there.
                </>
              )}{' '}
              Each file is kept under its number, not its name; the names and folders you see live in the database.
            </p>
            {loc.projectDir && line('The project’s own files', loc.projectDir, 'Shared by every project on this host, one file per number.')}
            {line('Task attachments', loc.root, 'Attachments are the numbered files at the top of this folder.')}
          </>
        )}
        <div className="flex justify-end">
          <button onClick={onClose} className="g-btn g-btn-ghost">
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

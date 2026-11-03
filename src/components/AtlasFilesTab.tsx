import { useEffect, useMemo, useRef, useState } from 'react';
import {
  daemonInvoke,
  listProjectFiles,
  listProjectAttachments,
  listProjectFolders,
  createProjectFolder,
  renameProjectFile,
  moveProjectFiles,
  downloadProjectFile,
  downloadSharedFile,
  openProjectFile,
  openSharedFile,
  daemonFetchBlob,
  revealStorageFolder,
  servingFromThisMachine,
  isTauri,
  isMobilePlatform,
  type ProjectFile,
  type ProjectAttachment,
} from '../lib/daemon';
import type { Project } from '../types';
import { useContextMenu, type MenuItem } from './ContextMenu';
import ScrollArea from './ScrollArea';

// Atlas › Files — the file BROWSER over every project's host-stored files.
// Folder tree from rel_paths + explicit (possibly empty) folders, breadcrumbs,
// sortable columns, list/grid views, multi-select (⌘/⇧-click), rename, move,
// a sliding detail panel with inline image preview, and — on the host
// machine — a "storage folder" button that opens the real on-disk blob store
// (the "where did my 20 GB go" view).
//
// Two kinds of entries: project files (fully manageable) and shared task
// attachments (owned by their task — download/open only).

type Entry = {
  key: string;
  kind: 'project' | 'attachment';
  id: number;
  name: string;
  /** Full library-relative path (folders from rel_path; attachments are flat). */
  relPath: string;
  size: number;
  createdAt: string;
  taskTitle?: string;
};

type SortKey = 'name' | 'type' | 'size' | 'date';

const VIEW_KEY = 'ganban:atlas-files-view';
const SORT_KEY = 'ganban:atlas-files-sort';
const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
const PREVIEW_CAP = 10 * 1024 * 1024;

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

function iconFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (IMG_EXT.includes(ext)) return '🖼️';
  if (ext === 'pdf') return '📕';
  if (['csv', 'xlsx', 'xls', 'tsv'].includes(ext)) return '📊';
  if (['md', 'txt', 'rtf'].includes(ext)) return '📝';
  if (['doc', 'docx'].includes(ext)) return '📄';
  if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return '🗜️';
  if (['mp3', 'wav', 'm4a', 'flac'].includes(ext)) return '🎵';
  if (['mp4', 'mov', 'mkv', 'avi'].includes(ext)) return '🎬';
  if (['py', 'rs', 'ts', 'tsx', 'js', 'json', 'toml', 'yaml', 'yml', 'ipynb'].includes(ext)) return '⌨️';
  return '📄';
}

/** Kind used for the Type column + sorting — the lowercased extension. */
function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export default function AtlasFilesTab() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selPid, setSelPid] = useState<number | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [serverFolders, setServerFolders] = useState<string[]>([]);
  const [cwd, setCwd] = useState<string[]>([]);
  const [view, setView] = useState<'list' | 'grid'>(() => (localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'));
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>(() => {
    try {
      const raw = localStorage.getItem(SORT_KEY);
      if (raw) return JSON.parse(raw) as { key: SortKey; asc: boolean };
    } catch { /* default below */ }
    return { key: 'name', asc: true };
  });
  const [query, setQuery] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  // Selection: keys of selected entries; anchor for ⇧-range selection.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  // Detail panel: the focused entry key (panel slides while non-null).
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string>(''); // draft name; '' = not renaming
  const [renameActive, setRenameActive] = useState(false);
  const [preview, setPreview] = useState<string | null>(null); // object URL
  const [newFolderDraft, setNewFolderDraft] = useState<string | null>(null); // null = row hidden
  const menu = useContextMenu();
  const canOpen = isTauri() && !isMobilePlatform();
  const onHostMachine = servingFromThisMachine();

  useEffect(() => {
    daemonInvoke<Project[]>('get_projects')
      .then((ps) => {
        const active = ps.filter((p) => !p.archived);
        setProjects(active);
        if (active.length > 0) setSelPid((cur) => cur ?? active[0].id);
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
  }, []);

  const refresh = (pid: number) =>
    Promise.all([
      listProjectFiles(pid).catch(() => [] as ProjectFile[]),
      listProjectAttachments(pid).catch(() => [] as ProjectAttachment[]),
      listProjectFolders(pid).catch(() => [] as string[]),
    ]).then(([pf, att, folders]) => {
      const rows: Entry[] = [
        ...pf.map((f): Entry => ({
          key: `p-${f.id}`,
          kind: 'project',
          id: f.id,
          name: f.file_name,
          relPath: f.rel_path || f.file_name,
          size: f.size_bytes,
          createdAt: f.created_at,
        })),
        ...att.filter((a) => a.is_shared).map((a): Entry => ({
          key: `a-${a.id}`,
          kind: 'attachment',
          id: a.id,
          name: a.file_name,
          relPath: a.file_name, // attachments are flat (no folders)
          size: a.storage_size,
          createdAt: a.created_at,
          taskTitle: a.task_title,
        })),
      ];
      setEntries(rows);
      setServerFolders(folders);
    });

  useEffect(() => {
    if (selPid == null) return;
    setEntries(null);
    setCwd([]);
    setSelected(new Set());
    setDetailKey(null);
    void refresh(selPid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selPid]);

  // Leaving a folder clears selection (it referenced things no longer visible).
  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
    setNewFolderDraft(null);
  }, [cwd.join('/')]); // eslint-disable-line react-hooks/exhaustive-deps

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  /** Every known folder path: explicit rows ∪ derived from file rel_paths. */
  const allFolders = useMemo(() => {
    const set = new Set<string>(serverFolders);
    for (const e of entries ?? []) {
      const parts = e.relPath.split('/');
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return [...set].sort();
  }, [entries, serverFolders]);

  // The current folder's contents, sorted per the header state.
  const { folders, files } = useMemo(() => {
    const all = entries ?? [];
    const cmp = (a: Entry, b: Entry) => {
      const s =
        sort.key === 'size' ? a.size - b.size :
        sort.key === 'date' ? a.createdAt.localeCompare(b.createdAt) :
        sort.key === 'type'
          ? extOf(a.name).localeCompare(extOf(b.name)) || a.name.localeCompare(b.name, undefined, { numeric: true })
          : a.name.localeCompare(b.name, undefined, { numeric: true });
      return sort.asc ? s : -s;
    };
    if (searching) {
      return { folders: [] as string[], files: all.filter((e) => e.relPath.toLowerCase().includes(q)).sort(cmp) };
    }
    const prefix = cwd.length ? cwd.join('/') + '/' : '';
    const dirSet = new Set<string>();
    const files: Entry[] = [];
    for (const e of all) {
      if (!e.relPath.startsWith(prefix)) continue;
      const rest = e.relPath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) files.push(e);
      else dirSet.add(rest.slice(0, slash));
    }
    // Explicit folders too (empty ones only exist here).
    for (const f of allFolders) {
      if (!f.startsWith(prefix) || f === cwd.join('/')) continue;
      const rest = f.slice(prefix.length);
      const seg = rest.includes('/') ? rest.slice(0, rest.indexOf('/')) : rest;
      if (seg) dirSet.add(seg);
    }
    files.sort(cmp);
    return { folders: [...dirSet].sort(), files };
  }, [entries, allFolders, cwd, q, searching, sort]);

  const byKey = useMemo(() => new Map((entries ?? []).map((e) => [e.key, e])), [entries]);
  const detail = detailKey ? byKey.get(detailKey) ?? null : null;
  const selEntries = useMemo(() => files.filter((e) => selected.has(e.key)), [files, selected]);

  // Image preview for the focused entry (object URL, revoked on change).
  useEffect(() => {
    setPreview(null);
    if (!detail) return;
    const ext = detail.name.split('.').pop()?.toLowerCase() ?? '';
    if (!IMG_EXT.includes(ext) || detail.size > PREVIEW_CAP) return;
    let url: string | null = null;
    let stale = false;
    const path = detail.kind === 'project' ? `/projects/files/${detail.id}/download` : `/files/${detail.id}`;
    daemonFetchBlob(path)
      .then((blob) => {
        if (stale) return;
        url = URL.createObjectURL(blob);
        setPreview(url);
      })
      .catch(() => { /* no preview — the panel still shows metadata */ });
    return () => {
      stale = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [detailKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── actions ────────────────────────────────────────────────────────────────

  const err = (e: unknown) => setMsg(e instanceof Error ? e.message : String(e));

  const download = (e: Entry) =>
    void (e.kind === 'project' ? downloadProjectFile(e.id, e.name) : downloadSharedFile(e.id, e.name)).catch(err);
  const openFile = (e: Entry) =>
    void (e.kind === 'project' ? openProjectFile(e.id, e.name) : openSharedFile(e.id, e.name)).catch(err);

  const doRename = async () => {
    if (!detail || detail.kind !== 'project') return;
    const name = renaming.trim();
    setRenameActive(false);
    if (!name || name === detail.name || selPid == null) return;
    try {
      await renameProjectFile(detail.id, name);
      await refresh(selPid);
      setMsg(null);
    } catch (e) {
      err(e);
    }
  };

  const doMove = async (targets: Entry[], dir: string) => {
    if (selPid == null) return;
    const ids = targets.filter((t) => t.kind === 'project').map((t) => t.id);
    if (ids.length === 0) return;
    try {
      await moveProjectFiles(selPid, ids, dir);
      await refresh(selPid);
      setSelected(new Set());
      setMsg(null);
    } catch (e) {
      err(e);
    }
  };

  const doCreateFolder = async () => {
    const name = (newFolderDraft ?? '').trim();
    setNewFolderDraft(null);
    if (!name || selPid == null) return;
    try {
      await createProjectFolder(selPid, [...cwd, name].join('/'));
      await refresh(selPid);
      setMsg(null);
    } catch (e) {
      err(e);
    }
  };

  // ── selection ──────────────────────────────────────────────────────────────

  const clickEntry = (e: Entry, ev: React.MouseEvent) => {
    if (ev.shiftKey && anchor.current) {
      const order = files.map((f) => f.key);
      const a = order.indexOf(anchor.current);
      const b = order.indexOf(e.key);
      if (a !== -1 && b !== -1) {
        const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
        setSelected(new Set(range));
        setDetailKey(e.key);
        return;
      }
    }
    if (ev.metaKey || ev.ctrlKey) {
      const next = new Set(selected);
      if (next.has(e.key)) next.delete(e.key);
      else next.add(e.key);
      setSelected(next);
      anchor.current = e.key;
      setDetailKey(next.has(e.key) ? e.key : null);
      return;
    }
    setSelected(new Set([e.key]));
    anchor.current = e.key;
    setDetailKey(e.key);
    setRenameActive(false);
  };

  // ── context menus ──────────────────────────────────────────────────────────

  const moveSubmenu = (targets: Entry[]): MenuItem[] => {
    const here = cwd.join('/');
    const opts: MenuItem[] = [];
    if (here !== '') opts.push({ label: '(root)', onClick: () => void doMove(targets, '') });
    for (const f of allFolders) {
      if (f === here) continue;
      opts.push({ label: f, onClick: () => void doMove(targets, f) });
    }
    return opts;
  };

  const entryMenu = (e: Entry): MenuItem[] => {
    // Right-click inside a multi-selection acts on all of it.
    const targets = selected.has(e.key) && selected.size > 1 ? selEntries : [e];
    const many = targets.length > 1;
    const movable = targets.filter((t) => t.kind === 'project');
    const items: MenuItem[] = [];
    if (!many && canOpen) items.push({ label: 'Open', icon: '↗', onClick: () => openFile(e) });
    items.push({
      label: many ? `Download ${targets.length} files` : 'Download',
      icon: '⇩',
      onClick: () => targets.forEach(download),
    });
    if (!many && e.kind === 'project') {
      items.push({
        label: 'Rename…', icon: '✏️',
        onClick: () => {
          setDetailKey(e.key);
          setRenaming(e.name);
          setRenameActive(true);
        },
      });
    }
    if (movable.length > 0 && moveSubmenu(movable).length > 0) {
      items.push({
        label: many ? `Move ${movable.length} to` : 'Move to',
        icon: '📂',
        children: moveSubmenu(movable),
      });
    }
    if (!many) items.push({ label: 'Copy name', icon: '⧉', onClick: () => void navigator.clipboard?.writeText(e.relPath) });
    return items;
  };

  const backgroundMenu = (): MenuItem[] => [
    { label: 'New folder…', icon: '📁', onClick: () => setNewFolderDraft('') },
    {
      label: 'Sort by', icon: '⇅',
      children: ([['name', 'Name'], ['type', 'Type'], ['size', 'Size'], ['date', 'Date']] as [SortKey, string][]).map(([key, label]) => ({
        label: `${label}${sort.key === key ? (sort.asc ? ' ▲' : ' ▼') : ''}`,
        onClick: () => setSortPersist(key),
      })),
    },
    { label: view === 'list' ? 'Grid view' : 'List view', icon: view === 'list' ? '⊞' : '☰', onClick: () => setViewPersist(view === 'list' ? 'grid' : 'list') },
    { label: 'Refresh', icon: '↻', divider: true, onClick: () => { if (selPid != null) void refresh(selPid); } },
  ];

  const setViewPersist = (v: 'list' | 'grid') => {
    setView(v);
    localStorage.setItem(VIEW_KEY, v);
  };
  const setSortPersist = (key: SortKey) => {
    setSort((cur) => {
      const next = cur.key === key ? { key, asc: !cur.asc } : { key, asc: key === 'name' };
      localStorage.setItem(SORT_KEY, JSON.stringify(next));
      return next;
    });
  };

  const project = projects.find((p) => p.id === selPid) ?? null;

  const sortArrow = (key: SortKey) => (sort.key === key ? (sort.asc ? ' ▲' : ' ▼') : '');

  // ── render ─────────────────────────────────────────────────────────────────

  const renderNewFolderRow = () =>
    newFolderDraft !== null && (
      <div className="flex items-center gap-2.5 px-2.5 py-1.5 rounded bg-mantle border border-gold">
        <span>📂</span>
        <input
          autoFocus
          value={newFolderDraft}
          onChange={(e) => setNewFolderDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void doCreateFolder();
            if (e.key === 'Escape') setNewFolderDraft(null);
          }}
          onBlur={() => void doCreateFolder()}
          placeholder="Folder name…"
          className="flex-1 bg-transparent text-sm text-text focus:outline-none placeholder:text-subtext-0"
        />
      </div>
    );

  return (
    <div className="h-full flex min-h-0">
      {menu.element}
      {/* LEFT: projects */}
      <div className="w-56 xl:w-64 shrink-0 border-r border-gilt-b bg-crust flex flex-col min-h-0">
        <div className="px-3 py-3 border-b border-gilt-b">
          <span className="g-deco text-[11px] font-semibold text-gold">Projects</span>
        </div>
        <ScrollArea className="flex-1" contentClassName="p-2 space-y-0.5">
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelPid(p.id)}
              aria-current={selPid === p.id ? 'true' : undefined}
              className={`w-full text-left min-h-9 px-3 py-1.5 rounded text-sm font-medium truncate ${
                selPid === p.id ? 'g-sel text-text' : 'text-[color:var(--g-fg2)] hover:bg-surface-0 hover:text-text'
              }`}
            >
              📁 {p.name}
            </button>
          ))}
          {projects.length === 0 && <p className="p-2 text-xs text-subtext-0 italic">No projects.</p>}
        </ScrollArea>
        {onHostMachine && (
          <div className="p-2 border-t border-gilt-b">
            <button
              onClick={() => void revealStorageFolder().catch(err)}
              title="Open the on-disk blob store (all projects' file bytes live here — the real disk usage)"
              className="w-full min-h-8 px-2.5 text-xs text-[color:var(--g-fg2)] hover:text-text hover:bg-surface-0 rounded text-left"
            >
              🗂 Open storage folder…
            </button>
          </div>
        )}
      </div>

      {/* MIDDLE: the browser */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0 bg-mantle">
        {/* toolbar: breadcrumbs + search + new folder + view toggle */}
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-gilt-b bg-base">
          <div className="flex items-center gap-1 text-sm min-w-0 flex-1 overflow-x-auto">
            <button
              onClick={() => setCwd([])}
              className={`shrink-0 min-h-8 px-1.5 rounded hover:bg-surface-0 ${cwd.length === 0 ? 'text-gold font-semibold' : 'text-[color:var(--g-fg2)]'}`}
            >
              {project?.name ?? '—'}
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
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search this project…"
            className="g-field g-field-sm !w-48"
          />
          <button
            onClick={() => setNewFolderDraft('')}
            title="New folder"
            className="g-btn g-btn-ghost g-btn-sm shrink-0"
          >
            ＋ 📁
          </button>
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
        </div>

        {msg && (
          <div className="px-4 py-1.5 text-xs text-error bg-error/10 border-b border-gilt-b flex items-center gap-2">
            <span className="flex-1">{msg}</span>
            <button onClick={() => setMsg(null)} className="g-iconbtn !w-8 !h-8">✕</button>
          </div>
        )}

        {/* column headers (list view) — THE sorting surface */}
        {view === 'list' && (
          <div className="shrink-0 flex items-center gap-2.5 px-6 py-1.5 border-b border-gilt-b g-deco text-[10px] font-semibold tracking-[0.18em] text-[color:var(--g-mut)] select-none">
            <span className="w-5" />
            <button onClick={() => setSortPersist('name')} className="flex-1 text-left hover:text-text">Name{sortArrow('name')}</button>
            <button onClick={() => setSortPersist('type')} className="w-14 text-right hover:text-text">Kind{sortArrow('type')}</button>
            <button onClick={() => setSortPersist('date')} className="w-20 text-right hover:text-text">Added{sortArrow('date')}</button>
            <button onClick={() => setSortPersist('size')} className="w-16 text-right hover:text-text">Size{sortArrow('size')}</button>
          </div>
        )}

        <ScrollArea className="flex-1">
          <div
            className="min-h-full p-3"
            onContextMenu={(e) => {
              // Only the empty space — entries stopPropagation via their own handler.
              menu.open(e, backgroundMenu());
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setSelected(new Set());
                setDetailKey(null);
              }
            }}
          >
            {entries == null ? (
              <p className="text-sm text-subtext-0 p-2">Loading…</p>
            ) : view === 'grid' ? (
              <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))' }}>
                {renderNewFolderRow()}
                {!searching && folders.map((f) => (
                  <button
                    key={`d-${f}`}
                    onClick={() => setCwd([...cwd, f])}
                    className="g-plain g-glint flex flex-col items-center gap-1 p-3 hover:!border-gilt-a"
                  >
                    <span className="text-3xl">📂</span>
                    <span className="text-xs text-text truncate w-full text-center">{f}</span>
                  </button>
                ))}
                {files.map((e) => (
                  <button
                    key={e.key}
                    onClick={(ev) => clickEntry(e, ev)}
                    onDoubleClick={() => (canOpen ? openFile(e) : download(e))}
                    onContextMenu={(ev) => {
                      if (!selected.has(e.key)) clickEntry(e, ev);
                      menu.open(ev, entryMenu(e));
                    }}
                    title={`${e.relPath} · ${fmtSize(e.size)}${e.taskTitle ? ` · on “${e.taskTitle}”` : ''}`}
                    className={`g-plain g-glint flex flex-col items-center gap-1 p-3 ${
                      selected.has(e.key) ? '!bg-gilt-b !border-gilt-a shadow-[inset_0_0_0_1px_var(--color-gilt-a)]' : 'hover:!border-gilt-a'
                    }`}
                  >
                    <span className="text-3xl">{iconFor(e.name)}</span>
                    <span className="text-xs text-text truncate w-full text-center">{e.name}</span>
                    <span className="text-[10px] text-subtext-0">{fmtSize(e.size)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-0.5">
                {renderNewFolderRow()}
                {!searching && folders.map((f) => (
                  <button
                    key={`d-${f}`}
                    onClick={() => setCwd([...cwd, f])}
                    className="w-full flex items-center gap-2.5 min-h-10 px-3 py-2 rounded hover:bg-surface-0 text-left"
                  >
                    <span>📂</span>
                    <span className="text-sm font-medium text-text truncate flex-1">{f}</span>
                    <span className="text-[11px] text-subtext-0">folder</span>
                  </button>
                ))}
                {files.map((e) => (
                  <button
                    key={e.key}
                    onClick={(ev) => clickEntry(e, ev)}
                    onDoubleClick={() => (canOpen ? openFile(e) : download(e))}
                    onContextMenu={(ev) => {
                      if (!selected.has(e.key)) clickEntry(e, ev);
                      menu.open(ev, entryMenu(e));
                    }}
                    className={`w-full flex items-center gap-2.5 min-h-10 px-3 py-2 rounded text-left ${
                      selected.has(e.key) ? 'g-sel' : 'hover:bg-surface-0'
                    }`}
                  >
                    <span>{iconFor(e.name)}</span>
                    <span className="text-sm text-text truncate flex-1">
                      {searching ? e.relPath : e.name}
                      {e.taskTitle && <span className="text-subtext-0 text-xs"> · 📎 {e.taskTitle}</span>}
                    </span>
                    <span className="text-[11px] text-subtext-0 shrink-0 w-14 text-right uppercase">{extOf(e.name) || '—'}</span>
                    <span className="text-[11px] text-subtext-0 shrink-0 w-20 text-right">{fmtDate(e.createdAt)}</span>
                    <span className="text-[11px] text-subtext-0 shrink-0 w-16 text-right">{fmtSize(e.size)}</span>
                  </button>
                ))}
              </div>
            )}
            {entries != null && folders.length === 0 && files.length === 0 && newFolderDraft === null && (
              <p className="text-sm text-subtext-0 italic p-2">
                {searching ? 'No matches.' : cwd.length ? 'Empty folder.' : 'No host-stored files in this project.'}
              </p>
            )}
            <p className="mt-3 text-[11px] text-subtext-0">
              Double-click to {canOpen ? 'open' : 'download'} · ⌘/⇧-click to multi-select · right-click for options.
            </p>
          </div>
        </ScrollArea>
      </div>

      {/* RIGHT: sliding detail panel */}
      <div
        className={`shrink-0 border-l border-gilt-b bg-base overflow-hidden transition-all duration-200 ${
          detail || selEntries.length > 1 ? 'w-72' : 'w-0 border-l-0'
        }`}
      >
        {(detail || selEntries.length > 1) && (
          <div className="w-72 h-full flex flex-col min-h-0">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gilt-b">
              <span className="g-deco text-[11px] font-semibold text-gold">File details</span>
              <button
                onClick={() => { setDetailKey(null); setSelected(new Set()); setRenameActive(false); }}
                className="g-iconbtn !w-8 !h-8"
              >
                ✕
              </button>
            </div>
            <ScrollArea className="flex-1 p-4">
              {selEntries.length > 1 ? (
                <div className="space-y-4">
                  <div className="text-center py-4">
                    <div className="text-4xl mb-2">🗂</div>
                    <div className="text-sm font-medium text-text">{selEntries.length} files selected</div>
                    <div className="text-xs text-subtext-0 mt-1">{fmtSize(selEntries.reduce((s, e) => s + e.size, 0))} total</div>
                  </div>
                  <button
                    onClick={() => selEntries.forEach(download)}
                    className="g-btn g-btn-ghost g-btn-sm w-full"
                  >
                    ⇩ Download all
                  </button>
                  {selEntries.some((e) => e.kind === 'project') && allFolders.length > 0 && (
                    <div className="space-y-1">
                      <div className="g-deco text-[10px] font-semibold text-gold">Move to</div>
                      {cwd.length > 0 && (
                        <button onClick={() => void doMove(selEntries, '')} className="w-full text-left min-h-8 px-2.5 text-xs rounded text-[color:var(--g-fg2)] hover:bg-surface-0 hover:text-text">
                          (root)
                        </button>
                      )}
                      {allFolders.filter((f) => f !== cwd.join('/')).map((f) => (
                        <button key={f} onClick={() => void doMove(selEntries, f)} className="w-full text-left min-h-8 px-2.5 text-xs rounded text-[color:var(--g-fg2)] hover:bg-surface-0 hover:text-text truncate">
                          📂 {f}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : detail ? (
                <div className="space-y-4">
                  <div className="text-center py-2">
                    {preview ? (
                      <img src={preview} alt={detail.name} className="max-h-40 mx-auto rounded border border-gilt-a object-contain" />
                    ) : (
                      <div className="text-5xl">{iconFor(detail.name)}</div>
                    )}
                    {renameActive && detail.kind === 'project' ? (
                      <input
                        autoFocus
                        value={renaming}
                        onChange={(e) => setRenaming(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void doRename();
                          if (e.key === 'Escape') setRenameActive(false);
                        }}
                        onBlur={() => void doRename()}
                        className="g-field g-field-sm mt-2 w-full text-center"
                      />
                    ) : (
                      <div
                        className="mt-2 text-sm font-medium text-text break-all"
                        onDoubleClick={() => {
                          if (detail.kind === 'project') {
                            setRenaming(detail.name);
                            setRenameActive(true);
                          }
                        }}
                        title={detail.kind === 'project' ? 'Double-click to rename' : undefined}
                      >
                        {detail.name}
                      </div>
                    )}
                    <span className={`g-tag mt-1.5 !min-h-[20px] !px-2 !text-[10px] ${detail.kind === 'project' ? '!bg-primary/15 !text-primary' : ''}`}>
                      {detail.kind === 'project' ? 'project file' : 'task attachment'}
                    </span>
                  </div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between"><span className="text-subtext-0">Size</span><span className="text-text">{fmtSize(detail.size)}</span></div>
                    <div className="flex justify-between"><span className="text-subtext-0">Added</span><span className="text-text">{fmtDate(detail.createdAt)}</span></div>
                    {detail.relPath.includes('/') && (
                      <div className="flex justify-between gap-2"><span className="text-subtext-0 shrink-0">Folder</span><span className="text-text truncate">{detail.relPath.slice(0, detail.relPath.lastIndexOf('/'))}</span></div>
                    )}
                    {detail.taskTitle && (
                      <div className="flex justify-between gap-2"><span className="text-subtext-0 shrink-0">Task</span><span className="text-text truncate">📎 {detail.taskTitle}</span></div>
                    )}
                    <div className="flex justify-between gap-2"><span className="text-subtext-0 shrink-0">Project</span><span className="text-text truncate">{project?.name ?? '—'}</span></div>
                  </div>
                  <div className="space-y-1.5 pt-3 border-t border-gilt-b">
                    {canOpen && (
                      <button onClick={() => openFile(detail)} className="g-btn g-btn-pri g-btn-sm w-full">
                        Open
                      </button>
                    )}
                    <button onClick={() => download(detail)} className="g-btn g-btn-ghost g-btn-sm w-full">
                      Download
                    </button>
                    {detail.kind === 'project' && (
                      <button
                        onClick={() => { setRenaming(detail.name); setRenameActive(true); }}
                        className="g-btn g-btn-ghost g-btn-sm w-full"
                      >
                        Rename
                      </button>
                    )}
                    {detail.kind === 'attachment' && (
                      <p className="text-[11px] text-subtext-0">Attachments are managed from their task — rename/move there.</p>
                    )}
                  </div>
                </div>
              ) : null}
            </ScrollArea>
          </div>
        )}
      </div>
    </div>
  );
}

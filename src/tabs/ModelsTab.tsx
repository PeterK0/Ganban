/**
 * Models tab — a build tracker for model kits & miniatures armies.
 *
 * Grew out of the standalone Model_Assembly_Assistant TUI (Gundam kits: boards
 * of numbered parts, build sections that consume them). The uplift:
 *   - Gundam + Warhammer 40K + Age of Sigmar in one domain (kind / faction /
 *     points vs grade / scale).
 *   - A status lifecycle (Backlog → … → Display) shown as a drag shelf.
 *   - Image attachments — model photos, manual scans, paint charts — reusing
 *     the project-files pipeline (upload → link → serve).
 *   - A one-shot nested detail fetch (no N+1), a build log, and a "mark parts"
 *     input that accepts manual shorthand ("A 7 x2, B 3").
 *
 * Drag is pointer-based (WKWebView's HTML5 DnD doesn't fire), the same pattern
 * as Kanban. Scrollbars are the custom ScrollArea (WKWebView's are broken).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  listModelKits, createModelKit, updateModelKit, deleteModelKit, createTask, getTasks,
  getModelKitDetail, createModelBoard, updateModelBoard, deleteModelBoard,
  createModelSection, updateModelSection, deleteModelSection,
  markModelPart, unmarkModelPart, linkModelKitFile, unlinkModelKitFile,
  getModelBuildLog,
} from '../lib/api';
import { uploadProjectFile, fetchProjectFileBytes, isTauri, isMobilePlatform, openProjectFile } from '../lib/daemon';
import { useDataPulse } from '../lib/livePulse';
import { useAppStore } from '../store/appStore';
import ScrollArea from '../components/ScrollArea';
import { useContextMenu, type MenuItem } from '../components/ContextMenu';
import type {
  ModelKit, ModelBoard, ModelSection, ModelKitFile, ModelKitDetail,
  ModelBuildLogEntry, ModelKind, ModelStatus, ModelFileKind, ModelPart,
  CreateModelKitInput,
} from '../types';
import type { PDFDocumentProxy } from 'pdfjs-dist';

const KIND_META: Record<ModelKind, { label: string; icon: string; tint: string }> = {
  gundam: { label: 'Gundam', icon: '🤖', tint: 'border-primary/40 bg-primary/10' },
  '40k': { label: 'Warhammer 40K', icon: '💀', tint: 'border-error/40 bg-error/10' },
  aos: { label: 'Age of Sigmar', icon: '⚡', tint: 'border-warning/40 bg-warning/10' },
  other: { label: 'Other', icon: '🧩', tint: 'border-surface-2 bg-surface-1' },
};

const STATUS_META: Record<ModelStatus, { label: string; dot: string }> = {
  Backlog: { label: 'Backlog', dot: 'bg-overlay-0' },
  'In Progress': { label: 'In Progress', dot: 'bg-primary' },
  Assembled: { label: 'Assembled', dot: 'bg-info' },
  Painted: { label: 'Painted', dot: 'bg-success' },
  Display: { label: 'Display', dot: 'bg-warning' },
  Shelved: { label: 'Shelved', dot: 'bg-subtext-0' },
};
const SHELF_COLUMNS: ModelStatus[] = ['Backlog', 'In Progress', 'Assembled', 'Painted', 'Display', 'Shelved'];

const FILE_KIND_META: Record<ModelFileKind, { label: string; icon: string }> = {
  photo: { label: 'Photos', icon: '📷' },
  manual: { label: 'Manuals', icon: '📖' },
  paint: { label: 'Paints', icon: '🎨' },
};

const GRID_KEY = 'ganban:models-view';

function loadView(): 'grid' | 'shelf' {
  try { return (localStorage.getItem(GRID_KEY) as 'grid' | 'shelf') ?? 'grid'; } catch { return 'grid'; }
}

/** Parse manual shorthand: "A 7 x2, B 3" → [{board:'A',number:7}, …].
 * Mirrors the TUI's _parse_step_input (board letters+digits, optional xN). */
function parsePartsInput(s: string): { board: string; number: number }[] {
  const out: { board: string; number: number }[] = [];
  for (const chunk of s.split(',')) {
    const m = chunk.trim().match(/^([A-Za-z][A-Za-z0-9-]*)\s+(\d+)(?:\s*[xX]\s*(\d+))?/);
    if (!m) continue;
    const board = m[1];
    const number = parseInt(m[2], 10);
    let mult = m[3] ? parseInt(m[3], 10) : 1;
    if (!Number.isFinite(mult) || mult < 1) mult = 1;
    for (let i = 0; i < mult; i++) out.push({ board, number });
  }
  return out;
}

/** Resolve a runner colour (hex or css name) to a usable tint; fallback neutral. */
function boardColor(color?: string | null): string {
  if (!color) return 'var(--color-surface-2)';
  if (/^(#|rgb|hsl)/i.test(color) || color.startsWith('var(')) return color;
  // named colour — let the browser resolve it via a temporary element isn't
  // worth it; pass it through (css named colours are valid in inline styles).
  return color;
}

// --------------------------------------------------------------------------- //
// A project-file image rendered by id (the same blob path MarkdownPreview's
// DaemonImage uses, factored out so the gallery can reuse it).
// --------------------------------------------------------------------------- //
function KitImage({ fileId, alt, className, onClick, style }: {
  fileId: number; alt?: string; className?: string; onClick?: () => void; style?: React.CSSProperties;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false); setUrl(null);
    let active = true; let obj: string | null = null;
    // Model-kit images are PROJECT files (uploaded via uploadProjectFile),
    // NOT task attachments — so fetch from /projects/files/:id/download, not
    // /files/:id (which would 404 and show "cannot locate the file").
    import('../lib/daemon').then(({ getProjectFileBlob }) =>
      getProjectFileBlob(fileId)
        .then((blob) => { if (!active) return; obj = URL.createObjectURL(blob); setUrl(obj); })
        .catch(() => active && setFailed(true))
    );
    return () => { active = false; if (obj) URL.revokeObjectURL(obj); };
  }, [fileId]);
  if (failed) return <div className={`flex items-center justify-center bg-surface-1 text-subtext-0 ${className ?? ''}`}>⚠</div>;
  if (!url) return <div className={`animate-pulse bg-surface-1 ${className ?? ''}`} />;
  return <img src={url} alt={alt} onClick={onClick} className={className} style={style} />;
}

function ProgressBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.round((used / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-surface-0 rounded-full overflow-hidden">
        <div className="h-full bg-gold rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-subtext-0 tabular-nums w-16 text-right">{used}/{total}</span>
    </div>
  );
}

function KindBadge({ kind }: { kind: ModelKind }) {
  const m = KIND_META[kind] ?? KIND_META.other;
  return <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${m.tint}`}>{m.icon} {m.label}</span>;
}

function StatusBadge({ status }: { status: ModelStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.Backlog;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-subtext-0">
      <span className={`w-2 h-2 rounded-full ${m.dot}`} /> {m.label}
    </span>
  );
}

// --------------------------------------------------------------------------- //
// Main tab.
// --------------------------------------------------------------------------- //
export default function ModelsTab({ projectId }: { projectId: number }) {
  const [kits, setKits] = useState<ModelKit[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'grid' | 'shelf'>(loadView);
  const [kindFilter, setKindFilter] = useState<ModelKind | 'all'>('all');
  const [selectedKitId, setSelectedKitId] = useState<number | null>(null);
  const [peekKitId, setPeekKitId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [groupBy, setGroupBy] = useState<'none' | 'status' | 'kind' | 'scale' | 'faction'>(
    () => (localStorage.getItem('ganban:models-group') as 'none' | 'status' | 'kind' | 'scale' | 'faction') || 'none'
  );

  const load = useCallback(async () => {
    try { setKits(await listModelKits(projectId)); }
    finally { setLoading(false); }
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);
  useDataPulse(() => { if (selectedKitId == null) void load(); }, ['models']);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return kits.filter((k) => {
      if (kindFilter !== 'all' && k.kind !== kindFilter) return false;
      if (!q) return true;
      return [k.name, k.grade, k.scale, k.faction, k.status, KIND_META[k.kind].label]
        .some((v) => v && v.toLowerCase().includes(q));
    });
  }, [kits, kindFilter, query]);

  // Grid grouping: sections of kits under a header. Shelf already groups by
  // status structurally, so the picker applies to the grid.
  const groups = useMemo((): { label: string; kits: ModelKit[] }[] => {
    if (groupBy === 'none') return [{ label: '', kits: filtered }];
    const keyOf = (k: ModelKit) =>
      groupBy === 'status' ? STATUS_META[k.status].label :
      groupBy === 'kind' ? KIND_META[k.kind].label :
      groupBy === 'faction' ? k.faction || 'No faction' :
      k.scale || k.grade || 'No scale';
    const map = new Map<string, ModelKit[]>();
    for (const k of filtered) {
      const key = keyOf(k);
      const arr = map.get(key) ?? [];
      arr.push(k);
      map.set(key, arr);
    }
    if (groupBy === 'status') {
      // Lifecycle order, not alphabetical.
      const order = SHELF_COLUMNS.map((st) => STATUS_META[st].label);
      return [...map.entries()]
        .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
        .map(([label, ks]) => ({ label, kits: ks }));
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, ks]) => ({ label, kits: ks }));
  }, [filtered, groupBy]);

  const peekKit = peekKitId != null ? kits.find((k) => k.id === peekKitId) ?? null : null;
  // The last peeked kit stays rendered while the panel's width animates shut —
  // the same gentle slide the task/event editors have (ProjectView pattern).
  const lastPeekRef = useRef<ModelKit | null>(null);
  if (peekKit) lastPeekRef.current = peekKit;
  const renderKit = peekKit ?? lastPeekRef.current;
  const setActiveTask = useAppStore((st) => st.setActiveTask);

  /** Time tracking rides the task machinery: ensure the kit's companion task
   * exists, then make it the ACTIVE task — the header timer does the rest. */
  const trackBuildTime = useCallback(async (kit: ModelKit) => {
    let task = kit.task_id != null
      ? (await getTasks(projectId).catch(() => [])).find((t) => t.id === kit.task_id) ?? null
      : null;
    if (!task) {
      task = await createTask({
        project_id: projectId,
        title: `🛠 ${kit.name}`,
        description: 'Build-time tracker for this model kit (created by My Models).',
        status: 'In Progress',
        priority: 'Low',
      });
      await updateModelKit(kit.id, { task_id: task.id });
      void load();
    }
    setActiveTask(task);
  }, [projectId, load, setActiveTask]);

  if (selectedKitId != null) {
    return <KitDetail kitId={selectedKitId} projectId={projectId} onBack={() => setSelectedKitId(null)} onChanged={load} />;
  }

  return (
    <div className="flex flex-col h-full bg-mantle overflow-hidden min-w-0">
      {/* Toolbar */}
      <div className="flex items-end justify-between gap-3 px-8 pt-6 pb-4 border-b border-gilt-b flex-wrap">
        <div className="flex items-baseline gap-3">
          <h1 className="g-subtitle text-text">Models</h1>
          <span className="text-sm text-[color:var(--g-mut)]">{kits.length} kit{kits.length === 1 ? '' : 's'}</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search kits…"
            className="g-field g-field-sm !w-44"
          />
          {view === 'grid' && (
            <select
              value={groupBy}
              onChange={(e) => {
                const v = e.target.value as typeof groupBy;
                setGroupBy(v);
                localStorage.setItem('ganban:models-group', v);
              }}
              className="g-field g-field-sm !w-auto"
              title="Group kits"
            >
              <option value="none">No grouping</option>
              <option value="status">Group: Status</option>
              <option value="kind">Group: Kind</option>
              <option value="scale">Group: Scale</option>
              <option value="faction">Group: Faction</option>
            </select>
          )}
          <div className="flex items-center gap-0.5 rounded p-0.5 shadow-[inset_0_0_0_1px_var(--color-surface-1)]">
            {([['all', 'All'], ['gundam', 'Gundam'], ['40k', '40K'], ['aos', 'AoS']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setKindFilter(k)}
                aria-pressed={kindFilter === k}
                className={`min-h-8 px-2.5 text-xs font-semibold rounded-sm transition-colors whitespace-nowrap ${
                  kindFilter === k ? 'g-on' : 'text-[color:var(--g-fg2)] hover:bg-surface-0 hover:text-text'
                }`}>
                {label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-0.5 rounded p-0.5 shadow-[inset_0_0_0_1px_var(--color-surface-1)]">
            <button onClick={() => { setView('grid'); localStorage.setItem(GRID_KEY, 'grid'); }}
              aria-pressed={view === 'grid'}
              className={`min-h-8 min-w-8 px-2 text-xs rounded-sm ${view === 'grid' ? 'g-on' : 'text-[color:var(--g-fg2)] hover:bg-surface-0 hover:text-text'}`} title="Grid">▦</button>
            <button onClick={() => { setView('shelf'); localStorage.setItem(GRID_KEY, 'shelf'); }}
              aria-pressed={view === 'shelf'}
              className={`min-h-8 min-w-8 px-2 text-xs rounded-sm ${view === 'shelf' ? 'g-on' : 'text-[color:var(--g-fg2)] hover:bg-surface-0 hover:text-text'}`} title="Shelf">☰</button>
          </div>
          <button onClick={() => setCreating(true)}
            className="g-btn g-btn-pri g-btn-sm flex items-center gap-1.5">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            New Kit
          </button>
        </div>
      </div>

      {creating && (
        <KitCreateForm projectId={projectId} onCancel={() => setCreating(false)}
          onCreated={(k) => { setCreating(false); setSelectedKitId(k.id); void load(); }} />
      )}

      {/* Content + peek live side by side INSIDE the Models space — the peek
          must never overlay app chrome (header clock/profile, other tabs). */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {view === 'grid' || loading || filtered.length === 0 ? (
            <ScrollArea className="flex-1">
              <div className="px-8 py-6 space-y-8">
                {loading ? (
                  <div className="text-subtext-0 text-sm">Loading…</div>
                ) : filtered.length === 0 ? (
                  query ? <p className="text-sm text-subtext-0 italic">No kits match “{query}”.</p> : <EmptyState onCreate={() => setCreating(true)} />
                ) : (
                  groups.map((g) => (
                    <div key={g.label || '·'}>
                      {g.label && (
                        <div className="mb-4">
                          <h2 className="g-h2 !mb-0">{g.label} <span className="n">{g.kits.length}</span></h2>
                        </div>
                      )}
                      <CollectionView
                        kits={g.kits}
                        onOpen={(id) => setSelectedKitId(id)}
                        onPeek={(id) => setPeekKitId(id)}
                        onTrack={(kit) => void trackBuildTime(kit)}
                        onChanged={load}
                      />
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>
          ) : (
            // Kanban-style shelf: click peeks, double-click starts tracking —
            // same gestures as the grid.
            <ShelfView kits={filtered} onOpen={(id) => setPeekKitId(id)} onTrack={(kit) => void trackBuildTime(kit)} onChanged={load} />
          )}
        </div>

        {/* ✕ slides the panel shut (width 20rem → 0) instead of blinking away. */}
        <div
          className={`shrink-0 border-l border-gilt-b bg-base overflow-hidden transition-all duration-200 ${
            peekKit ? 'w-80' : 'w-0 border-l-0'
          }`}
        >
          {renderKit && (
            <div className="w-80 h-full">
              <KitPeek
                kit={renderKit}
                open={peekKit != null}
                onClose={() => setPeekKitId(null)}
                onOpenFull={() => { setPeekKitId(null); setSelectedKitId(renderKit.id); }}
                onTrack={() => trackBuildTime(renderKit)}
                onChanged={load}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="text-center py-20">
      <div className="text-5xl mb-4">🤖</div>
      <h2 className="g-deco text-lg font-semibold text-gold mb-2">No models yet</h2>
      <p className="text-sm text-subtext-0 mb-4">Track Gundam kits, Warhammer armies, and your build progress.</p>
      <button onClick={onCreate} className="g-btn g-btn-pri g-btn-sm">Add your first kit</button>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Collection grid — a scannable card per kit.
// --------------------------------------------------------------------------- //
function CollectionView({ kits, onOpen, onPeek, onTrack, onChanged }: {
  kits: ModelKit[]; onOpen: (id: number) => void; onPeek?: (id: number) => void; onTrack?: (kit: ModelKit) => void; onChanged: () => void;
}) {
  // One shared portal menu for every card — the old per-card dropdown rendered
  // INSIDE the card, whose overflow-hidden (rounded cover crop) clipped it.
  const menu = useContextMenu();

  const kitMenu = (kit: ModelKit): MenuItem[] => [
    ...(onPeek ? [{ label: 'Quick view', icon: '👁', onClick: () => onPeek(kit.id) }] : []),
    { label: 'Open kit', icon: '↗', onClick: () => onOpen(kit.id) },
    ...SHELF_COLUMNS.map((st, i): MenuItem => ({
      label: st === kit.status ? `${STATUS_META[st].label} ✓` : STATUS_META[st].label,
      icon: <span className={`inline-block w-2 h-2 rounded-full ${STATUS_META[st].dot}`} />,
      divider: i === 0,
      onClick: () => {
        if (st !== kit.status) void updateModelKit(kit.id, { status: st }).then(onChanged);
      },
    })),
  ];

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,18rem),1fr))] gap-4">
      {menu.element}
      {kits.map((k) => (
        <KitCard
          key={k.id}
          kit={k}
          onPeek={() => onPeek?.(k.id)}
          onTrack={onTrack ? () => onTrack(k) : undefined}
          openMenu={(e) => menu.open(e, kitMenu(k))}
        />
      ))}
    </div>
  );
}

function KitCard({ kit, onPeek, onTrack, openMenu }: {
  kit: ModelKit; onPeek: () => void; onTrack?: () => void; openMenu: (e: React.MouseEvent) => void;
}) {
  const activeTask = useAppStore((st) => st.activeTask);
  const isActive = kit.task_id != null && activeTask?.id === kit.task_id;
  const [detail, setDetail] = useState<ModelKitDetail | null>(null);
  useEffect(() => {
    let active = true;
    getModelKitDetail(kit.id).then((d) => active && setDetail(d)).catch(() => {});
    return () => { active = false; };
  }, [kit.id, kit.updated_at]);
  const firstPhoto = detail?.files.find((f) => f.kind === 'photo');
  const subtitle = kit.kind === 'gundam'
    ? [kit.grade, kit.scale].filter(Boolean).join(' · ') || 'Gundam kit'
    : [kit.faction, kit.points != null ? `${kit.points} pts` : null].filter(Boolean).join(' · ') || KIND_META[kit.kind].label;

  return (
    <div onClick={onPeek} onDoubleClick={onTrack} onContextMenu={openMenu}
      className={`g-plain g-glint group cursor-pointer overflow-hidden transition-colors ${
        isActive ? '!border-success ring-1 ring-success/40' : 'hover:!border-gilt-a'
      }`}>
      <div className="aspect-video bg-surface-0 relative overflow-hidden">
        {firstPhoto ? (
          <KitImage fileId={firstPhoto.file_id} className="w-full h-full object-cover" style={{ objectPosition: `50% ${kit.cover_focus ?? 50}%` }} />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-4xl opacity-40">{KIND_META[kit.kind].icon}</div>
        )}
        <div className="absolute top-2 left-2"><KindBadge kind={kit.kind} /></div>
        <div className="absolute top-2 right-2 bg-base/80 backdrop-blur px-1.5 py-0.5 rounded"><StatusBadge status={kit.status} /></div>
      </div>
      <div className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[15px] font-semibold text-text truncate">{kit.name}</h3>
          <button
            onClick={(e) => { e.stopPropagation(); openMenu(e); }}
            className="g-iconbtn !w-8 !h-8"
            title="Kit menu"
          >⋯</button>
        </div>
        <p className="text-xs text-subtext-0 truncate">{subtitle}</p>
        {detail && (
          <>
            <ProgressBar used={detail.used_parts} total={detail.total_parts} />
            <div className="flex items-center gap-3 text-[11px] text-subtext-1">
              <span>{detail.boards.length} board{detail.boards.length === 1 ? '' : 's'}</span>
              <span>{detail.sections.length} section{detail.sections.length === 1 ? '' : 's'}</span>
              <span>{detail.files.length} image{detail.files.length === 1 ? '' : 's'}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Kit peek — the slide-over a shelf/grid card opens (like the task/event
// editors): summary + status + cover-focus slider + time tracking, with the
// full editor one more click away.
// --------------------------------------------------------------------------- //

function KitPeek({ kit, open, onClose, onOpenFull, onTrack, onChanged }: {
  kit: ModelKit; open: boolean; onClose: () => void; onOpenFull: () => void; onTrack: () => Promise<void>; onChanged: () => void;
}) {
  const activeTask = useAppStore((st) => st.activeTask);
  const [detail, setDetail] = useState<ModelKitDetail | null>(null);
  // Live focus preview; committed on release (one write per adjust).
  const [focus, setFocus] = useState(kit.cover_focus ?? 50);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setFocus(kit.cover_focus ?? 50);
    let active = true;
    getModelKitDetail(kit.id).then((d) => active && setDetail(d)).catch(() => {});
    return () => { active = false; };
  }, [kit.id, kit.updated_at]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const firstPhoto = detail?.files.find((f) => f.kind === 'photo');
  const subtitle = kit.kind === 'gundam'
    ? [kit.grade, kit.scale].filter(Boolean).join(' · ') || 'Gundam kit'
    : [kit.faction, kit.points != null ? `${kit.points} pts` : null].filter(Boolean).join(' · ') || KIND_META[kit.kind].label;

  const commitFocus = async (v: number) => {
    if (v === (kit.cover_focus ?? 50)) return;
    try { await updateModelKit(kit.id, { cover_focus: v }); onChanged(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const trackTime = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onTrack();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const isActive = kit.task_id != null && activeTask?.id === kit.task_id;

  return (
    <div className="w-80 h-full">
      <div className="w-80 h-full flex flex-col min-h-0">
        <div className="flex items-center justify-between px-4 py-2 border-b border-gilt-b shrink-0">
          <span className="g-deco text-[11px] font-semibold text-gold">Kit details</span>
          <button onClick={onClose} className="g-iconbtn !w-8 !h-8">✕</button>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-4">
            <div className="g-plain overflow-hidden">
              <div className="aspect-video relative">
                {firstPhoto ? (
                  <KitImage fileId={firstPhoto.file_id} className="w-full h-full object-cover" style={{ objectPosition: `50% ${focus}%` }} />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-4xl opacity-40">{KIND_META[kit.kind].icon}</div>
                )}
              </div>
              {firstPhoto && (
                <div className="px-3 py-2 flex items-center gap-2">
                  <span className="text-[10px] text-subtext-0 shrink-0" title="Cover focus — slide until the head stops getting cut off">Focus</span>
                  <input
                    type="range" min={0} max={100} value={focus}
                    onChange={(e) => setFocus(Number(e.target.value))}
                    onPointerUp={() => void commitFocus(focus)}
                    onKeyUp={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') void commitFocus(focus); }}
                    className="flex-1 accent-[var(--color-primary)]"
                  />
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-[17px] font-semibold text-text flex-1 truncate">{kit.name}</h3>
                <KindBadge kind={kit.kind} />
              </div>
              <p className="text-xs text-subtext-0 mt-0.5">{subtitle}</p>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs text-subtext-0">Status</span>
              <StatusSelect kit={kit} onChanged={onChanged} />
            </div>

            {detail && (
              <div className="space-y-2">
                <ProgressBar used={detail.used_parts} total={detail.total_parts} />
                <div className="flex items-center gap-3 text-[11px] text-subtext-1">
                  <span>{detail.boards.length} board{detail.boards.length === 1 ? '' : 's'}</span>
                  <span>{detail.sections.length} section{detail.sections.length === 1 ? '' : 's'}</span>
                  <span>{detail.files.length} image{detail.files.length === 1 ? '' : 's'}</span>
                </div>
              </div>
            )}

            {err && <p className="text-xs text-error">{err}</p>}

            <div className="space-y-1.5 pt-3 border-t border-gilt-b">
              <button onClick={onOpenFull} className="g-btn g-btn-pri g-btn-sm w-full">
                Open kit
              </button>
              <button
                onClick={() => void trackTime()}
                disabled={busy || isActive}
                className="g-btn g-btn-ghost g-btn-sm w-full"
              >
                {isActive ? '⏱ Active — timer in the header' : busy ? 'Setting up…' : '⏱ Track build time'}
              </button>
              <p className="text-[11px] text-subtext-0">
                Tracking uses a companion task (“🛠 {kit.name}”) — start/stop from the header timer; totals live in its time entries.
              </p>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Shelf view — kits grouped by status; drag a card between columns to change
// its status (pointer events, WKWebView-safe, same pattern as Kanban).
// --------------------------------------------------------------------------- //
function ShelfView({ kits, onOpen, onTrack, onChanged }: {
  kits: ModelKit[]; onOpen: (id: number) => void; onTrack?: (kit: ModelKit) => void; onChanged: () => void;
}) {
  const activeTask = useAppStore((st) => st.activeTask);
  // Pointer-event DnD (WKWebView-safe, same architecture as Kanban):
  // pointerdown on a card captures the pointer; pointermove checks a 5px
  // threshold before committing to a drag; elementFromPoint walks the DOM
  // to find the column under the cursor (via data-col-status); pointerup
  // commits the move. A floating ghost follows the cursor.
  const DRAG_THRESHOLD = 5;
  const downRef = useRef<{ kitId: number; x: number; y: number; offsetX: number; offsetY: number; pointerId: number } | null>(null);
  // dragRef (a ref, not state) is the source of truth the move handler reads —
  // a plain `drag` state would be stale inside the async pointermove closure.
  // `drag` state exists only to trigger re-renders (ghost + drop highlight).
  const dragRef = useRef<{ kitId: number; x: number; y: number; offsetX: number; offsetY: number; overStatus: ModelStatus | null } | null>(null);
  const [drag, setDrag] = useState<{ kitId: number; x: number; y: number; offsetX: number; offsetY: number; overStatus: ModelStatus | null } | null>(null);
  const suppressClick = useRef(false);

  const onCardPointerDown = (e: React.PointerEvent, kit: ModelKit) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    downRef.current = {
      kitId: kit.id, x: e.clientX, y: e.clientY,
      offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
      pointerId: e.pointerId,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onCardPointerMove = (e: React.PointerEvent) => {
    const down = downRef.current;
    const d = dragRef.current ?? down;
    if (!d) return;
    if (!dragRef.current) {
      // Still in the threshold phase — check before committing to a drag.
      const dx = e.clientX - down!.x;
      const dy = e.clientY - down!.y;
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      suppressClick.current = true;
      e.preventDefault();
      dragRef.current = {
        kitId: down!.kitId, x: e.clientX, y: e.clientY,
        offsetX: down!.offsetX, offsetY: down!.offsetY,
        overStatus: kits.find((k) => k.id === down!.kitId)?.status ?? null,
      };
      setDrag(dragRef.current);
      downRef.current = null;
    } else {
      // Active drag — preventDefault every move to kill native selection/scroll.
      e.preventDefault();
    }
    // Detect the column under the cursor via elementFromPoint + data-col-status.
    // This runs on EVERY move (after the guard), so overStatus tracks the cursor
    // — without it the drop would always land on the card's original column.
    const el = document.elementFromPoint(e.clientX, e.clientY);
    let status: ModelStatus | null = null;
    let node: Element | null = el;
    while (node) {
      if (node.getAttribute && node.getAttribute('data-col-status')) {
        status = node.getAttribute('data-col-status') as ModelStatus;
        break;
      }
      node = node.parentElement;
    }
    dragRef.current = { ...dragRef.current!, x: e.clientX, y: e.clientY, overStatus: status };
    setDrag(dragRef.current);
  };

  const onCardPointerUp = (e: React.PointerEvent) => {
    downRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d) return;
    const kit = kits.find((k) => k.id === d.kitId);
    if (kit && d.overStatus && d.overStatus !== kit.status) {
      void updateModelKit(d.kitId, { status: d.overStatus }).then(onChanged);
    }
  };

  const draggedKit = drag ? kits.find((k) => k.id === drag.kitId) : null;

  return (
    <div className={`flex-1 flex min-h-0 overflow-hidden relative ${drag ? 'select-none' : ''}`} style={drag ? { userSelect: 'none', WebkitUserSelect: 'none' } : undefined}>
      <ScrollArea direction="horizontal" className="flex-1 bg-mantle">
        <div className="flex gap-3 p-4 h-full min-w-max">
          {SHELF_COLUMNS.map((status) => {
            const colKits = kits.filter((k) => k.status === status);
            const isDropTarget = drag?.overStatus === status;
            return (
              <div key={status} data-col-status={status}
                className={`w-60 shrink-0 flex flex-col rounded border transition-colors ${isDropTarget ? 'border-gold bg-gilt-b ring-2 ring-gilt-a' : 'border-surface-1 bg-crust'}`}>
                <div className={`flex items-center gap-2 px-3 py-2.5 border-b border-gilt-b ${isDropTarget ? 'bg-gilt-b' : ''}`}>
                  <span className={`w-2 h-2 rounded-full ${STATUS_META[status].dot}`} />
                  <span className="g-deco text-[11px] font-semibold text-gold">{STATUS_META[status].label}</span>
                  <span className="ml-auto text-xs text-[color:var(--g-mut)] tabular-nums">{colKits.length}</span>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
                  {colKits.map((k) => {
                    const isDragging = drag?.kitId === k.id;
                    const subtitle = k.kind === 'gundam'
                      ? [k.grade, k.scale].filter(Boolean).join(' ')
                      : k.faction ?? KIND_META[k.kind].label;
                    return (
                      <div key={k.id}
                        onPointerDown={(e) => onCardPointerDown(e, k)}
                        onPointerMove={onCardPointerMove}
                        onPointerUp={onCardPointerUp}
                        onClick={() => { if (!suppressClick.current) onOpen(k.id); suppressClick.current = false; }}
                        onDoubleClick={() => { if (onTrack) onTrack(k); }}
                        className={`p-2.5 rounded border bg-base cursor-pointer transition-colors touch-none select-none ${isDragging ? 'opacity-30' : ''} ${
                          k.task_id != null && activeTask?.id === k.task_id ? 'border-success ring-1 ring-success/40' : 'border-surface-1 hover:border-gilt-a'
                        }`}>
                        <KindBadge kind={k.kind} />
                        <div className="text-sm text-text font-medium truncate mt-1">{k.name}</div>
                        {subtitle && <div className="text-[11px] text-subtext-0 truncate">{subtitle}</div>}
                      </div>
                    );
                  })}
                  {colKits.length === 0 && (
                    <p className="text-center text-xs text-subtext-0 py-6 italic">{isDropTarget ? 'Drop here' : 'Drag a kit here'}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Floating drag ghost */}
      {drag && draggedKit && (
        <div className="fixed pointer-events-none z-[100] p-2.5 rounded border bg-base border-gold shadow-2xl opacity-90"
          style={{ left: drag.x - drag.offsetX, top: drag.y - drag.offsetY, width: 220 }}>
          <KindBadge kind={draggedKit.kind} />
          <div className="text-sm text-text font-medium truncate mt-1">{draggedKit.name}</div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Create form.
// --------------------------------------------------------------------------- //
function KitCreateForm({ projectId, onCancel, onCreated }: {
  projectId: number; onCancel: () => void; onCreated: (k: ModelKit) => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ModelKind>('gundam');
  const [grade, setGrade] = useState('');
  const [scale, setScale] = useState('');
  const [faction, setFaction] = useState('');
  const [points, setPoints] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const input: CreateModelKitInput = {
        project_id: projectId, name: name.trim(), kind,
        grade: grade.trim() || null, scale: scale.trim() || null,
        faction: faction.trim() || null,
        points: points.trim() ? parseInt(points, 10) : null,
      };
      onCreated(await createModelKit(input));
    } finally { setBusy(false); }
  };

  return (
    <div className="max-w-xl mx-auto p-6">
      <div className="g-card g-corners p-6 space-y-4">
        <h2 className="g-h2">New model kit</h2>
        <Field label="Name">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="e.g. RG RX-78-2 Gundam / Space Marines Combat Patrol"
            className="g-field g-field-sm w-full" />
        </Field>
        <Field label="Family">
          <div className="flex gap-2">
            {(Object.keys(KIND_META) as ModelKind[]).map((k) => (
              <button key={k} onClick={() => setKind(k)}
                aria-pressed={kind === k}
                className={`g-btn g-btn-sm ${kind === k ? 'g-btn-gilt' : 'g-btn-ghost'}`}>
                {KIND_META[k].icon} {KIND_META[k].label}
              </button>
            ))}
          </div>
        </Field>
        {kind === 'gundam' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Grade (MG/RG/PG/SD…)"><input value={grade} onChange={(e) => setGrade(e.target.value)} className="g-field g-field-sm w-full" /></Field>
            <Field label="Scale (1/144, 1/100…)"><input value={scale} onChange={(e) => setScale(e.target.value)} className="g-field g-field-sm w-full" /></Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Faction"><input value={faction} onChange={(e) => setFaction(e.target.value)} placeholder="Space Marines / Tyranids…" className="g-field g-field-sm w-full" /></Field>
            <Field label="Points"><input value={points} onChange={(e) => setPoints(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="500" className="g-field g-field-sm w-full" /></Field>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onCancel} className="g-btn g-btn-ghost g-btn-sm">Cancel</button>
          <button onClick={submit} disabled={busy || !name.trim()} className="g-btn g-btn-pri g-btn-sm">{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="g-flbl">{label}</span>{children}</label>;
}

// --------------------------------------------------------------------------- //
// Kit detail — the build workspace.
// --------------------------------------------------------------------------- //
function KitDetail({ kitId, projectId, onBack, onChanged }: {
  kitId: number; projectId: number; onBack: () => void; onChanged: () => void;
}) {
  const [detail, setDetail] = useState<ModelKitDetail | null>(null);
  const [log, setLog] = useState<ModelBuildLogEntry[]>([]);
  const [activeSection, setActiveSection] = useState<number | null>(null);
  const [expandedBoard, setExpandedBoard] = useState<number | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [manualReader, setManualReader] = useState<{ fileId: number; name: string } | null>(null);
  // Desktop: a manual is READ-ONLY — the honest tool is the system PDF
  // viewer in its own window (openProjectFile streams to a temp file in Rust
  // and hands off). pdf.js here is only the web/mobile fallback; the PDF tab
  // keeps pdf.js because an EDITOR genuinely needs it.
  const openManual = (m: { fileId: number; name: string }) => {
    // Captions ("Manual") carry no extension — the OS picks the app by
    // extension, so guarantee .pdf (manuals are PDFs by construction here).
    const name = /\.pdf$/i.test(m.name) ? m.name : `${m.name || 'manual'}.pdf`;
    if (isTauri() && !isMobilePlatform()) void openProjectFile(m.fileId, name);
    else setManualReader(m);
  };

  const reload = useCallback(async () => {
    const [d, l] = await Promise.all([getModelKitDetail(kitId), getModelBuildLog(kitId)]);
    setDetail(d); setLog(l);
  }, [kitId]);

  useEffect(() => { void reload(); }, [reload]);
  useDataPulse(() => void reload(), ['models']);

  if (!detail) return <div className="p-6 text-subtext-0 text-sm">Loading…</div>;
  const { kit, boards, sections, files } = detail;

  const photos = files.filter((f) => f.kind === 'photo');
  const manuals = files.filter((f) => f.kind === 'manual');
  const paints = files.filter((f) => f.kind === 'paint');
  const changed = () => { void reload(); onChanged(); };

  return (
    <div className="flex flex-col h-full bg-mantle overflow-hidden min-w-0">
      {/* Header */}
      <div className="px-8 pt-5 pb-4 border-b border-gilt-b flex items-center gap-3 flex-wrap">
        <button onClick={onBack} className="g-iconbtn" title="Back">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
        </button>
        <KindBadge kind={kit.kind} />
        <h1 className="g-ptitle !text-[30px] !mt-0 text-text">{kit.name}</h1>
        <StatusSelect kit={kit} onChanged={changed} />
        <span className="text-xs text-subtext-0">
          {kit.kind === 'gundam'
            ? [kit.grade, kit.scale].filter(Boolean).join(' · ')
            : [kit.faction, kit.points != null ? `${kit.points} pts` : null].filter(Boolean).join(' · ')}
        </span>
        <div className="ml-auto flex items-center gap-3">
          <div className="w-40"><ProgressBar used={detail.used_parts} total={detail.total_parts} /></div>
          <span className="text-sm font-medium text-text tabular-nums">{detail.percent}%</span>
          <DeleteKit kit={kit} onDeleted={onBack} />
        </div>
      </div>

      {/* Tile dashboard — no top-level tabs; each area is an interactive tile,
          laid out in a responsive grid so the full width is used. The Reference
          tile has its own internal sub-tabs (Photos / Manuals / Paints). */}
      <ScrollArea className="flex-1">
        <div className="px-8 py-6 grid grid-cols-1 lg:grid-cols-3 gap-5">
          <Tile title="Boards & Parts" className="lg:col-span-2" action={
            <span className="text-xs text-subtext-1">{boards.length} runner{boards.length === 1 ? '' : 's'}</span>
          }>
            <BoardsPanel detail={detail} expandedBoard={expandedBoard} setExpandedBoard={setExpandedBoard}
              activeSection={activeSection} onChanged={changed} />
          </Tile>

          <Tile title="Build Sections" action={
            <span className="text-xs text-subtext-1">{sections.length}</span>
          }>
            <SectionsPanel detail={detail} activeSection={activeSection} setActiveSection={setActiveSection}
              onChanged={changed} compact />
          </Tile>

          <Tile title="Reference" className="lg:col-span-3">
            <ReferencePanel kitId={kit.id} projectId={projectId}
              photos={photos} manuals={manuals} paints={paints}
              onLightbox={setLightbox} onOpenManual={openManual} onChanged={changed} />
          </Tile>

          <Tile title="Build Log" className="lg:col-span-3" action={
            <span className="text-xs text-subtext-1">{log.length}</span>
          }>
            <BuildLog kitId={kit.id} log={log} onChanged={changed} />
          </Tile>
        </div>
      </ScrollArea>

      {lightbox != null && <Lightbox fileId={lightbox} onClose={() => setLightbox(null)} />}
      {manualReader && <ManualReader fileId={manualReader.fileId} name={manualReader.name} onClose={() => setManualReader(null)} />}
    </div>
  );
}

function StatusSelect({ kit, onChanged }: { kit: ModelKit; onChanged: () => void }) {
  return (
    <select value={kit.status} onChange={async (e) => { await updateModelKit(kit.id, { status: e.target.value as ModelStatus }); onChanged(); }}
      className="g-field g-field-sm !w-auto">
      {SHELF_COLUMNS.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
    </select>
  );
}

function DeleteKit({ kit, onDeleted }: { kit: ModelKit; onDeleted: () => void }) {
  const [confirm, setConfirm] = useState(false);
  if (!confirm) return <button onClick={() => setConfirm(true)} className="g-iconbtn hover:!text-error" title="Delete kit">🗑</button>;
  return (
    <span className="flex items-center gap-1">
      <button onClick={async () => { await deleteModelKit(kit.id); onDeleted(); }} className="g-btn g-btn-danger g-btn-sm">Delete</button>
      <button onClick={() => setConfirm(false)} className="g-btn g-btn-ghost g-btn-sm">Cancel</button>
    </span>
  );
}

// --------------------------------------------------------------------------- //
// Boards panel — runners with their part grids.
// --------------------------------------------------------------------------- //
function BoardsPanel({ detail, expandedBoard, setExpandedBoard, activeSection, onChanged }: {
  detail: ModelKitDetail; expandedBoard: number | null; setExpandedBoard: (n: number | null) => void;
  activeSection: number | null; onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-3">
      <SectionHeader title="Boards / Runners" action={<button onClick={() => setAdding((v) => !v)} className="g-btn g-btn-pri g-btn-sm">+ Board</button>} />
      {adding && <BoardForm kitId={detail.kit.id} onDone={() => { setAdding(false); onChanged(); }} />}
      {detail.boards.length === 0 && <Muted>No boards yet. Add a runner (A, B, C1…) with its part count.</Muted>}
      {detail.boards.map((b) => {
        const parts = detail.parts_by_board[String(b.id)] ?? [];
        const used = parts.filter((p) => p.is_used).length;
        const open = expandedBoard === b.id;
        return (
          <div key={b.id} className="g-card">
            <div className="flex items-center gap-3 px-4 py-3 cursor-pointer rounded-t" onClick={() => setExpandedBoard(open ? null : b.id)}>
              <span className="w-5 h-5 rounded-full border border-surface-2 flex-shrink-0" style={{ backgroundColor: boardColor(b.color) }} />
              <span className="font-medium text-text">{b.name}</span>
              <span className="text-xs text-subtext-0">{b.max_parts} parts</span>
              <span className="text-xs text-subtext-1">{used}/{parts.length} used</span>
              <div className="ml-auto w-24"><ProgressBar used={used} total={parts.length || b.max_parts} /></div>
              <BoardMenu board={b} onChanged={onChanged} />
            </div>
            {open && (
              <div className="px-4 pb-4 border-t border-gilt-b pt-3 rounded-b overflow-hidden">
                {activeSection == null && <Muted>Pick a section (Sections tab) to mark parts into it.</Muted>}
                <PartGrid parts={parts} maxParts={b.max_parts} color={b.color}
                  canToggle={activeSection != null}
                  onToggle={async (num, used) => {
                    if (activeSection == null) return;
                    if (used) { await unmarkModelPart(detail.kit.id, b.name, num); }
                    else { await markModelPart({ kit_id: detail.kit.id, board_name: b.name, part_number: num, section_id: activeSection }); }
                    onChanged();
                  }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PartGrid({ parts, maxParts, color, canToggle, onToggle }: {
  parts: ModelPart[]; maxParts: number; color?: string | null;
  canToggle: boolean; onToggle: (num: number, isUsed: boolean) => void;
}) {
  // Render one cell per declared number 1..maxParts; cells with a used copy
  // show filled, cells with an unused copy show outlined, missing numbers
  // (auto-created-on-mark) show as a faint placeholder.
  const byNumber = useMemo(() => {
    const m = new Map<number, ModelPart[]>();
    for (const p of parts) { (m.get(p.number) ?? m.set(p.number, []).get(p.number)!).push(p); }
    return m;
  }, [parts]);
  const cells = Array.from({ length: Math.max(maxParts, 1) }, (_, i) => i + 1);
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(34px, 1fr))' }}>
      {cells.map((n) => {
        const copies = byNumber.get(n) ?? [];
        const usedCount = copies.filter((p) => p.is_used).length;
        const allUsed = copies.length > 0 && usedCount === copies.length;
        const someUsed = usedCount > 0 && !allUsed;
        const tint = boardColor(color);
        return (
          <button key={n} disabled={!canToggle && copies.length === 0}
            onClick={() => canToggle && onToggle(n, allUsed)}
            title={copies.length ? `${copies.length} cop${copies.length > 1 ? 'ies' : 'y'}, ${usedCount} used` : `#${n} (auto-create on mark)`}
            className={`h-8 rounded text-[11px] font-medium tabular-nums transition-colors border ${
              allUsed ? 'text-primary-text border-transparent' : someUsed ? 'text-text border-primary/60' : copies.length ? 'text-subtext-0 border-surface-1' : 'text-subtext-1 border-surface-1 border-dashed opacity-50'
            } ${canToggle ? 'hover:opacity-80 cursor-pointer' : 'cursor-default'}`}
            style={allUsed ? { backgroundColor: tint } : someUsed ? { backgroundColor: `color-mix(in srgb, ${tint} 35%, transparent)` } : undefined}>
            {n}
          </button>
        );
      })}
    </div>
  );
}

function BoardForm({ kitId, onDone }: { kitId: number; onDone: () => void }) {
  const [name, setName] = useState('');
  const [maxParts, setMaxParts] = useState('');
  const [color, setColor] = useState('');
  const [dups, setDups] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!name.trim() || !maxParts) return;
    setBusy(true);
    try {
      const duplicates: Record<string, number> = {};
      // "7:2, 15:3" → {7:2, 15:3}
      for (const chunk of dups.split(',')) {
        const m = chunk.trim().match(/^(\d+)\s*:\s*(\d+)$/);
        if (m) duplicates[m[1]] = parseInt(m[2], 10);
      }
      await createModelBoard({
        kit_id: kitId, name: name.trim(), max_parts: parseInt(maxParts, 10),
        color: color.trim() || null,
        duplicates: Object.keys(duplicates).length ? duplicates : undefined,
      });
      onDone();
    } finally { setBusy(false); }
  };
  return (
    <div className="g-card p-3 space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Board (A)" className="g-field g-field-sm !w-auto" />
        <input value={maxParts} onChange={(e) => setMaxParts(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="Parts (30)" className="g-field g-field-sm !w-auto" />
        <input value={color} onChange={(e) => setColor(e.target.value)} placeholder="Color (#3b6fb0)" className="g-field g-field-sm !w-auto" />
        <input value={dups} onChange={(e) => setDups(e.target.value)} placeholder="Dups 7:2, 15:3" className="g-field g-field-sm !w-auto" />
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onDone} className="g-btn g-btn-ghost g-btn-sm">Cancel</button>
        <button onClick={submit} disabled={busy || !name.trim() || !maxParts} className="g-btn g-btn-pri g-btn-sm">Add</button>
      </div>
    </div>
  );
}

function BoardMenu({ board, onChanged }: { board: ModelBoard; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  if (editing) return <BoardEdit board={board} onDone={() => { setEditing(false); setOpen(false); onChanged(); }} />;
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button onClick={() => setOpen((v) => !v)} className="g-iconbtn !w-8 !h-8">⋯</button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-7 z-50 bg-base border border-gilt-a rounded shadow-lg py-1 w-32">
            <button onClick={() => setEditing(true)} className="w-full text-left min-h-8 px-3 text-xs hover:bg-surface-0 text-text">Edit…</button>
            <button onClick={async () => { await deleteModelBoard(board.id); onChanged(); }} className="w-full text-left min-h-8 px-3 text-xs hover:bg-surface-0 text-error">Delete</button>
          </div>
        </>
      )}
    </div>
  );
}

function BoardEdit({ board, onDone }: { board: ModelBoard; onDone: () => void }) {
  const [name, setName] = useState(board.name);
  const [maxParts, setMaxParts] = useState(String(board.max_parts));
  const [color, setColor] = useState(board.color ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <input value={name} onChange={(e) => setName(e.target.value)} className="g-field g-field-sm !w-16" />
      <input value={maxParts} onChange={(e) => setMaxParts(e.target.value.replace(/[^0-9]/g, ''))} className="g-field g-field-sm !w-14" />
      <input value={color} onChange={(e) => setColor(e.target.value)} placeholder="color" className="g-field g-field-sm !w-20" />
      <button onClick={async () => { setBusy(true); try { await updateModelBoard(board.id, { name: name.trim() || undefined, max_parts: maxParts ? parseInt(maxParts, 10) : undefined, color: color.trim() || null }); onDone(); } finally { setBusy(false); } }} disabled={busy} className="g-btn g-btn-pri g-btn-sm">OK</button>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Sections panel — build phases + the mark-parts shorthand input.
// --------------------------------------------------------------------------- //
function SectionsPanel({ detail, activeSection, setActiveSection, onChanged, compact }: {
  detail: ModelKitDetail; activeSection: number | null; setActiveSection: (n: number | null) => void;
  onChanged: () => void; compact?: boolean;
}) {
  void compact;
  const [adding, setAdding] = useState(false);
  const [markInput, setMarkInput] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const activeSec = detail.sections.find((s) => s.id === activeSection) ?? null;

  const doMark = async () => {
    if (!activeSec) return;
    const parsed = parsePartsInput(markInput);
    if (parsed.length === 0) { setFeedback('No parts parsed. Use "A 7" or "A 7 x2, B 3".'); return; }
    let marked = 0; let auto = 0;
    for (const { board, number } of parsed) {
      const [m, a] = await markModelPart({ kit_id: detail.kit.id, board_name: board, part_number: number, section_id: activeSec.id });
      if (m) { marked++; if (a) auto++; }
    }
    setMarkInput('');
    setFeedback(`Marked ${marked}/${parsed.length}${auto ? ` (${auto} auto-added)` : ''}.`);
    onChanged();
    setTimeout(() => setFeedback(null), 3000);
  };

  return (
    <div className="space-y-3">
      <SectionHeader title="Build Sections" action={<button onClick={() => setAdding((v) => !v)} className="g-btn g-btn-pri g-btn-sm">+ Section</button>} />
      {adding && <SectionForm kitId={detail.kit.id} onDone={() => { setAdding(false); onChanged(); }} />}
      {detail.sections.length === 0 && <Muted>No sections yet. Add one (e.g. "Chest Unit", steps 02-1..02-5).</Muted>}

      {detail.sections.map((s) => {
        const used = detail.used_by_section[String(s.id)] ?? {};
        const total = Object.values(used).reduce((a, v) => a + v.length, 0);
        const isActive = activeSection === s.id;
        return (
          <div key={s.id} className={`g-plain ${isActive ? '!border-gold shadow-[inset_0_0_0_1px_var(--color-gilt-a)]' : ''}`}>
            <div className="flex items-center gap-3 px-4 py-3 cursor-pointer rounded-t" onClick={() => setActiveSection(isActive ? null : s.id)}>
              <span className={`g-gem ${isActive ? '' : 'c-none'}`} />
              <span className="font-medium text-text">{s.name}</span>
              {(s.start_step || s.end_step) && <span className="text-xs text-subtext-0">steps {s.start_step ?? '?'}–{s.end_step ?? '?'}</span>}
              <span className="text-xs text-subtext-1 ml-auto">{total} part{total === 1 ? '' : 's'}</span>
              <SectionMenu section={s} onChanged={onChanged} />
            </div>
            {isActive && total > 0 && (
              <div className="px-4 pb-3 border-t border-gilt-b pt-2 space-y-1 rounded-b overflow-hidden">
                {Object.entries(used).map(([bid, nums]) => {
                  const board = detail.boards.find((b) => b.id === Number(bid));
                  return (
                    <div key={bid} className="text-xs text-subtext-0 flex items-center gap-2">
                      <span className="font-medium text-text">{board?.name ?? '?'}</span>
                      <span className="inline-flex flex-wrap gap-1">
                        {nums.map((n, i) => <span key={i} className="px-1.5 py-0.5 rounded bg-surface-0 tabular-nums">{n}</span>)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Mark-parts input — the manual-shorthand speed entry. */}
      {activeSec && (
        <div className="g-card g-corners p-4 space-y-2 sticky bottom-0">
          <div className="g-deco text-[11px] font-semibold text-gold">Mark parts into "{activeSec.name}"</div>
          <div className="flex gap-2 min-w-0">
            <input value={markInput} onChange={(e) => setMarkInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void doMark(); }}
              placeholder='e.g. "A 7 x2, B 3, C1 12"  (board part [xN])'
              className="g-field g-field-sm flex-1 min-w-0" />
            <button onClick={doMark} className="g-btn g-btn-pri g-btn-sm">Mark</button>
          </div>
          {feedback && <div className="text-xs text-subtext-0">{feedback}</div>}
          <div className="text-[11px] text-subtext-1">Tip: numbers not on a board are auto-added (up to 999). Toggle the Boards tab to tap parts individually.</div>
        </div>
      )}
    </div>
  );
}

function SectionForm({ kitId, onDone }: { kitId: number; onDone: () => void }) {
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  return (
    <div className="g-card p-3 space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && createModelSection({ kit_id: kitId, name: name.trim(), start_step: start || null, end_step: end || null }).then(onDone)} placeholder="Name (Chest Unit)" className="g-field g-field-sm !w-auto" />
        <input value={start} onChange={(e) => setStart(e.target.value)} placeholder="Start step (02-1)" className="g-field g-field-sm !w-auto" />
        <input value={end} onChange={(e) => setEnd(e.target.value)} placeholder="End step (02-5)" className="g-field g-field-sm !w-auto" />
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onDone} className="g-btn g-btn-ghost g-btn-sm">Cancel</button>
        <button onClick={async () => { if (name.trim()) { await createModelSection({ kit_id: kitId, name: name.trim(), start_step: start || null, end_step: end || null }); onDone(); } }} disabled={!name.trim()} className="g-btn g-btn-pri g-btn-sm">Add</button>
      </div>
    </div>
  );
}

function SectionMenu({ section, onChanged }: { section: ModelSection; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  if (editing) return <SectionEdit section={section} onDone={() => { setEditing(false); setOpen(false); onChanged(); }} />;
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button onClick={() => setOpen((v) => !v)} className="g-iconbtn !w-8 !h-8">⋯</button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-7 z-50 bg-base border border-gilt-a rounded shadow-lg py-1 w-32">
            <button onClick={() => setEditing(true)} className="w-full text-left min-h-8 px-3 text-xs hover:bg-surface-0 text-text">Edit…</button>
            <button onClick={async () => { await deleteModelSection(section.id); onChanged(); }} className="w-full text-left min-h-8 px-3 text-xs hover:bg-surface-0 text-error">Delete</button>
          </div>
        </>
      )}
    </div>
  );
}

function SectionEdit({ section, onDone }: { section: ModelSection; onDone: () => void }) {
  const [name, setName] = useState(section.name);
  const [start, setStart] = useState(section.start_step ?? '');
  const [end, setEnd] = useState(section.end_step ?? '');
  return (
    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
      <input value={name} onChange={(e) => setName(e.target.value)} className="g-field g-field-sm !w-24" />
      <input value={start} onChange={(e) => setStart(e.target.value)} placeholder="start" className="g-field g-field-sm !w-14" />
      <input value={end} onChange={(e) => setEnd(e.target.value)} placeholder="end" className="g-field g-field-sm !w-14" />
      <button onClick={async () => { await updateModelSection(section.id, { name: name.trim() || undefined, start_step: start || null, end_step: end || null }); onDone(); }} className="g-btn g-btn-pri g-btn-sm">OK</button>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// --------------------------------------------------------------------------- //
// Tile — a dashboard card with a header + content. Replaces the old tab bar:
// each kit area (Boards / Sections / Reference / Build log) is a tile laid out
// in a responsive grid so the full width is used.
// --------------------------------------------------------------------------- //
function Tile({ title, children, action, className }: {
  title: string; children: React.ReactNode; action?: React.ReactNode; className?: string;
}) {
  return (
    <div className={`g-card flex flex-col min-w-0 ${className ?? ''}`}>
      <div className="flex items-center gap-2 px-5 pt-4 pb-2 shrink-0">
        <h2 className="g-deco text-[13px] font-semibold text-gold">{title}</h2>
        <div className="ml-auto flex items-center gap-2">{action}</div>
      </div>
      <div className="px-5 pb-5 pt-2 flex-1 min-w-0">{children}</div>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Reference tile — internal sub-tabs for Photos / Manuals / Paints. Manuals
// are PDFs: rendered as cover thumbnails (pdf.js page 1) and opened in a
// full-screen page-by-page reader (the same pdf.js pipeline PDF Studio uses).
// --------------------------------------------------------------------------- //
function ReferencePanel({ kitId, projectId, photos, manuals, paints, onLightbox, onOpenManual, onChanged }: {
  kitId: number; projectId: number;
  photos: ModelKitFile[]; manuals: ModelKitFile[]; paints: ModelKitFile[];
  onLightbox: (fileId: number) => void; onOpenManual: (m: { fileId: number; name: string }) => void; onChanged: () => void;
}) {
  const [sub, setSub] = useState<ModelFileKind>('photo');
  const list = sub === 'photo' ? photos : sub === 'manual' ? manuals : paints;
  return (
    <div>
      <div className="flex items-center gap-1 mb-3">
        {(['photo', 'manual', 'paint'] as ModelFileKind[]).map((k) => (
          <button key={k} onClick={() => setSub(k)}
            aria-pressed={sub === k}
            className={`min-h-8 px-2.5 text-xs font-semibold rounded-sm ${sub === k ? 'g-on' : 'text-[color:var(--g-fg2)] hover:bg-surface-0 hover:text-text'}`}>
            {FILE_KIND_META[k].icon} {FILE_KIND_META[k].label} {(k === 'photo' ? photos : k === 'manual' ? manuals : paints).length || ''}
          </button>
        ))}
      </div>
      {sub === 'manual'
        ? <ManualGallery kitId={kitId} projectId={projectId} files={list} onOpen={onOpenManual} onChanged={onChanged} />
        : <ImageGallery kitId={kitId} projectId={projectId} kind={sub} files={list} onLightbox={onLightbox} onChanged={onChanged} />}
    </div>
  );
}

function ImageGallery({ kitId, projectId, kind, files, onLightbox, onChanged }: {
  kitId: number; projectId: number; kind: ModelFileKind; files: ModelKitFile[];
  onLightbox: (fileId: number) => void; onChanged: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const upload = async (fileList: FileList | File[]) => {
    setBusy(true);
    try {
      for (const file of Array.from(fileList)) {
        const pf = await uploadProjectFile(projectId, file);
        await linkModelKitFile(kitId, pf.id, kind);
      }
      onChanged();
    } catch (e) {
      console.error('upload failed', e);
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="flex justify-end mb-2">
        <button onClick={() => inputRef.current?.click()} disabled={busy} className="g-btn g-btn-pri g-btn-sm">
          {busy ? 'Uploading…' : '+ Add'}
        </button>
      </div>
      <input ref={inputRef} type="file" accept="image/*" multiple hidden
        onChange={(e) => e.target.files && void upload(e.target.files)} />
      {files.length === 0 ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}
          className={`rounded border border-dashed p-6 text-center text-xs text-subtext-0 ${dragOver ? 'border-gold bg-gilt-b' : 'border-gilt-a'}`}>
          Drop {FILE_KIND_META[kind].label.toLowerCase()} here, or use + Add
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
          {files.map((f) => (
            <div key={f.id} className="g-plain group relative overflow-hidden">
              <div className="aspect-square">
                <KitImage fileId={f.file_id} onClick={() => onLightbox(f.file_id)} className="w-full h-full object-cover cursor-zoom-in" />
              </div>
              {f.caption && <div className="px-2 py-1 text-[11px] text-subtext-0 truncate">{f.caption}</div>}
              <button onClick={async () => { await unlinkModelKitFile(f.id); onChanged(); }}
                className="absolute top-1 right-1 w-6 h-6 rounded-full bg-base/80 text-text opacity-0 group-hover:opacity-100 hover:bg-error hover:text-base flex items-center justify-center text-xs">✕</button>
            </div>
          ))}
          <button onClick={() => inputRef.current?.click()} disabled={busy}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}
            className={`aspect-square rounded border border-dashed flex items-center justify-center text-subtext-0 text-3xl ${dragOver ? 'border-gold bg-gilt-b' : 'border-gilt-a hover:border-gold'}`}>+</button>
        </div>
      )}
    </div>
  );
}

// Manuals are PDFs. Each renders a page-1 cover thumbnail (pdf.js → canvas);
// clicking opens ManualReader, a full-screen scrollable page-by-page viewer —
// the same pdf.js pipeline PDF Studio uses (main-thread legacy build for
// WKWebView compatibility), adapted to a simple inline reader.
function ManualGallery({ kitId, projectId, files, onOpen, onChanged }: {
  kitId: number; projectId: number; files: ModelKitFile[];
  onOpen: (m: { fileId: number; name: string }) => void; onChanged: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const upload = async (fileList: FileList | File[]) => {
    setBusy(true);
    try {
      for (const file of Array.from(fileList)) {
        const pf = await uploadProjectFile(projectId, file);
        await linkModelKitFile(kitId, pf.id, 'manual');
      }
      onChanged();
    } catch (e) { console.error('upload failed', e); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className="flex justify-end mb-2">
        <button onClick={() => inputRef.current?.click()} disabled={busy} className="g-btn g-btn-pri g-btn-sm">
          {busy ? 'Uploading…' : '+ Add PDF'}
        </button>
      </div>
      <input ref={inputRef} type="file" accept="application/pdf" multiple hidden
        onChange={(e) => e.target.files && void upload(e.target.files)} />
      {files.length === 0 ? (
        <div className="rounded border border-dashed p-6 text-center text-xs text-subtext-0 border-gilt-a">
          Drop instruction manuals here, or use + Add PDF
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3">
          {files.map((f) => (
            <ManualCard key={f.id} file={f} onOpen={() => onOpen({ fileId: f.file_id, name: f.caption || 'Manual' })}
              onRemove={async () => { await unlinkModelKitFile(f.id); onChanged(); }} />
          ))}
        </div>
      )}
    </div>
  );
}

// Session cache of manual thumbnails: page 1 of a scanned manual costs a full
// pdf.js boot + wasm decoders — paying that on EVERY card mount made the shelf
// crawl. Rendered once per file per session, then it's an <img>.
const manualThumbCache = new Map<number, string>();

function ManualCard({ file, onOpen, onRemove }: {
  file: ModelKitFile; onOpen: () => void; onRemove: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(() => manualThumbCache.get(file.file_id) ?? null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(() =>
    manualThumbCache.has(file.file_id) ? 'ready' : 'loading'
  );
  useEffect(() => {
    if (manualThumbCache.has(file.file_id)) return;
    let cancelled = false;
    (async () => {
      try {
        const { openPdf } = await import('../tabs/pdf/pdfUtils');
        const bytes = await fetchProjectFileBytes(file.file_id);
        const doc = await openPdf(bytes);
        if (cancelled) { void doc.loadingTask.destroy(); return; }
        const page = await doc.getPage(1);
        const vp = page.getViewport({ scale: 1 });
        const targetW = 220;
        const scale = targetW / vp.width;
        const vp2 = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = vp2.width;
        canvas.height = vp2.height;
        await page.render({ canvas, viewport: vp2 }).promise;
        const url = canvas.toDataURL('image/jpeg', 0.8);
        manualThumbCache.set(file.file_id, url);
        if (!cancelled) {
          setThumb(url);
          setStatus('ready');
        }
        page.cleanup();
        void doc.loadingTask.destroy();
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [file.file_id]);
  return (
    <div className="g-plain group relative overflow-hidden">
      <button onClick={onOpen} className="block w-full text-left">
        <div className="aspect-[3/4] bg-surface-0 flex items-center justify-center overflow-hidden">
          {status === 'loading' && <span className="text-subtext-0 text-xs animate-pulse">Rendering…</span>}
          {status === 'error' && <span className="text-subtext-0 text-xs">⚠ PDF</span>}
          {thumb && status === 'ready' && <img src={thumb} alt="" className="w-full h-full object-contain" />}
        </div>
        <div className="px-2 py-1.5 text-[11px] text-text truncate flex items-center gap-1">
          <span>📄</span><span className="truncate">{file.caption || 'Manual'}</span>
        </div>
      </button>
      <button onClick={onRemove}
        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-base/90 text-subtext-0 hover:bg-error hover:text-base flex items-center justify-center text-xs shadow-sm" title="Remove manual">✕</button>
    </div>
  );
}

// Full-screen PDF reader: fetches the bytes once, opens with pdf.js, and renders
// pages lazily into canvases as they scroll into view (IntersectionObserver),
// freeing far-away canvases so a long manual stays bounded. Mirrors PDF Studio's
// ScrollViewer in miniature.
function ManualReader({ fileId, name, onClose }: {
  fileId: number; name: string; onClose: () => void;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const slotRefs = useRef<(HTMLDivElement | null)[]>([]);
  const drawn = useRef<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    let proxy: PDFDocumentProxy | null = null;
    (async () => {
      try {
        const { openPdf } = await import('../tabs/pdf/pdfUtils');
        const bytes = await fetchProjectFileBytes(fileId);
        proxy = await openPdf(bytes);
        if (cancelled) { void proxy.loadingTask.destroy(); return; }
        setDoc(proxy);
        setPageCount(proxy.numPages);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      void proxy?.loadingTask.destroy();
    };
  }, [fileId]);

  const fitScale = useCallback((pageWidth: number) => {
    const cw = containerRef.current?.clientWidth ?? 800;
    return Math.min(2, Math.max(0.4, (cw - 48) / pageWidth));
  }, []);

  const renderPage = useCallback(async (n: number) => {
    if (!doc || drawn.current.has(n)) return;
    const canvas = slotRefs.current[n - 1]?.querySelector('canvas');
    if (!canvas) return;
    try {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: fitScale(page.getViewport({ scale: 1 }).width) });
      canvas.width = vp.width;
      canvas.height = vp.height;
      await page.render({ canvas, viewport: vp }).promise;
      page.cleanup();
      drawn.current.add(n);
    } catch { /* transient — redrawn if scrolled back */ }
  }, [doc, fitScale]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pageCount) return;
    const io = new IntersectionObserver(
      (entries) => { for (const e of entries) if (e.isIntersecting) void renderPage(Number((e.target as HTMLElement).dataset.page)); },
      { root: container, rootMargin: '150% 0px' },
    );
    for (const el of slotRefs.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, [pageCount, renderPage]);

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-mantle flex flex-col">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gilt-b bg-crust shrink-0">
        <button onClick={onClose} className="g-iconbtn" title="Close">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
        <span className="text-sm font-medium text-text truncate">📄 {name}</span>
        {pageCount > 0 && <span className="text-xs text-subtext-0">{pageCount} pages</span>}
      </div>
      <div ref={containerRef} className="flex-1 overflow-auto scrollbar-none" style={{ scrollbarWidth: 'none' }}>
        {error ? (
          <div className="p-8 text-center text-sm text-error">Could not open PDF: {error}</div>
        ) : !doc ? (
          <div className="p-8 text-center text-sm text-subtext-0">Loading manual…</div>
        ) : (
          <div className="py-4 flex flex-col items-center gap-3">
            {Array.from({ length: pageCount }, (_, i) => i + 1).map((n) => (
              <div key={n} data-page={n} ref={(el) => { slotRefs.current[n - 1] = el; }}
                className="bg-white shadow-lg" style={{ minHeight: 400 }}>
                <canvas />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Lightbox({ fileId, onClose }: { fileId: number; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] bg-base/90 backdrop-blur flex items-center justify-center p-8" onClick={onClose}>
      <button className="g-iconbtn absolute top-4 right-4 !text-2xl hover:!text-error" onClick={onClose}>✕</button>
      <KitImage fileId={fileId} className="max-w-full max-h-full object-contain rounded-lg shadow-2xl" />
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Build log — the chronological UsedPart audit trail.
// --------------------------------------------------------------------------- //
function BuildLog({ kitId, log, onChanged }: { kitId: number; log: ModelBuildLogEntry[]; onChanged: () => void }) {
  if (log.length === 0) return <Muted>No parts marked yet. Open a section and mark parts to start your build log.</Muted>;
  return (
    <div className="space-y-1">
      {log.map((e) => (
        <div key={e.id} className="flex items-center gap-3 min-h-10 px-3 py-2 rounded hover:bg-surface-0 text-sm">
          <span className="text-subtext-1 text-xs tabular-nums w-32">{new Date(e.used_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
          <span className="font-medium text-text">{e.section_name}</span>
          <span className="text-subtext-0">←</span>
          <span className="text-text tabular-nums">{e.board_name} #{e.part_number}</span>
          <button onClick={async () => { await unmarkModelPart(kitId, e.board_name, e.part_number); onChanged(); }}
            className="ml-auto min-h-8 px-1 text-xs text-subtext-1 hover:text-error">unmark</button>
        </div>
      ))}
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Small shared bits.
// --------------------------------------------------------------------------- //
function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="g-deco text-[13px] font-semibold text-gold">{title}</h2>
      {action}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-subtext-0 py-2">{children}</p>;
}

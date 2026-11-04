import { useEffect, useId, useMemo, useRef, useState } from 'react';
import ScrollArea from '../ScrollArea';
import type { Area, Task } from '../../types';
import { createCandidate, moveCursor } from '../../lib/composer.pure';

export const STATUS_DOT: Record<string, string> = {
  'To Do': 'bg-overlay-0',
  'In Progress': 'bg-primary',
  Done: 'bg-success',
  Blocked: 'bg-error',
};

/** Gilt's status marks (g-st), by task status. */
export const STATUS_MARK: Record<string, string> = {
  'To Do': 'g-st',
  'In Progress': 'g-st g-st-progress',
  Done: 'g-st g-st-done',
  Blocked: 'g-st g-st-blocked',
};

/** A status mark at a given size (the g-st circle scales; its bar stays centred). */
export function StatusMark({ status, size = 10 }: { status: string | undefined; size?: number }) {
  return <span className={STATUS_MARK[status ?? ''] ?? 'g-st'} style={{ width: size, height: size }} aria-hidden="true" />;
}

export function fmtSecs(s: number): string {
  if (s < 60) return '<1m';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** One task chip. `onRemove` shows ×; `onClick` makes the label clickable. */
export function TaskChip({
  task,
  title,
  onClick,
  onRemove,
  active,
  muted,
}: {
  task: Pick<Task, 'title' | 'status'> | undefined;
  title?: string;
  onClick?: () => void;
  onRemove?: () => void;
  active?: boolean;
  /** In the Bin / unknown here. */
  muted?: boolean;
}) {
  const label = task?.title ?? 'Task in the Bin';
  return (
    <span
      className={`g-tag !px-0 !gap-0 max-w-[16rem] ${
        active ? '!bg-gilt-b !text-gold shadow-[inset_0_0_0_1px_var(--color-gilt-a)]' : ''
      } ${muted ? 'opacity-60 italic' : ''}`}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        title={title ?? (onClick ? `Show updates on “${label}”` : label)}
        className={`g-hit flex items-center gap-1.5 min-w-0 min-h-[24px] pl-2.5 ${onRemove ? 'pr-1' : 'pr-2.5'} ${onClick ? 'hover:text-text' : 'cursor-default'}`}
      >
        <StatusMark status={task?.status} />
        <span className="truncate">{label}</span>
      </button>
      {onRemove && (
        <button type="button" onClick={onRemove} className="g-hit min-h-[24px] pr-2.5 pl-1 text-subtext-0 hover:text-error" title="Remove tag" aria-label={`Remove ${label}`}>
          ✕
        </button>
      )}
    </span>
  );
}

/**
 * Pick the tasks a comment is about. Chips for the chosen ones, a searchable
 * list grouped by area, and one-click suggestions (what you tracked time on
 * today, the active task) — the end-of-day update's usual suspects. With
 * `onCreate`, a search that no task matches offers to create that task and
 * tags it. Arrow keys move through the rows; Enter picks.
 */
export default function TaskTagPicker({
  tasks,
  areas = [],
  value,
  onChange,
  suggestions = [],
  onCreate,
}: {
  tasks: Task[];
  areas?: Area[];
  value: number[];
  onChange: (ids: number[]) => void;
  suggestions?: { taskId: number; hint: string }[];
  /** Create a task with this title on the board's host. A refusal (the
   * host's error) shows in the picker and tags nothing. */
  onCreate?: (title: string) => Promise<Task>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The highlighted row, kept with the search it belongs to: a new search
  // starts at the first row (in the same render, so Enter never picks a
  // row from the previous search).
  const [hot, setHot] = useState({ q: '', row: 0 });
  const cursor = hot.q === query ? hot.row : 0;
  const setCursor = (row: number) => setHot({ q: query, row });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const uid = useId();
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hit = (t: Task) => !q || t.title.toLowerCase().includes(q);
    // Open work first inside each group; Done last.
    const order = (t: Task) => (t.status === 'In Progress' ? 0 : t.status === 'Done' ? 2 : 1);
    const sort = (ts: Task[]) => [...ts].sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title));
    const out = areas.map((a) => ({ name: a.name, tasks: sort(tasks.filter((t) => t.area_id === a.id && hit(t))) }));
    const known = new Set(areas.map((a) => a.id));
    out.push({ name: areas.length ? 'No area' : '', tasks: sort(tasks.filter((t) => (!t.area_id || !known.has(t.area_id)) && hit(t))) });
    return out.filter((g) => g.tasks.length > 0);
  }, [tasks, areas, query]);

  // The rows in order, for the arrow keys: every match, then "Create task".
  const flat = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);
  const rowOf = useMemo(() => new Map(flat.map((t, i) => [t.id, i])), [flat]);
  const latest = useRef(value);
  latest.current = value;
  const candidate = onCreate ? createCandidate(query, tasks.map((t) => t.title)) : null;
  const rowCount = flat.length + (candidate ? 1 : 0);
  const at = Math.min(cursor, rowCount - 1);
  const scrollTo = (row: number) =>
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-row="${row}"]`)?.scrollIntoView({ block: 'nearest' }));

  const create = async () => {
    if (!onCreate || !candidate || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const task = await onCreate(candidate);
      const now = latest.current;
      onChange(now.includes(task.id) ? now : [...now, task.id]);
      setQuery('');
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const pick = (row: number) => {
    if (row < 0) return;
    if (row < flat.length) {
      toggle(flat[row].id);
      setQuery('');
    } else void create();
  };

  const offered = suggestions.filter((s) => !value.includes(s.taskId) && byId.has(s.taskId));
  const rowClass = (on: boolean, hot: boolean) =>
    `w-full flex items-center gap-2 px-2 min-h-[32px] [@media(pointer:coarse)]:min-h-[44px] rounded text-left text-sm ${
      on ? 'bg-gilt-b text-text' : hot ? 'bg-surface-0 text-text' : 'text-subtext-1 hover:bg-surface-0'
    } ${hot ? 'shadow-[inset_0_0_0_1px_var(--color-gilt-a)]' : ''}`;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 flex-wrap" ref={box}>
        <span className="g-flbl !mb-0 mr-0.5">Tasks</span>
        {value.map((id) => (
          <TaskChip key={id} task={byId.get(id)} muted={!byId.has(id)} onRemove={() => toggle(id)} />
        ))}
        <div className="relative">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="g-tag !bg-transparent shadow-[inset_0_0_0_1px_var(--color-gilt-a)] !text-gold hover:!bg-gilt-b"
          >
            + Tag task
          </button>
          {open && (
            <div className="absolute z-30 left-0 top-full mt-1 w-72 max-w-[calc(100vw-2rem)] bg-base border border-gilt-a rounded shadow-xl p-2 space-y-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCreateError(null);
                }}
                readOnly={creating}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setOpen(false);
                  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const next = moveCursor(at, e.key === 'ArrowDown' ? 1 : -1, rowCount);
                    setCursor(next);
                    scrollTo(next);
                  } else if (e.key === 'Enter') {
                    // Enter picks the highlighted row (the first match unless
                    // the arrows moved): fast keyboard tagging.
                    e.preventDefault();
                    pick(at);
                  }
                }}
                role="combobox"
                aria-expanded="true"
                aria-controls={`${uid}-rows`}
                aria-activedescendant={at >= 0 ? `${uid}-row-${at}` : undefined}
                placeholder={onCreate ? 'Find or create a task…' : 'Find a task…'}
                className="g-field g-field-sm"
              />
              <div className="h-64" ref={list}>
                <ScrollArea className="h-full" contentClassName="pr-2">
                  <div id={`${uid}-rows`} role="listbox" aria-label="Tasks" aria-multiselectable="true" className="space-y-2">
                    {groups.length === 0 && <p className="text-xs text-subtext-0 px-1">No task matches.</p>}
                    {groups.map((g) => (
                      <div key={g.name || 'all'} role="group" aria-label={g.name || undefined}>
                        {g.name && <div className="g-flbl px-1 !mb-0.5 !text-[10px]">{g.name}</div>}
                        {g.tasks.map((t) => {
                          const on = value.includes(t.id);
                          const row = rowOf.get(t.id) ?? -1;
                          return (
                            <button
                              key={t.id}
                              id={`${uid}-row-${row}`}
                              data-row={row}
                              role="option"
                              aria-selected={on}
                              type="button"
                              tabIndex={-1}
                              onClick={() => toggle(t.id)}
                              onMouseMove={() => row !== at && setCursor(row)}
                              className={rowClass(on, row === at)}
                            >
                              <span
                                className={`w-3.5 h-3.5 shrink-0 rounded border flex items-center justify-center text-[9px] ${
                                  on ? 'bg-gold border-gold text-base' : 'border-surface-1'
                                }`}
                              >
                                {on ? '✓' : ''}
                              </span>
                              <StatusMark status={t.status} />
                              <span className="truncate">{t.title}</span>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                    {candidate && (
                      <div className={groups.length ? 'border-t border-gilt-b pt-2' : ''}>
                        <button
                          id={`${uid}-row-${flat.length}`}
                          data-row={flat.length}
                          role="option"
                          aria-selected={false}
                          type="button"
                          tabIndex={-1}
                          disabled={creating}
                          onClick={() => void create()}
                          onMouseMove={() => flat.length !== at && setCursor(flat.length)}
                          className={`${rowClass(false, flat.length === at)} !text-gold disabled:opacity-60`}
                        >
                          <span className="w-3.5 shrink-0 text-center" aria-hidden="true">+</span>
                          <span className="truncate">{creating ? 'Creating…' : `Create task “${candidate}”`}</span>
                        </button>
                        {createError && <p className="text-xs text-error px-2 pt-1">{createError}</p>}
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>
            </div>
          )}
        </div>
      </div>
      {offered.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-subtext-0">Suggested:</span>
          {offered.map((s) => (
            <button
              key={s.taskId}
              type="button"
              onClick={() => toggle(s.taskId)}
              className="g-tag hover:!text-text max-w-[16rem] truncate"
              title={`Tag “${byId.get(s.taskId)?.title}”`}
            >
              + {byId.get(s.taskId)?.title} <span className="text-subtext-0">{s.hint}</span>
            </button>
          ))}
          {offered.length > 1 && (
            <button
              type="button"
              onClick={() => onChange([...value, ...offered.map((s) => s.taskId)])}
              className="g-lnk"
            >
              tag all
            </button>
          )}
        </div>
      )}
    </div>
  );
}

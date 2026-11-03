import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Project } from '../types';
import ScrollArea from './ScrollArea';
import { projectColorClass, projectInitial } from '../lib/projectColor';

const WIDTH = 280; // px
const GAP = 10; // between the rail button and the panel
const MARGIN = 12; // keep this far from the viewport edge
const FILTER_AT = 8; // more projects than this get a filter field
// How long the panel stays up after a click: past App's 300ms single-click
// timer, and long enough for a double-click to land on the row.
const CLOSE_DELAY = 500;

/** The collapsed sidebar's way to the unpinned projects: a `g-iconbtn` under
 * the pinned tiles that opens a `g-card g-corners` list to the rail's right.
 * The panel is portalled to `document.body` with fixed coordinates, so the
 * 64px pane can't clip it. Rows act like the expanded sidebar's rows: a click
 * runs `onClick`, a double-click `onDoubleClick`. */
export default function RailProjectsMenu({
  projects,
  keyOf,
  isCurrent,
  onClick,
  onDoubleClick,
}: {
  projects: Project[];
  keyOf: (p: Project) => string;
  isCurrent: (p: Project) => boolean;
  onClick: (p: Project) => void;
  onDoubleClick: (p: Project) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasFilter = projects.length > FILTER_AT;
  const q = query.trim().toLowerCase();
  const shown = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;

  const close = (refocus: boolean) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setOpen(false);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  };

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  // Beside the trigger, top-aligned, kept inside the viewport; follow resizes.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const vh = window.innerHeight;
      const maxHeight = Math.min(480, vh - 2 * MARGIN);
      const top = Math.max(MARGIN, Math.min(r.top - 8, vh - MARGIN - maxHeight));
      setPos({ left: r.right + GAP, top, maxHeight });
    };
    place();
    // Scrolling the panel's own list doesn't move it.
    const onScroll = (e: Event) => { if (!panelRef.current?.contains(e.target as Node)) place(); };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // Focus the filter (or the current / first project) once it's placed.
  useEffect(() => {
    if (!open || !pos) return;
    if (filterRef.current) { filterRef.current.focus(); return; }
    const items = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-rail-item]');
    const cur = listRef.current?.querySelector<HTMLButtonElement>('[aria-current="page"]');
    (cur ?? items?.[0])?.focus();
    // Only on opening, not on every reposition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pos === null]);

  // An outside press closes it (the trigger toggles on its own), and Esc
  // closes it wherever focus is.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onEsc);
    };
    // close only touches refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const items = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-rail-item]') ?? []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const list = items();
    if (list.length === 0) return;
    const fromFilter = document.activeElement === filterRef.current;
    if (fromFilter && (e.key === 'Home' || e.key === 'End')) return; // keep caret keys in the field
    e.preventDefault();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'ArrowDown') next = i < 0 ? 0 : Math.min(list.length - 1, i + 1);
    else if (i <= 0) {
      // Up from the first row goes back to the filter.
      if (filterRef.current) { filterRef.current.focus(); return; }
      next = 0;
    } else next = i - 1;
    list[next].focus();
  };

  /** `fromKeyboard`: focus goes back to the trigger rather than to <body>. */
  const pick = (p: Project, fromKeyboard: boolean) => {
    onClick(p);
    // Stay up a moment so a double-click can land on the row.
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => close(fromKeyboard), CLOSE_DELAY);
  };

  return (
    <>
      <button
        ref={triggerRef}
        onClick={() => (open ? close(false) : setOpen(true))}
        className={`g-iconbtn ${open ? 'g-on' : ''}`}
        style={{ width: 40, height: 40 }}
        title="Projects"
        aria-label="Projects"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {/* stacked folders */}
        <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9.5V18a1.5 1.5 0 001.5 1.5h12A1.5 1.5 0 0021 18v-6.5A1.5 1.5 0 0019.5 10h-5.2l-1.8-2H7.5A1.5 1.5 0 006 9.5z" />
          <path d="M3 15V6.5A1.5 1.5 0 014.5 5h4.2l1.8 2" />
        </svg>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Projects"
            onKeyDown={onKeyDown}
            // Tabbing out of the panel (to anything but its trigger) closes it.
            onBlur={(e) => {
              const to = e.relatedTarget as Node | null;
              if (to && !panelRef.current?.contains(to) && !triggerRef.current?.contains(to)) close(false);
            }}
            style={{ position: 'fixed', left: pos.left, top: pos.top, width: WIDTH, maxHeight: pos.maxHeight }}
            className="g-card g-corners z-50 shadow-2xl flex flex-col"
          >
            <div className="flex-none flex items-center gap-2 px-[22px] pt-[18px] pb-2">
              <span className="g-cap text-gold">Projects</span>
              <span className="ml-auto g-cap tabular-nums">{projects.length}</span>
            </div>
            {hasFilter && (
              <div className="flex-none px-3.5 pb-2">
                <input
                  ref={filterRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && shown.length > 0) { e.preventDefault(); pick(shown[0], true); }
                  }}
                  placeholder="Filter projects…"
                  aria-label="Filter projects"
                  className="g-field g-field-sm w-full"
                />
              </div>
            )}
            <ScrollArea className="flex-1 min-h-0 mb-4" contentClassName="px-3.5">
            <ul ref={listRef} className="space-y-0.5">
              {shown.map((p) => {
                const on = isCurrent(p);
                return (
                  <li key={keyOf(p)}>
                    <button
                      data-rail-item
                      onClick={(e) => pick(p, e.detail === 0)}
                      onDoubleClick={() => { onDoubleClick(p); close(false); }}
                      aria-current={on ? 'page' : undefined}
                      title={p.name}
                      className={`g-row w-full flex items-center gap-2.5 px-2 min-h-[38px] rounded text-sm text-left ${
                        on ? 'g-sel text-text font-semibold' : 'text-subtext-1 hover:text-text'
                      }`}
                    >
                      <span className={`g-tile ${projectColorClass(p)}`} aria-hidden="true">{projectInitial(p.name)}</span>
                      <span className="flex-1 min-w-0 truncate">{p.name}</span>
                      {on && <span className="shrink-0 w-1.5 h-1.5 bg-gold rotate-45" aria-hidden="true" />}
                    </button>
                  </li>
                );
              })}
              {shown.length === 0 && (
                <li className="px-2 py-3 text-sm italic text-[color:var(--g-mut)]">
                  {projects.length === 0 ? 'Every project is pinned' : 'No match'}
                </li>
              )}
            </ul>
            </ScrollArea>
          </div>,
          document.body
        )}
    </>
  );
}

// Pinned tabs in the global top bar: one click from any project to a project's tab
// (a game tab's practice mode, say). Pin and unpin from the tab strip (ProjectView) or here; drag
// to reorder, or Alt+←/→ on a focused pin, or the right-click menu. What doesn't fit the
// bar's width goes in a "more" menu. The overview popover (click the counts) lists them
// all with the same controls: PinnedTabsManager.

import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react';
import { useAppStore } from '../store/appStore';
import { labelOf, pinKey, tabMeta, usePins, type Pin } from '../store/pins';
import { fitCount, projectKeyOf } from '../lib/pinnedTabs.pure';
import { LOCAL_ID, listWorkspaces } from '../lib/workspaces';
import { useContextMenu, type MenuItem } from './ContextMenu';
import type { Project } from '../types';
import { TabIcon, type TabIconName } from './icons/TabIcon';

/** A pushpin. */
export function PinGlyph({ filled = false, className = 'w-4 h-4', title }: { filled?: boolean; className?: string; title?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <path d="M15 4.5l-4 4-4 1.5-1.5 1.5 7 7 1.5-1.5 1.5-4 4-4z" fill={filled ? 'currentColor' : 'none'} />
      <path d="M9 15l-4.5 4.5M14.5 4l5.5 5.5" />
    </svg>
  );
}

/** A pin with what it needs to draw: its project, label and icon. */
export interface ShownPin {
  pin: Pin;
  key: string;
  project: Project;
  label: string;
  icon: TabIconName;
  host: string | null;
}

/** The pins whose project we know, with their labels. A pin to a project that isn't in
 * the list (its host still loading or unreachable) waits off-screen. */
export function useShownPins(): ShownPin[] {
  const pins = usePins((s) => s.pins);
  const catalog = usePins((s) => s.catalog);
  const projects = useAppStore((s) => s.projects);
  return useMemo(() => {
    const byKey = new Map(projects.map((p) => [projectKeyOf({ ws: p.workspaceId ?? LOCAL_ID, project: p.id }), p]));
    const remote = (ws: string) => (ws === LOCAL_ID ? null : listWorkspaces().find((w) => w.id === ws)?.label ?? 'remote');
    return pins.flatMap((pin) => {
      const project = byKey.get(projectKeyOf(pin));
      if (!project) return [];
      return [{ pin, key: pinKey(pin), project, label: labelOf(pin, catalog), icon: tabMeta(pin.tab, catalog).icon, host: remote(pin.ws) }];
    });
  }, [pins, catalog, projects]);
}

const tooltip = (s: ShownPin) =>
  `${s.label} \u2014 ${s.project.name}${s.host ? ` (${s.host})` : ''}${s.project.archived ? ' \u00b7 archived' : ''}\nClick to open \u00b7 right-click for more \u00b7 Alt+\u2190/\u2192 to move`;

interface Actions {
  onOpen: (pin: Pin) => void;
  onOpenWindow: (pin: Pin) => void;
}

/** Move a pin to where the `to`-th shown pin is. Shown pins can be fewer than the stored
 * ones (a host still loading), so the index is translated into the stored order. */
function moveToShown(shown: ShownPin[], key: string, to: number) {
  const target = shown[Math.max(0, Math.min(shown.length - 1, to))];
  if (!target || target.key === key) return;
  const index = usePins.getState().pins.findIndex((p) => pinKey(p) === target.key);
  if (index >= 0) void usePins.getState().move(key, index);
}

/** The right-click menu of one pin. */
function pinMenu(shown: ShownPin[], index: number, { onOpen, onOpenWindow }: Actions): MenuItem[] {
  const s = shown[index];
  const count = shown.length;
  const move = (k: string, to: number) => moveToShown(shown, k, to);
  const { unpin } = usePins.getState();
  return [
    { label: 'Open', icon: <TabIcon name={s.icon} className="block w-4 h-4" />, onClick: () => onOpen(s.pin) },
    { label: 'Open in new window', icon: '↗', onClick: () => onOpenWindow(s.pin) },
    { label: 'Move left', icon: '←', divider: true, disabled: index === 0, onClick: () => move(s.key, index - 1) },
    { label: 'Move right', icon: '→', disabled: index >= count - 1, onClick: () => move(s.key, index + 1) },
    { label: 'Unpin', icon: <PinGlyph className="block w-4 h-4" />, divider: true, onClick: () => void unpin(s.pin) },
  ];
}

/** A menu opened from the keyboard or a button, at the element. */
const menuEventAt = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { clientX: r.left, clientY: r.bottom + 4, preventDefault() {}, stopPropagation() {} } as unknown as ReactMouseEvent;
};

const GAP = 6; // gap-1.5
const MORE_W = 64;

export default function PinnedTabs({ onOpen, onOpenWindow, projectsView }: Actions & { projectsView: boolean }) {
  const shown = useShownPins();
  const currentTab = usePins((s) => s.currentTab);
  const activeKey = projectsView && currentTab ? `${currentTab.projectKey}:${currentTab.tab}` : null;
  const menu = useContextMenu();
  const actions = { onOpen, onOpenWindow };

  // Fit: measure every chip in an invisible row, then show as many as the width allows.
  const boxRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(shown.length);
  const sig = shown.map((s) => `${s.key}|${s.label}|${s.project.name}`).join('\n');
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => {
      const widths = Array.from(measureRef.current?.children ?? []).map((c) => (c as HTMLElement).offsetWidth);
      setVisible(fitCount(widths, box.clientWidth, GAP, MORE_W));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    return () => ro.disconnect();
  }, [sig]);

  // Drag to reorder: pointer events (TAB_SPEC #9), a 5 px threshold before it's a drag.
  const drag = useRef<{ key: string; x: number; y: number; moved: boolean } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const keyAt = (x: number, y: number) =>
    (document.elementFromPoint(x, y)?.closest('[data-pin-key]') as HTMLElement | null)?.dataset.pinKey ?? null;

  const onKey = (e: KeyboardEvent, s: ShownPin, index: number) => {
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      moveToShown(shown, s.key, index + (e.key === 'ArrowLeft' ? -1 : 1));
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault();
      menu.open(menuEventAt(e.currentTarget as HTMLElement), pinMenu(shown, index, actions));
    }
  };

  const chip = (s: ShownPin, index: number, live: boolean) => {
    const active = s.key === activeKey;
    return (
      <button
        key={s.key}
        type="button"
        data-pin-key={live ? s.key : undefined}
        tabIndex={live ? 0 : -1}
        title={live ? tooltip(s) : undefined}
        aria-label={live ? `${s.label}, ${s.project.name}` : undefined}
        aria-current={active ? 'page' : undefined}
        onPointerDown={
          live
            ? (e) => {
                if (e.button !== 0) return;
                drag.current = { key: s.key, x: e.clientX, y: e.clientY, moved: false };
                e.currentTarget.setPointerCapture(e.pointerId);
              }
            : undefined
        }
        onPointerMove={
          live
            ? (e) => {
                const d = drag.current;
                if (!d) return;
                if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
                d.moved = true;
                setDragKey(d.key);
                const over = keyAt(e.clientX, e.clientY);
                setOverKey(over && over !== d.key ? over : null);
              }
            : undefined
        }
        onPointerUp={
          live
            ? (e) => {
                const d = drag.current;
                drag.current = null;
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                } catch {
                  /* already released */
                }
                setDragKey(null);
                setOverKey(null);
                if (!d) return;
                if (!d.moved) return onOpen(s.pin);
                const over = keyAt(e.clientX, e.clientY);
                const to = over ? shown.findIndex((x) => x.key === over) : -1;
                if (to >= 0 && over !== d.key) moveToShown(shown, d.key, to);
              }
            : undefined
        }
        onPointerCancel={() => {
          drag.current = null;
          setDragKey(null);
          setOverKey(null);
        }}
        onKeyDown={live ? (e) => (e.key === 'Enter' || e.key === ' ' ? (e.preventDefault(), onOpen(s.pin)) : onKey(e, s, index)) : undefined}
        onContextMenu={live ? (e) => menu.open(e, pinMenu(shown, index, actions)) : undefined}
        className={`group flex items-center gap-2 h-[38px] max-w-[11rem] shrink-0 pl-2 pr-2.5 rounded text-left transition-colors touch-none select-none ${
          active ? 'bg-base ring-1 ring-inset ring-gilt-a' : 'hover:bg-surface-0'
        } ${dragKey === s.key ? 'opacity-40' : ''} ${overKey === s.key ? 'ring-2 ring-inset ring-gold' : ''}`}
      >
        <span className={`flex shrink-0 ${active ? 'text-gold' : 'text-subtext-0'}`}>
          <TabIcon name={s.icon} />
        </span>
        <span className="min-w-0 flex flex-col leading-tight">
          <span className={`text-xs font-semibold truncate ${active ? 'text-gold' : 'text-text'}`}>{s.label}</span>
          <span className="text-[11px] text-subtext-0 truncate">{s.project.name}</span>
        </span>
      </button>
    );
  };

  const hidden = shown.slice(visible);
  return (
    // minWidth: the "+N" button always fits, so the bar's fit check sees it.
    <div ref={boxRef} className="relative flex-1 min-w-0 h-full flex items-center" style={{ minWidth: shown.length > 0 ? MORE_W : 0 }} aria-label="Pinned tabs" role="toolbar" data-tauri-drag-region>
      {/* The measuring row: every chip at its natural width, never seen. */}
      <div ref={measureRef} aria-hidden className="absolute left-0 top-0 h-0 overflow-hidden invisible flex gap-1.5 pointer-events-none">
        {shown.map((s, i) => chip(s, i, false))}
      </div>
      <div className="flex items-center gap-1.5 min-w-0" data-tauri-drag-region>
        {shown.slice(0, visible).map((s, i) => chip(s, i, true))}
        {hidden.length > 0 && (
          <button
            type="button"
            title={hidden.map((s) => `${s.label} \u2014 ${s.project.name}`).join('\n')}
            aria-label={`${hidden.length} more pinned tabs`}
            onClick={(e) =>
              menu.open(
                e.detail === 0 ? menuEventAt(e.currentTarget) : e,
                hidden.map((s) => ({ label: `${s.label} \u2014 ${s.project.name}`, icon: <TabIcon name={s.icon} className="block w-4 h-4" />, onClick: () => onOpen(s.pin) })),
              )
            }
            className="h-[38px] shrink-0 px-2.5 rounded text-[13px] font-medium text-subtext-0 hover:text-text hover:bg-surface-0 tabular-nums"
            style={{ minWidth: MORE_W - 8 }}
          >
            +{hidden.length} ▾
          </button>
        )}
      </div>
      {menu.element}
    </div>
  );
}

/** Every pin, with open / new window / move / unpin: the overview popover's section. */
export function PinnedTabsManager({ onOpen, onOpenWindow }: Actions) {
  const shown = useShownPins();
  const { unpin } = usePins.getState();
  const move = (key: string, to: number) => moveToShown(shown, key, to);
  const btn = 'w-8 h-8 grid place-items-center rounded text-subtext-0 hover:text-text hover:bg-surface-1 disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <div className="space-y-1">
      <div className="g-deco text-[11px] font-semibold text-subtext-0">Pinned tabs</div>
      {shown.length === 0 ? (
        <p className="text-xs text-subtext-0 px-1 py-1.5">
          Pin a project's tab with <PinGlyph className="inline w-3.5 h-3.5 -mt-0.5" /> in its tab bar to reach it from anywhere.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {shown.map((s, i) => (
            <li key={s.key} className="flex items-center gap-0.5 rounded hover:bg-surface-0 pr-1">
              <button type="button" onClick={() => onOpen(s.pin)} title={tooltip(s)} className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left">
                <span className="flex shrink-0 text-subtext-0">
                  <TabIcon name={s.icon} />
                </span>
                <span className="min-w-0 flex flex-col leading-tight">
                  <span className="text-xs font-medium text-text truncate">{s.label}</span>
                  <span className="text-[11px] text-subtext-0 truncate">
                    {s.project.name}
                    {s.host ? ` \u00b7 ${s.host}` : ''}
                  </span>
                </span>
              </button>
              <button type="button" className={btn} title="Move up" aria-label={`Move ${s.label} up`} disabled={i === 0} onClick={() => move(s.key, i - 1)}>
                ↑
              </button>
              <button type="button" className={btn} title="Move down" aria-label={`Move ${s.label} down`} disabled={i === shown.length - 1} onClick={() => move(s.key, i + 1)}>
                ↓
              </button>
              <button type="button" className={btn} title="Open in new window" aria-label={`Open ${s.label} in a new window`} onClick={() => onOpenWindow(s.pin)}>
                ↗
              </button>
              <button type="button" className={btn} title="Unpin" aria-label={`Unpin ${s.label}`} onClick={() => void unpin(s.pin)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

/**
 * Resizable panel widths (docs/dev/GILT.md). A width is a cosmetic, per-device
 * preference, so it lives in localStorage (docs/dev/TAB_SPEC.md allows that):
 * `ganban.pane.<id>` holds the width in px, `ganban.pane.<id>.collapsed` holds
 * '1' while collapsed. Every pane with the same id shares one width, live:
 * drag one and the others follow.
 */

const widthKey = (id: string) => `ganban.pane.${id}`;
const collapsedKey = (id: string) => `ganban.pane.${id}.collapsed`;

const listeners = new Map<string, Set<() => void>>();
function subscribe(key: string, fn: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === key) fn();
  };
  window.addEventListener('storage', onStorage); // other windows of the app
  return () => {
    set!.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage full or blocked: the width just won't persist */
  }
  listeners.get(key)?.forEach((fn) => fn());
}

function useStored(key: string): string | null {
  return useSyncExternalStore(
    useCallback((fn: () => void) => subscribe(key, fn), [key]),
    () => read(key),
    () => null,
  );
}

/** The window's width, kept current. */
function useWindowWidth(): number {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

/** A pane's persisted collapsed state, for the parent that toggles it. */
export function usePaneCollapsed(id: string) {
  const key = collapsedKey(id);
  const collapsed = useStored(key) === '1';
  const setCollapsed = useCallback((v: boolean) => write(key, v ? '1' : null), [key]);
  const toggleCollapsed = useCallback(() => write(key, read(key) === '1' ? null : '1'), [key]);
  return { collapsed, setCollapsed, toggleCollapsed };
}

export interface ResizableWidthOptions {
  /** Which side of the layout the pane sits on. Its handle is on the inner
   * edge: a right pane's handle is on its left, and dragging left widens it. */
  side: 'left' | 'right';
  min: number;
  max: number;
  defaultWidth: number;
  /** Space kept for the rest of the window: the width never exceeds
   * `window.innerWidth - reserve` (default 320), nor drops below `min`. */
  reserve?: number;
  /** Arrow-key step on the focused handle, px (default 16). */
  step?: number;
}

export function useResizableWidth(id: string, opts: ResizableWidthOptions) {
  const { side, min, max, defaultWidth, reserve = 320, step = 16 } = opts;
  const key = widthKey(id);
  const stored = Number(useStored(key));
  const windowWidth = useWindowWidth();
  const upper = Math.max(min, Math.min(max, windowWidth - reserve));
  const clamp = useCallback((w: number) => Math.round(Math.min(upper, Math.max(min, w))), [min, upper]);

  // While dragging, the width is local state (no storage write per frame); it
  // is written once on release.
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const base = Number.isFinite(stored) && stored > 0 ? stored : defaultWidth;
  const width = clamp(dragWidth ?? base);

  const drag = useRef<{ startX: number; startW: number; w: number; pointerId: number } | null>(null);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { startX: e.clientX, startW: width, w: width, pointerId: e.pointerId };
      setDragWidth(width);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );
  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const dx = e.clientX - d.startX;
      d.w = clamp(side === 'right' ? d.startW - dx : d.startW + dx);
      setDragWidth(d.w);
    },
    [clamp, side],
  );
  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.pointerId !== e.pointerId) return;
      drag.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // A click without movement (or the first click of a double-click)
      // writes nothing, so it can't pin the default as a stored width.
      if (d.w !== d.startW) write(key, String(d.w));
      setDragWidth(null);
    },
    [key],
  );
  // A drag interrupted by unmount must not leave the cursor stuck.
  useEffect(
    () => () => {
      if (drag.current) {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    },
    [],
  );

  const reset = useCallback(() => write(key, null), [key]);
  const setWidth = useCallback((w: number) => write(key, String(clamp(w))), [clamp, key]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLElement>) => {
      const grow = side === 'right' ? 'ArrowLeft' : 'ArrowRight';
      const shrink = side === 'right' ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === grow) setWidth(width + step);
      else if (e.key === shrink) setWidth(width - step);
      else if (e.key === 'Home') setWidth(min);
      else if (e.key === 'End') setWidth(upper);
      else if (e.key === 'Enter') reset();
      else return;
      e.preventDefault();
    },
    [min, reset, setWidth, side, step, upper, width],
  );

  /** Spread on the drag handle. */
  const handleProps = {
    role: 'separator',
    'aria-orientation': 'vertical' as const,
    'aria-valuemin': min,
    'aria-valuemax': upper,
    'aria-valuenow': width,
    'aria-label': 'Resize panel (double-click to reset)',
    tabIndex: 0,
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onDoubleClick: reset,
    onKeyDown,
  };

  return { width, dragging: dragWidth !== null, reset, setWidth, handleProps };
}

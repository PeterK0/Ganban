import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const PANEL_WIDTH = 320; // px (was w-80)
const MARGIN = 12; // keep this far from the viewport edge
const GAP = 8; // gap between the trigger and the panel (was mt-2)
const HEADER = 44; // approx height of the panel's title bar (kept out of the scroll area)
const MAX_BODY = 320; // cap the scrollable list height (was max-h-80)

/** A bare tile's cell in a Gilt stats card (`g-card grid grid-cols-2
 * md:grid-cols-4`): gilt dividers between the cells, two rows on narrow
 * windows. Home's and a project's stats cards share it. */
export const STAT_CELL =
  'border-gilt-b [&:nth-child(even)]:border-l [&:nth-child(n+3)]:border-t md:[&:nth-child(n+3)]:border-t-0 md:[&:not(:first-child)]:border-l';

/** A dashboard tile that toggles a notification-style pop-up. The panel is
 * rendered through a portal into document.body and positioned with fixed
 * coordinates from the trigger's rect — so it can't be clipped by the
 * `overflow-y-auto` scroll containers or hidden behind the detail pane. The
 * visible tile content is passed as `tile`; the rows are the children. Shared
 * by HomeBoard and ProjectHome. */
export function PopoverShell({
  active,
  onToggle,
  tile,
  title,
  empty,
  onClose,
  children,
  bare,
  className,
}: {
  /** No border or fill of its own: the tile sits inside a parent card (Home's
   * Gilt stats strip). The default keeps the standalone tile look. */
  bare?: boolean;
  /** Extra classes on the wrapper (e.g. a grid cell's dividers). */
  className?: string;
  active: boolean;
  onToggle: () => void;
  tile: ReactNode;
  title: string;
  empty?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; openUp: boolean; width: number; bodyMax: number } | null>(
    null
  );

  const recompute = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Width: cap to the viewport so a very narrow window can't clip the right edge.
    const width = Math.min(PANEL_WIDTH, vw - 2 * MARGIN);
    // Center under the trigger, then clamp horizontally to the viewport.
    let left = r.left + r.width / 2 - width / 2;
    left = Math.max(MARGIN, Math.min(left, vw - width - MARGIN));
    // Vertical space available above/below the trigger (gap + viewport margin reserved).
    const spaceBelow = vh - r.bottom - GAP - MARGIN;
    const spaceAbove = r.top - GAP - MARGIN;
    // Open below by default; flip above only when there's too little room below AND more above.
    const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
    const avail = Math.max(120, openUp ? spaceAbove : spaceBelow);
    // Cap the scroll body so the whole panel (incl. header) stays within `avail`,
    // which keeps the header + close button on-screen even when opening upward.
    const bodyMax = Math.min(MAX_BODY, avail - HEADER);
    const top = openUp ? r.top - GAP : r.bottom + GAP;
    setPos({ left, top, openUp, width, bodyMax });
  }, []);

  // Measure before paint when opening; keep glued to the trigger on scroll/resize.
  // (Recompute rather than close on scroll, so scrolling the panel's own list
  // doesn't dismiss it.)
  useLayoutEffect(() => {
    if (!active) return;
    recompute();
    const onScroll = () => recompute();
    const onResize = () => recompute();
    window.addEventListener('scroll', onScroll, true); // capture: also catch inner scrollers
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [active, recompute]);

  return (
    <div className={className ? `relative ${className}` : 'relative'}>
      <button
        ref={triggerRef}
        onClick={onToggle}
        aria-expanded={active}
        className={
          bare
            ? `w-full h-full text-center transition-colors hover:bg-gilt-b ${active ? 'bg-gilt-b' : ''}`
            : `g-card w-full text-left transition-colors hover:bg-surface-0 ${active ? 'border-gold' : ''}`
        }
      >
        {tile}
      </button>

      {active &&
        pos &&
        createPortal(
          <>
            {/* click-away catcher */}
            <div className="fixed inset-0 z-40" onClick={onClose} />
            <div
              role="dialog"
              style={{
                position: 'fixed',
                left: pos.left,
                top: pos.top,
                width: pos.width,
                transform: pos.openUp ? 'translateY(-100%)' : undefined,
              }}
              className="g-card z-50 shadow-xl overflow-hidden"
            >
              <div className="pl-4 pr-2 py-1 border-b border-gilt-b flex items-center justify-between">
                <span className="g-deco text-xs font-semibold text-gold">{title}</span>
                <button onClick={onClose} className="g-iconbtn text-sm" title="Close" aria-label="Close">
                  ✕
                </button>
              </div>
              <div className="overflow-y-auto py-1" style={{ maxHeight: pos.bodyMax }}>
                {empty ? (
                  <p className="px-3 py-4 text-sm text-[color:var(--g-mut)] text-center">Nothing here yet.</p>
                ) : (
                  children
                )}
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  );
}

export function PopoverRow({
  primary,
  secondary,
  dot,
  mark,
  onClick,
}: {
  primary: string;
  secondary?: string;
  /** Background class for a small round dot. */
  dot?: string;
  /** Classes for a self-styled marker (e.g. a Gilt `g-st` status mark). */
  mark?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-4 py-2 hover:bg-surface-0 transition-colors flex items-center gap-2.5"
    >
      {mark && <span className={mark} aria-hidden="true" />}
      {dot && <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />}
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-text truncate">{primary}</span>
        {secondary && <span className="block text-xs text-[color:var(--g-mut)] truncate">{secondary}</span>}
      </span>
    </button>
  );
}

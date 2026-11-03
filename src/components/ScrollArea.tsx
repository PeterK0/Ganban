import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A scroll container with a custom, theme-correct scrollbar.
 *
 * WHY THIS EXISTS: WKWebView (Tauri's macOS webview) has a long-standing bug
 * where ::-webkit-scrollbar-track background rendering is unreliable — the
 * track renders white regardless of CSS, whether via var() or hardcoded hex.
 * This component hides the native scrollbar entirely and renders a custom
 * track + thumb driven by real scroll events, so the scrollbar always matches
 * the theme.
 *
 * Supports vertical and/or horizontal scroll, thumb drag, track click-to-jump,
 * and auto-hide (the scrollbar fades in on hover/scroll, out when idle).
 *
 * Scrolling renders nothing: the thumb's position is written straight to its
 * style, at most once per animation frame. Only the thumb appearing or going
 * (and the auto-hide flags) are React state. A React render per scroll event
 * made long pages (Home, Project > Home) scroll choppily in WKWebView.
 *
 * Usage: wrap your scrollable content. The content inside should be the
 * natural-flow child (no fixed heights — the ScrollArea handles overflow).
 */
interface ScrollAreaProps {
  children: ReactNode;
  className?: string;
  /** Classes for the CONTENT wrapper inside the scroller. Spacing utilities
   * (space-y-*, gap-*) and padding belong HERE: on `className` they land on
   * the outer wrapper, whose only child is the scroll viewport — so child
   * spacing silently does nothing (the crammed-outlines bug, 2026-07-02). */
  contentClassName?: string;
  /** Scroll direction. 'both' = vertical + horizontal. */
  direction?: 'vertical' | 'horizontal' | 'both';
  /** Auto-hide the scrollbar when idle (not scrolling / not hovering). */
  autoHide?: boolean;
  /** Thumb thickness in px. */
  thumbSize?: number;
  /** Optional ref to the inner scroll element, for callers that need
   * imperative scroll control (programmatic scrollTo, IntersectionObserver
   * root, scrollTop reads). Merged with the internal ref. */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  /** Optional scroll listener forwarded from the inner scroll element, for
   * callers (e.g. PdfTab's ScrollViewer) that track the visible page or free
   * far-away canvases on scroll. Fires alongside the internal thumb update. */
  onScroll?: () => void;
}

export default function ScrollArea({
  children,
  className = '',
  contentClassName,
  direction = 'vertical',
  autoHide = false,
  thumbSize = 8,
  scrollRef: externalScrollRef,
  onScroll: externalOnScroll,
}: ScrollAreaProps) {
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  // Mirror to the caller's ref too, so they get the same scroll element for
  // imperative control (programmatic scrollTo, IO root, scrollTop reads).
  const scrollRef = externalScrollRef ?? internalScrollRef;
  const [vVisible, setVVisible] = useState(false);
  const [hVisible, setHVisible] = useState(false);
  // The thumbs' geometry lives outside React (see the header comment).
  const vThumb = useRef({ top: 0, height: 0 });
  const hThumb = useRef({ left: 0, width: 0 });
  const vThumbEl = useRef<HTMLDivElement | null>(null);
  const hThumbEl = useRef<HTMLDivElement | null>(null);
  const frame = useRef(0);
  const [hovering, setHovering] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragRef = useRef<{ axis: 'v' | 'h'; startMouse: number; startScroll: number } | null>(null);

  const paintThumbs = useCallback(() => {
    const v = vThumbEl.current;
    if (v) { v.style.top = `${vThumb.current.top}px`; v.style.height = `${vThumb.current.height}px`; }
    const h = hThumbEl.current;
    if (h) { h.style.left = `${hThumb.current.left}px`; h.style.width = `${hThumb.current.width}px`; }
  }, []);

  const update = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const showV = direction !== 'horizontal' && el.scrollHeight > el.clientHeight + 1;
    const showH = direction !== 'vertical' && el.scrollWidth > el.clientWidth + 1;

    if (showV) {
      const ratio = el.clientHeight / el.scrollHeight;
      const thumbH = Math.max(thumbSize * 2, el.clientHeight * ratio);
      const maxTop = el.clientHeight - thumbH;
      const top = maxTop > 0 ? (el.scrollTop / (el.scrollHeight - el.clientHeight)) * maxTop : 0;
      vThumb.current = { top, height: thumbH };
    }
    // Same-value sets don't re-render (an object here once re-rendered every
    // call, which with a MutationObserver looped).
    setVVisible(showV);

    if (showH) {
      const ratio = el.clientWidth / el.scrollWidth;
      const thumbW = Math.max(thumbSize * 2, el.clientWidth * ratio);
      const maxLeft = el.clientWidth - thumbW;
      const left = maxLeft > 0 ? (el.scrollLeft / (el.scrollWidth - el.clientWidth)) * maxLeft : 0;
      hThumb.current = { left, width: thumbW };
    }
    setHVisible(showH);
    paintThumbs();
  }, [direction, thumbSize, paintThumbs]);

  // A thumb that just appeared gets its geometry before the first paint.
  useLayoutEffect(paintThumbs, [vVisible, hVisible, paintThumbs]);
  useEffect(() => () => { cancelAnimationFrame(frame.current); frame.current = 0; }, []);

  useEffect(() => {
    update();
    // ResizeObserver fires when the element's size changes (content loads,
    // window resizes, etc.) — the only observer we need. A MutationObserver
    // was here before but it fired on every React re-render (React adds/removes
    // DOM nodes during reconciliation) → update() → new state → re-render →
    // observer fires again → infinite loop ("Too many re-renders").
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    // Also observe direct children size changes (e.g. lazy-loaded content
    // that grows the scrollHeight without resizing the container).
    const childObserver = new ResizeObserver(() => update());
    Array.from(el.children).forEach((child) => childObserver.observe(child));
    return () => { ro.disconnect(); childObserver.disconnect(); };
  }, [update]);

  const onScroll = () => {
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        update();
      });
    }
    externalOnScroll?.();
    if (autoHide) {
      setScrolling(true);
      clearTimeout(scrollTimer.current);
      scrollTimer.current = setTimeout(() => setScrolling(false), 800);
    }
  };

  // Thumb drag (pointer events — WKWebView-safe, same as the Kanban DnD).
  const onThumbPointerDown = (e: React.PointerEvent, axis: 'v' | 'h') => {
    e.preventDefault();
    e.stopPropagation();
    const el = scrollRef.current;
    if (!el) return;
    dragRef.current = {
      axis,
      startMouse: axis === 'v' ? e.clientY : e.clientX,
      startScroll: axis === 'v' ? el.scrollTop : el.scrollLeft,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onThumbPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const el = scrollRef.current;
    if (!d || !el) return;
    e.preventDefault();
    if (d.axis === 'v') {
      const delta = e.clientY - d.startMouse;
      const ratio = el.scrollHeight / el.clientHeight;
      el.scrollTop = d.startScroll + delta * ratio;
    } else {
      const delta = e.clientX - d.startMouse;
      const ratio = el.scrollWidth / el.clientWidth;
      el.scrollLeft = d.startScroll + delta * ratio;
    }
  };
  const onThumbPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  // Track click → jump one viewport toward the click.
  const onTrackClick = (e: React.MouseEvent, axis: 'v' | 'h') => {
    const el = scrollRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (axis === 'v') {
      const clickY = e.clientY - rect.top;
      const thumbCenter = vThumb.current.top + vThumb.current.height / 2;
      el.scrollTop += clickY < thumbCenter ? -el.clientHeight : el.clientHeight;
    } else {
      const clickX = e.clientX - rect.left;
      const thumbCenter = hThumb.current.left + hThumb.current.width / 2;
      el.scrollLeft += clickX < thumbCenter ? -el.clientWidth : el.clientWidth;
    }
  };

  const showScrollbar = !autoHide || hovering || scrolling;

  return (
    <div
      className={`relative overflow-hidden ${className}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full w-full overflow-auto scrollbar-none"
        style={{ scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch' }}
      >
        {/* The off-axis is clamped at the CONTENT, not the scroller: mixing
            overflow hidden+auto on one box shifts WebKit's scrollbar mode,
            while overflow-clip here simply refuses to be scrollable — a
            too-wide child (native select, long code line) can no longer
            trackpad-shove 'vertical' areas side to side. */}
        <div
          className={`${
            // h-full everywhere: children used to resolve %-heights against
            // the scroller box; the wrapper must keep that reference (growth
            // past 100% still propagates through visible overflow).
            direction === 'vertical' ? 'h-full max-w-full overflow-x-clip'
              : direction === 'horizontal' ? 'h-full max-h-full overflow-y-clip'
              : 'h-full'
          } ${contentClassName ?? ''}`}
        >
          {children}
        </div>
      </div>

      {/* Vertical custom scrollbar */}
      {vVisible && (
        <div
          className={`absolute top-0 right-0 w-2 h-full transition-opacity duration-200 ${showScrollbar ? 'opacity-100' : 'opacity-0'}`}
          style={{ pointerEvents: showScrollbar ? 'auto' : 'none' }}
          onClick={(e) => onTrackClick(e, 'v')}
        >
          <div
            ref={vThumbEl}
            onPointerDown={(e) => onThumbPointerDown(e, 'v')}
            onPointerMove={onThumbPointerMove}
            onPointerUp={onThumbPointerUp}
            className="absolute right-0.5 rounded-full cursor-pointer touch-none"
            style={{
              width: thumbSize - 2,
              background: 'var(--color-surface-2)',
            }}
          />
        </div>
      )}

      {/* Horizontal custom scrollbar */}
      {hVisible && (
        <div
          className={`absolute bottom-0 left-0 h-2 w-full transition-opacity duration-200 ${showScrollbar ? 'opacity-100' : 'opacity-0'}`}
          style={{ pointerEvents: showScrollbar ? 'auto' : 'none' }}
          onClick={(e) => onTrackClick(e, 'h')}
        >
          <div
            ref={hThumbEl}
            onPointerDown={(e) => onThumbPointerDown(e, 'h')}
            onPointerMove={onThumbPointerMove}
            onPointerUp={onThumbPointerUp}
            className="absolute bottom-0.5 rounded-full cursor-pointer touch-none"
            style={{
              height: thumbSize - 2,
              background: 'var(--color-surface-2)',
            }}
          />
        </div>
      )}
    </div>
  );
}

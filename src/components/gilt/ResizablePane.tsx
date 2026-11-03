import type { CSSProperties, ReactNode } from 'react';
import { usePaneCollapsed, useResizableWidth } from './useResizableWidth';

interface ResizablePaneProps {
  /** Storage id: the width lives under `ganban.pane.<id>`; panes sharing an id share a width. */
  id: string;
  side: 'left' | 'right';
  min: number;
  max: number;
  defaultWidth: number;
  /** Allows a collapsed state. Uncontrolled, it persists under
   * `ganban.pane.<id>.collapsed` and the parent toggles it with
   * `usePaneCollapsed(id)`; or pass `collapsed` to control it. */
  collapsible?: boolean;
  /** Controlled collapsed state (needs `collapsible`). */
  collapsed?: boolean;
  /** Width while collapsed, px (default 0, i.e. hidden; e.g. 56 for an icon rail). */
  collapsedWidth?: number;
  /** Classes on the pane (border, background). */
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/** A panel with a drag handle on its inner edge (docs/dev/GILT.md): drag to
 * resize, double-click the handle to reset, arrow keys when it has focus.
 * The content keeps the pane's full width while a collapse animates, so it
 * slides out instead of reflowing. */
export default function ResizablePane({
  id,
  side,
  min,
  max,
  defaultWidth,
  collapsible,
  collapsed: collapsedProp,
  collapsedWidth = 0,
  className,
  style,
  children,
}: ResizablePaneProps) {
  const { width, dragging, handleProps } = useResizableWidth(id, { side, min, max, defaultWidth });
  const stored = usePaneCollapsed(id);
  const collapsed = !!collapsible && (collapsedProp ?? stored.collapsed);
  const outer = collapsed ? collapsedWidth : width;

  return (
    <div
      className={`relative shrink-0 overflow-hidden ${dragging ? '' : 'transition-[width] duration-200'} ${className ?? ''}`}
      style={{ ...style, width: outer, ...(collapsed && collapsedWidth === 0 ? { borderWidth: 0 } : null) }}
      data-pane={id}
    >
      <div className="h-full" style={{ width: collapsed && collapsedWidth > 0 ? collapsedWidth : width }}>
        {children}
      </div>
      {!collapsed && <PaneHandle side={side} dragging={dragging} handleProps={handleProps} />}
    </div>
  );
}

type HandleProps = ReturnType<typeof useResizableWidth>['handleProps'];

/** The 6px drag handle on a pane's inner edge, with a gold line on hover and
 * while dragging. Exported for layouts that use `useResizableWidth` directly
 * (the parent must be `position: relative`). */
export function PaneHandle({
  side,
  dragging,
  handleProps,
}: {
  side: 'left' | 'right';
  dragging: boolean;
  handleProps: HandleProps;
}) {
  return (
    <div
      {...handleProps}
      className={`group absolute top-0 bottom-0 z-20 w-1.5 cursor-col-resize touch-none outline-none ${
        side === 'right' ? 'left-0' : 'right-0'
      }`}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute top-0 bottom-0 w-0.5 bg-gold transition-opacity duration-150 ${
          side === 'right' ? 'left-0' : 'right-0'
        } ${dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}`}
      />
    </div>
  );
}

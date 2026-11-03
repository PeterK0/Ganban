import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// The app-wide right-click menu. One component, one contract:
//   const menu = useContextMenu();
//   <div onContextMenu={(e) => menu.open(e, [{ label: 'Open', onClick: … }])}>
//   {menu.element}
// The default webview menu (Reload / Inspect Element) is suppressed globally
// in App.tsx — EXCEPT inside editable fields, where the native menu is the
// copy/paste surface and stays.

export interface MenuItem {
  label: string;
  /** Emoji string or any node (e.g. a colored status dot). */
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** A separator before this item. */
  divider?: boolean;
  /** Submenu items (one level — rendered inline, indented, on hover/click). */
  children?: MenuItem[];
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function useContextMenu() {
  const [state, setState] = useState<MenuState | null>(null);
  const open = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    if (items.length === 0) return;
    setState({ x: e.clientX, y: e.clientY, items });
  };
  const close = () => setState(null);
  const element = state ? <ContextMenuPopup state={state} onClose={close} /> : null;
  return { open, close, element };
}

function ContextMenuPopup({ state, onClose }: { state: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ left: state.x, top: state.y });
  const [openSub, setOpenSub] = useState<number | null>(null);

  // Clamp to the viewport once we know our size.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.min(state.x, window.innerWidth - r.width - 8),
      top: Math.min(state.y, window.innerHeight - r.height - 8),
    });
  }, [state, openSub]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Any scroll or another context-menu elsewhere dismisses.
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose]);

  const renderItem = (it: MenuItem, i: number, depth = 0) => (
    <div key={`${depth}-${i}`}>
      {it.divider && <div className="my-1.5 border-t border-gilt-b" />}
      <button
        disabled={it.disabled}
        onClick={() => {
          if (it.children) {
            setOpenSub(openSub === i ? null : i);
            return;
          }
          onClose();
          it.onClick?.();
        }}
        className={`w-full flex items-center gap-2 px-2.5 min-h-[32px] text-left text-[13px] rounded disabled:opacity-40 ${
          it.danger ? 'text-error hover:bg-error/10' : 'text-text hover:bg-surface-0'
        } ${depth > 0 ? 'pl-7' : ''}`}
      >
        {it.icon && <span className="w-4 text-center shrink-0">{it.icon}</span>}
        <span className="truncate flex-1">{it.label}</span>
        {it.children && <span className="text-subtext-0 text-[11px]">{openSub === i ? '▾' : '▸'}</span>}
      </button>
      {it.children && openSub === i && it.children.map((c, j) => renderItem(c, j, depth + 1))}
    </div>
  );

  return createPortal(
    <div
      ref={ref}
      style={{ left: pos.left, top: pos.top }}
      className="g-card fixed z-[200] min-w-44 max-w-72 shadow-2xl p-2"
      onContextMenu={(e) => e.preventDefault()}
    >
      {state.items.map((it, i) => renderItem(it, i))}
    </div>,
    document.body
  );
}

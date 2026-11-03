import { useState, type ReactNode } from 'react';
import { DecoHeading } from '../gilt';

/**
 * A collapsible section heading ("▾ Updates"), remembered per surface in
 * localStorage (a cosmetic preference — TAB_SPEC allows it). Collapsed
 * sections render only a {@link CollapsedNote}, so they fetch nothing.
 */
export function useCollapsed(key: string): [boolean, () => void] {
  const storageKey = `ganban:collapsed:${key}`;
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(storageKey, c ? '0' : '1');
      } catch {
        /* private mode — just don't remember */
      }
      return !c;
    });
  return [collapsed, toggle];
}

/**
 * What a collapsed section shows instead of its content: a slim card that says
 * the section is hidden and brings it back. A bare "▶ Updates" heading read as
 * a missing widget.
 */
export function CollapsedNote({ label, onShow }: { label: string; onShow: () => void }) {
  return (
    <button
      onClick={onShow}
      className="g-plain w-full flex items-center gap-2 px-3.5 min-h-[44px] text-left text-sm text-subtext-0 hover:!border-gilt-a hover:text-text transition-colors"
    >
      <span>{label} are hidden on this page.</span>
      <span className="ml-auto g-lnk">Show {label.toLowerCase()}</span>
    </button>
  );
}

/**
 * A collapsible section's heading: Gilt's centred deco heading between two
 * diamonds (`g-h2`), whose title is the collapse toggle. An optional `action`
 * (e.g. "Open the board →") sits on the right without pulling the title off
 * centre. Home's and a project's Updates share it.
 */
export function SectionToggle({
  label,
  collapsed,
  onToggle,
  action,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  action?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 mb-4">
      <span aria-hidden="true" />
      <DecoHeading className="mb-0">
        <button
          onClick={onToggle}
          aria-expanded={!collapsed}
          title={collapsed ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`}
          className="inline-flex items-center gap-2 uppercase hover:text-text min-h-[32px] -my-2"
        >
          {label}
          <span className={`inline-block text-[9px] transition-transform ${collapsed ? '' : 'rotate-90'}`} aria-hidden="true">
            ▶
          </span>
        </button>
      </DecoHeading>
      <div className="justify-self-end min-w-0">{action}</div>
    </div>
  );
}

/** The centred, readable-width column a section's feed sits in, so it stays
 * centred inside a full-width card on an ultrawide too. */
export const FEED_COLUMN = 'mx-auto w-full max-w-[900px] min-w-0';

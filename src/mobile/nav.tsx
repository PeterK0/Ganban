import { createContext, useContext, type ReactNode } from "react";

/** Imperative navigation for the mobile drill-down stack. */
export interface Nav {
  /** Push a screen onto the stack (renders over the current tab). */
  push: (node: ReactNode) => void;
  /** Pop the top screen. */
  pop: () => void;
  /** Pop everything back to the current tab root. */
  popToRoot: () => void;
}

export const NavContext = createContext<Nav | null>(null);

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("useNav must be used inside the mobile app");
  return nav;
}

// ---- Gilt chrome (docs/dev/GILT.md): the top header and the tab bar ----

/** The prototype's torii mark, in the theme's red (the prototype's --torii). */
export function Torii({ className = "w-7 h-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={`shrink-0 text-error ${className}`} aria-hidden="true">
      <path d="M2 5c5 2 23 2 28 0v4.5H2z" fill="currentColor" />
      <rect x="5" y="12" width="22" height="3" fill="currentColor" />
      <rect x="8" y="9" width="3.4" height="21" fill="currentColor" />
      <rect x="20.6" y="9" width="3.4" height="21" fill="currentColor" />
      <rect x="14.6" y="9" width="2.8" height="4" fill="currentColor" />
    </svg>
  );
}

/** A screen's top header: crust, a gold hairline under it, the torii (or a back
 * button on a pushed screen) and a deco title. Keeps the top safe-area inset. */
export function TopBar({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string;
  subtitle?: ReactNode;
  onBack?: () => void;
  right?: ReactNode;
}) {
  return (
    <header
      className="sticky top-0 z-10 bg-crust border-b border-gilt-a text-text"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="flex items-center gap-2 px-2 min-h-[56px]">
        {onBack ? (
          <button onClick={onBack} className="g-iconbtn w-11 h-11 text-gold active:bg-surface-0" aria-label="Back">
            <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
              <path d="M15 5l-7 7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        ) : (
          <span className="w-11 h-11 flex items-center justify-center">
            <Torii />
          </span>
        )}
        <div className="flex-1 min-w-0 py-1.5">
          <h1 className="g-deco text-[15px] font-semibold text-gold truncate leading-snug pt-0.5" style={{ letterSpacing: "0.16em" }}>
            {title}
          </h1>
          {subtitle && <div className="gm-mut text-xs truncate">{subtitle}</div>}
        </div>
        {right}
      </div>
    </header>
  );
}

/** The bottom tab bar: crust with a gold hairline above; the current tab is gold
 * and carries a gold diamond on the hairline. Keeps the bottom safe-area inset. */
export function TabBar<K extends string>({
  tabs,
  current,
  onSelect,
}: {
  tabs: { key: K; label: string; icon: ReactNode }[];
  current: K;
  onSelect: (key: K) => void;
}) {
  return (
    <nav className="flex bg-crust border-t border-gilt-a" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
      {tabs.map((t) => {
        const on = t.key === current;
        return (
          <button
            key={t.key}
            onClick={() => onSelect(t.key)}
            aria-current={on ? "page" : undefined}
            className={`relative flex-1 min-w-0 min-h-[56px] flex flex-col items-center justify-center gap-1 pt-2 pb-1.5 active:bg-surface-0 ${
              on ? "text-gold" : "gm-mut"
            }`}
          >
            {on && <span className="g-gem absolute" style={{ top: -4.5, left: "calc(50% - 4px)" }} aria-hidden="true" />}
            {t.icon}
            <span className="g-deco text-[10px] font-semibold truncate max-w-full px-1" style={{ letterSpacing: "0.12em" }}>
              {t.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

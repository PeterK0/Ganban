// The sidebar's rail views of tab modules (src/tabs/modules.ts `rail`, src/store/railTabs.ts): their
// buttons under the built-in views, and the view itself in the main area. A view is `rail:<id>` in
// App's view state.
import { Suspense, createContext, useContext } from 'react';
import { TabIcon } from './icons/TabIcon';
import TabErrorBoundary from './TabErrorBoundary';
import { useRailTabs, shownRails } from '../store/railTabs';
import { TAB_MODULES } from '../tabs/modules';

export const RAIL_VIEW_PREFIX = 'rail:';
export const railView = (id: string) => `${RAIL_VIEW_PREFIX}${id}` as const;

/**
 * Which shell a rail view is mounted in. The phone shell (`src/mobile`) gives the view its own
 * header and back button, so a view in `touch` drops its page title and uses the phone's patterns.
 */
export const RailShellContext = createContext<'desktop' | 'touch'>('desktop');
export const useRailShell = () => useContext(RailShellContext);

/** The modules the sidebar shows now. */
export function useShownRails() {
  const hostTabs = useRailTabs((s) => s.hostTabs);
  const on = useRailTabs((s) => s.on);
  return shownRails(hostTabs, on);
}

/** The rail buttons, styled as the sidebar's own (collapsed: icons only). */
export function RailNavButtons({ collapsed, current, onGo }: { collapsed: boolean; current: string; onGo: (view: `rail:${string}`) => void }) {
  const rails = useShownRails();
  return (
    <>
      {rails.map((m) => {
        const view = railView(m.id);
        const on = current === view;
        const rail = m.rail!;
        return collapsed ? (
          <button
            key={m.id}
            onClick={() => onGo(view)}
            title={rail.label}
            aria-label={rail.label}
            aria-current={on ? 'page' : undefined}
            className={`relative w-10 h-10 grid place-items-center rounded transition-colors ${
              on ? 'bg-base text-gold ring-1 ring-inset ring-gilt-a' : 'text-subtext-1 hover:bg-surface-0 hover:text-text'
            }`}
          >
            <TabIcon name={rail.icon} className="w-[18px] h-[18px]" />
          </button>
        ) : (
          <button
            key={m.id}
            onClick={() => onGo(view)}
            aria-current={on ? 'page' : undefined}
            className={`w-full flex items-center gap-3 min-h-[38px] px-3 rounded font-medium text-left transition-colors ${
              on ? 'bg-base text-gold ring-1 ring-inset ring-gilt-a' : 'text-subtext-1 hover:bg-surface-0 hover:text-text'
            }`}
          >
            <TabIcon name={rail.icon} className="w-[18px] h-[18px]" />
            <span className="flex-1 min-w-0 truncate">{rail.label}</span>
            <span className={`shrink-0 w-1.5 h-1.5 bg-gold rotate-45 ${on ? 'opacity-100' : 'opacity-0'}`} aria-hidden="true" />
          </button>
        );
      })}
    </>
  );
}

/** The rail view for `view` (`rail:<id>`), or null when it isn't one the sidebar shows. */
export function RailViewHost({ view }: { view: string }) {
  const rails = useShownRails();
  const id = view.slice(RAIL_VIEW_PREFIX.length);
  const m = rails.find((r) => r.id === id) ?? null;
  if (!m?.rail) return null;
  const View = m.rail.view;
  return (
    <TabErrorBoundary>
      <Suspense fallback={<div className="h-full bg-mantle" />}>
        <View />
      </Suspense>
    </TabErrorBoundary>
  );
}

/** Whether `view` is a rail view of a module this build has. */
export const isRailView = (view: string) =>
  view.startsWith(RAIL_VIEW_PREFIX) && TAB_MODULES.some((m) => m.rail && m.id === view.slice(RAIL_VIEW_PREFIX.length));

import type { ComponentType, LazyExoticComponent, ReactNode } from "react";
import type { TabIconName } from "../components/icons/TabIcon";
import { registerSubView, type Pin, type SubViewDef } from "../lib/pinnedTabs.pure";

/**
 * Tab modules: a tab that lives in its own folder can bring everything it needs
 * with a `src/tabs/<folder>/module.tsx` whose default export is a `TabModule`.
 * They're found at build time (`import.meta.glob`), so a build without the
 * folder simply has no such tab: no panel, no window route, no settings card,
 * never a missing import. Keep `module.tsx` light: load the panel and pages
 * lazily, so the app's first load doesn't carry them.
 */
export type TabPanelProps = { projectId: number };

/** A `?pane=<name>` page a tab opens on its own. */
export interface TabPane {
  /** Rendered alone: no daemon wait, no web gate (a design gallery, a sandbox). */
  bare?: boolean;
  /** The page for these query params, or null to fall back to the app. */
  render: (params: URLSearchParams) => ReactNode | null;
}

export interface TabModule {
  /** The host catalog's tab id. */
  id: string;
  panel: LazyExoticComponent<ComponentType<TabPanelProps>>;
  icon?: TabIconName;
  /** Lower-case catalog names that also map to `icon` (a host that sends no id match). */
  names?: string[];
  /** Modes a pin can open the tab in (see `SUB_VIEWS`). */
  subViews?: SubViewDef;
  panes?: Record<string, TabPane>;
  /** A pin's own window, when the tab has a better one than the project page; null for the default. */
  openPinWindow?: (pin: Pin) => Promise<boolean> | null;
  /** Owner cards for Settings → Plug-ins. */
  settings?: LazyExoticComponent<ComponentType<{ inputClass: string }>>[];
}

const found = import.meta.glob<{ default: TabModule }>("./*/module.tsx", { eager: true });

export const TAB_MODULES: TabModule[] = Object.keys(found)
  .sort()
  .map((k) => found[k].default);

for (const m of TAB_MODULES) if (m.subViews) registerSubView(m.id, m.subViews);

/** The module page for `?pane=<name>`, if a tab owns one. */
export const tabPane = (pane: string | null): TabPane | undefined =>
  pane ? TAB_MODULES.find((m) => m.panes && Object.prototype.hasOwnProperty.call(m.panes, pane))?.panes?.[pane] : undefined;

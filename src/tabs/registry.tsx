import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import { isTabIconName, type TabIconName } from "../components/icons/TabIcon";
import { TAB_MODULES, type TabPanelProps } from "./modules";

/**
 * The stash-tab panel registry: tab id → React panel. Which tabs *exist* is
 * decided by the host's compiled-in registry (GET /tabs); which show on a
 * project is per-project enablement (Project Settings → Tabs). This map only
 * binds ids to bundled panels — a tab id the host reports but the frontend
 * doesn't know renders nothing (and vice versa), so frontend and server can
 * ship tabs independently without breaking each other.
 *
 * Panels are lazy so heavy tabs (pdf.js…) load only when first opened. A tab in
 * its own folder can register itself instead, through `modules.ts`.
 */
export type { TabPanelProps };

export const TAB_PANELS: Record<string, LazyExoticComponent<ComponentType<TabPanelProps>>> = {
  nato: lazy(() => import("./NatoTab")),
  pdf: lazy(() => import("./PdfTab")),
  email: lazy(() => import("./EmailTab")),
  atlas: lazy(() => import("./AtlasTab")),
  kanban: lazy(() => import("./KanbanTab")),
  models: lazy(() => import("./ModelsTab")),
  quiz: lazy(() => import("./QuizTab")),
  ...Object.fromEntries(TAB_MODULES.map((m) => [m.id, m.panel])),
};

/**
 * A stash tab's icon: optional, one of the line-icon set's names
 * (`src/components/icons/TabIcon.tsx`). Set it when you add a panel above; a
 * tab without one gets the icon its host-registry emoji or name maps to, else
 * the neutral `tab` icon. The host's `icon` emoji (crates/server/src/tabs.rs)
 * is never drawn: emoji break Gilt's look.
 */
export const TAB_ICONS: Record<string, TabIconName> = {
  nato: "mic",
  email: "mail",
  pdf: "document",
  kanban: "kanban",
  models: "cube",
  atlas: "map",
  quiz: "cap",
  ...Object.fromEntries(TAB_MODULES.flatMap((m) => (m.icon ? [[m.id, m.icon]] : []))),
};

/** The emoji crates/server/src/tabs.rs sends, for tabs without a TAB_ICONS entry. */
const EMOJI_ICONS: Record<string, TabIconName> = {
  "⚓": "anchor",
  "🎙️": "mic",
  "🎙": "mic",
  "✉️": "mail",
  "✉": "mail",
  "📄": "document",
  "📋": "kanban",
  "🤖": "cube",
  "🗺️": "map",
  "🗺": "map",
  "🎓": "cap",
};

/** Tab names (lower-case) the set covers, for tabs without a TAB_ICONS entry. */
const NAME_ICONS: Record<string, TabIconName> = {
  "nato trainer": "mic",
  email: "mail",
  mail: "mail",
  "pdf studio": "document",
  pdf: "document",
  kanban: "kanban",
  models: "cube",
  atlas: "map",
  quiz: "cap",
  quizzes: "cap",
  ...Object.fromEntries(TAB_MODULES.flatMap((m) => (m.icon ? (m.names ?? []).map((n) => [n, m.icon!]) : []))),
};

const own = (map: Record<string, TabIconName>, key: string | undefined): TabIconName | undefined =>
  key !== undefined && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;

/** The icon for a host-registry tab: its TAB_ICONS entry, an icon name the host
 * sent, its emoji or name mapped to the set, else the neutral `tab`. */
export function stashTabIcon(t: { id: string; name?: string; icon?: string }): TabIconName {
  return (
    own(TAB_ICONS, t.id) ??
    (isTabIconName(t.icon) ? t.icon : undefined) ??
    own(EMOJI_ICONS, t.icon?.trim()) ??
    own(NAME_ICONS, t.name?.trim().toLowerCase()) ??
    "tab"
  );
}

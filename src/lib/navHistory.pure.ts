// App-level back/forward history (the top bar's ‹ ›, Cmd+[ / Cmd+], the mouse's
// side buttons). Pure state transitions, so scripts/test-nav.mjs can check them
// without React; the store (src/store/navHistory.ts) wires them to the app.
//
// An entry is "where you are": the view, the project and its tab, and what the
// side pane (or the Tasks tab's editor) shows. Each view's detail pane has a
// `scope` so a restore reopens the target in the right one.

import type { DetailTarget } from '../components/useDetailStack';

export const NAV_LIMIT = 50;

export interface NavPane {
  /** Which detail pane holds it: 'home', 'tasks', 'project-home', 'kanban', 'calendar', 'search'. */
  scope: string;
  target: DetailTarget;
}

export interface NavEntry {
  view: string;
  /** Composite 'workspace:id' (K2) of the selected project, or null. */
  projectKey: string | null;
  /** The project page's tab, when view is 'projects' and a project is open. */
  tab: string | null;
  pane: NavPane | null;
}

export interface NavState {
  entries: NavEntry[];
  index: number;
}

export const emptyNav: NavState = { entries: [], index: -1 };

export function targetKey(t: DetailTarget): string {
  switch (t.kind) {
    case 'task':
      return `task:${t.task.workspaceId ?? ''}:${t.task.id}`;
    case 'event':
      return `event:${t.event.workspaceId ?? ''}:${t.event.id}`;
    case 'project':
      return `project:${t.project.workspaceId ?? ''}:${t.project.id}`;
    case 'day':
      return `day:${t.date}:${t.scopeProjectId ?? ''}`;
  }
}

export function entryKey(e: NavEntry): string {
  const pane = e.pane ? `${e.pane.scope}/${targetKey(e.pane.target)}` : '-';
  return `${e.view}|${e.projectKey ?? '-'}|${e.tab ?? '-'}|${pane}`;
}

export const current = (s: NavState): NavEntry | null => (s.index >= 0 ? s.entries[s.index] ?? null : null);
export const canBack = (s: NavState) => s.index > 0;
export const canForward = (s: NavState) => s.index >= 0 && s.index < s.entries.length - 1;

/** Go somewhere new: drop the forward history and append. The same place as now
 * only refreshes the entry's snapshot. Keeps the newest NAV_LIMIT entries. */
export function push(s: NavState, e: NavEntry): NavState {
  const cur = current(s);
  if (cur && entryKey(cur) === entryKey(e)) {
    const entries = [...s.entries];
    entries[s.index] = e;
    return { entries, index: s.index };
  }
  const entries = [...s.entries.slice(0, s.index + 1), e].slice(-NAV_LIMIT);
  return { entries, index: entries.length - 1 };
}

/** Change where you are without a new entry (an automatic open, the side pane's
 * own back/forward, closing the search drawer). If that makes it the same as the
 * entry before, the two merge, so Back never lands on the same place twice. */
export function amend(s: NavState, patch: Partial<NavEntry>): NavState {
  const cur = current(s);
  if (!cur) return s;
  const next = { ...cur, ...patch };
  const entries = [...s.entries];
  entries[s.index] = next;
  const prev = s.index > 0 ? entries[s.index - 1] : null;
  if (prev && entryKey(prev) === entryKey(next)) {
    entries.splice(s.index, 1);
    return { entries, index: s.index - 1 };
  }
  return { entries, index: s.index };
}

/** The app switched view or project. A project page starts on `tab` (the tab it
 * is showing, if known); the side pane starts empty. */
export function visitView(s: NavState, view: string, projectKey: string | null, tab: string | null): NavState {
  const cur = current(s);
  if (cur && cur.view === view && cur.projectKey === projectKey) return s;
  return push(s, { view, projectKey, tab: view === 'projects' && projectKey ? tab : null, pane: null });
}

/** The project page shows `tab`. The first report for an entry fills it in; a
 * change after that is a new place. Reports for another project are ignored
 * (the view switch that follows records it). */
export function visitTab(s: NavState, projectKey: string, tab: string): NavState {
  const cur = current(s);
  if (!cur || cur.view !== 'projects' || cur.projectKey !== projectKey || cur.tab === tab) return s;
  if (cur.tab === null) return amend(s, { tab });
  return push(s, { ...cur, tab, pane: null });
}

/** A detail pane opened something. `record`: 'push' for a person's click,
 * 'amend' for an automatic open or the pane's own back/forward. */
export function openPane(s: NavState, pane: NavPane, record: 'push' | 'amend'): NavState {
  const cur = current(s);
  if (!cur) return s;
  return record === 'push' ? push(s, { ...cur, pane }) : amend(s, { pane });
}

/** A detail pane emptied: forget its target if it is the current one. */
export function closePane(s: NavState, scope: string): NavState {
  const cur = current(s);
  if (!cur || cur.pane?.scope !== scope) return s;
  return amend(s, { pane: null });
}

/** Move to entry `i` (a back/forward landing), dropping the entries in `skipped`
 * (gone or hidden) on the way. `entry` is the landing's refreshed copy. */
export function land(s: NavState, i: number, entry: NavEntry, skipped: number[]): NavState {
  const entries = [...s.entries];
  entries[i] = entry;
  const drop = new Set(skipped);
  const kept = entries.filter((_, j) => !drop.has(j));
  const index = i - skipped.filter((j) => j < i).length;
  return { entries: kept, index };
}

/** Back/forward key combos: Cmd+[ / Cmd+] on macOS, Alt+← / Alt+→ elsewhere. */
export function navKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }, mac: boolean): -1 | 1 | 0 {
  if (mac) {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return 0;
    return e.key === '[' ? -1 : e.key === ']' ? 1 : 0;
  }
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return 0;
  return e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
}

/** The macOS traffic lights sit over the top bar's left end (titleBarStyle
 * Overlay). Reserve their width there on the macOS desktop app, except in full
 * screen, where macOS hides them. `forced` lets a browser preview it. */
export const TRAFFIC_LIGHTS_PX = 78;
export function titleBarInset(o: { tauri: boolean; mobile: boolean; mac: boolean; fullscreen: boolean; forced?: boolean }): number {
  if (o.fullscreen) return 0;
  if (o.forced) return TRAFFIC_LIGHTS_PX;
  return o.tauri && !o.mobile && o.mac ? TRAFFIC_LIGHTS_PX : 0;
}

// App-level back/forward (per window, in memory). Navigation state stays where it
// lives (App's view, the selected project, ProjectView's tab, each view's detail
// pane); they report here, and a back/forward publishes a `restore` they apply.
// The pure transitions are in lib/navHistory.pure.ts.

import { create } from 'zustand';
import type { Task } from '../types';
import { useAppStore } from './appStore';
import { getActiveWorkspaceId, getWorkspace, LOCAL_ID } from '../lib/workspaces';
import { wsGetTasks } from '../lib/workspaceData';
import {
  emptyNav, land, push, visitView, visitTab, openPane, closePane,
  type NavEntry, type NavPane, type NavState,
} from '../lib/navHistory.pure';

export type { NavEntry, NavPane };

export interface NavRestore {
  entry: NavEntry;
  seq: number;
  at: number;
  /** Detail-pane scopes that have applied it (a remount must not reapply it). */
  consumed: string[];
}

interface NavStore extends NavState {
  restore: NavRestore | null;
  /** Reports right after a restore are its own echoes, not new places. */
  suppressUntil: number;
  busy: boolean;
  visitView: (view: string, projectKey: string | null) => void;
  visitTab: (projectKey: string, tab: string) => void;
  openPane: (pane: NavPane, record: 'push' | 'amend') => void;
  closePane: (scope: string) => void;
  step: (dir: -1 | 1) => Promise<void>;
  /** Go to an entry now (a new place, pushed), e.g. "Open in Project > Tasks". */
  goto: (entry: NavEntry) => Promise<boolean>;
}

// A landing's echoes (a remounting page reporting its first tab before the
// restore's tab applies) come within a render or two; a person's next click
// comes later. Reports that match the landing are no-ops anyway.
const SUPPRESS_MS = 500;
const RESTORE_TTL_MS = 3000;
let liveTab: { projectKey: string; tab: string } | null = null;

const wsOfKey = (key: string | null) => (key ? key.slice(0, key.lastIndexOf(':')) : null);

/** Re-check an entry before landing on it: its project must still exist and its
 * task must still be visible to this user (ADR 0002 filters get_tasks). Returns
 * the entry with a fresh task, or null when it should be skipped. A host that
 * can't be reached keeps the snapshot: unreachable isn't gone. */
async function resolve(entry: NavEntry): Promise<NavEntry | null> {
  if (entry.projectKey) {
    const exists = useAppStore.getState().projects.some(
      (p) => `${p.workspaceId ?? LOCAL_ID}:${p.id}` === entry.projectKey && !p.archived
    );
    if (!exists) return null;
  }
  const t = entry.pane?.target;
  if (!entry.pane || t?.kind !== 'task') return entry;
  const wsId = t.task.workspaceId ?? wsOfKey(entry.projectKey) ?? getActiveWorkspaceId();
  const ws = getWorkspace(wsId);
  if (!ws) return null;
  let tasks: Task[];
  try {
    tasks = await wsGetTasks(ws, t.task.project_id);
  } catch {
    return 'title' in t.task ? entry : null; // a message's stub has nothing to show
  }
  const found = tasks.find((x) => x.id === t.task.id);
  if (!found) return null;
  const fresh: Task = { ...found };
  if (t.task.workspaceId === undefined) delete fresh.workspaceId;
  return { ...entry, pane: { ...entry.pane, target: { kind: 'task', task: fresh } } };
}

export const useNav = create<NavStore>()((set, get) => {
  const quiet = () => Date.now() < get().suppressUntil;
  const apply = (entry: NavEntry) =>
    set((s) => ({
      restore: { entry, seq: (s.restore?.seq ?? 0) + 1, at: Date.now(), consumed: [] },
      suppressUntil: Date.now() + SUPPRESS_MS,
    }));
  return {
    ...emptyNav,
    restore: null,
    suppressUntil: 0,
    busy: false,
    visitView: (view, projectKey) => {
      if (quiet()) return;
      const tab = liveTab && liveTab.projectKey === projectKey ? liveTab.tab : null;
      set((s) => visitView(s, view, projectKey, tab));
    },
    visitTab: (projectKey, tab) => {
      liveTab = { projectKey, tab };
      if (quiet()) return;
      set((s) => visitTab(s, projectKey, tab));
    },
    openPane: (pane, record) => {
      if (quiet() && record === 'amend') return;
      set((s) => openPane(s, pane, record));
    },
    closePane: (scope) => {
      if (quiet()) return;
      set((s) => closePane(s, scope));
    },
    step: async (dir) => {
      if (get().busy) return;
      set({ busy: true });
      try {
        const s = get();
        const skipped: number[] = [];
        for (let i = s.index + dir; i >= 0 && i < s.entries.length; i += dir) {
          const entry = await resolve(s.entries[i]);
          if (!entry) {
            skipped.push(i); // gone or hidden: skip it quietly, and forget it
            continue;
          }
          // Reports may have moved the history while we waited on the host.
          if (get().entries !== s.entries) return;
          set(land(s, i, entry, skipped));
          apply(entry);
          return;
        }
        if (skipped.length && get().entries === s.entries) set(land(s, s.index, s.entries[s.index], skipped));
      } finally {
        set({ busy: false });
      }
    },
    goto: async (target) => {
      const entry = await resolve(target);
      if (!entry) return false;
      set((s) => push(s, entry));
      apply(entry);
      return true;
    },
  };
});

/** The restore a detail pane of `scope` should apply now, if any. */
export function pendingRestore(scope: string): NavRestore | null {
  const r = useNav.getState().restore;
  if (!r || r.consumed.includes(scope) || Date.now() - r.at > RESTORE_TTL_MS) return null;
  return r;
}

/** ProjectView left: the next project page starts on its default tab again. */
export function forgetTab(): void {
  liveTab = null;
}

export function consumeRestore(scope: string): void {
  useNav.setState((s) => (s.restore ? { restore: { ...s.restore, consumed: [...s.restore.consumed, scope] } } : {}));
}

/** Where a task lives in Project > Tasks, as a history entry. */
export function taskPlace(task: Task, wsId?: string): NavEntry {
  const ws = wsId ?? task.workspaceId ?? getActiveWorkspaceId();
  return {
    view: 'projects',
    projectKey: `${ws}:${task.project_id}`,
    tab: 'tasks',
    pane: { scope: 'tasks', target: { kind: 'task', task } },
  };
}

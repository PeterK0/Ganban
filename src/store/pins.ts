// Pinned tabs: the merged list across workspaces, the edits (optimistic, written to the
// project's own host) and the hand-off that opens a pin's tab in ProjectView.
// The source of truth is each host's `tab_pins` (per user, per project); nothing here is
// kept in localStorage.

import { create } from 'zustand';
import { listWorkspaces, getWorkspace, LOCAL_ID } from '../lib/workspaces';
import { wsListTabPins, wsSetTabPin, wsUnpinTab } from '../lib/workspaceData';
import { hasDaemon, listAvailableTabs } from '../lib/daemon';
import { BUILTIN_TABS } from '../lib/projectTabs';
import { stashTabIcon } from '../tabs/registry';
import type { TabIconName } from '../components/icons/TabIcon';
import { notify } from './notifications';
import {
  addPin, dropPins, mergeLoad, movePin, nudgePin, pinKey, pinLabel, prettyTabId, removePin, samePin, SUB_VIEWS,
  type Pin, type PinRef,
} from '../lib/pinnedTabs.pure';

export type { Pin, PinRef };

/** "Open this tab" from a pin, consumed (cleared) by ProjectView. `remount` asks it to
 * remount the panel when the tab is already open but its sub-view was switched. */
export interface OpenIntent {
  projectKey: string;
  tab: string;
  remount: boolean;
}

interface PinsState {
  pins: Pin[];
  loaded: boolean;
  /** Stash tabs' names and icons, from the host registry (built-ins are static). */
  catalog: Record<string, { name: string; icon: string }>;
  openIntent: OpenIntent | null;
  /** The project tab on screen (ProjectView reports it), for the active pin. */
  currentTab: { projectKey: string; tab: string } | null;
  load: (retry?: boolean) => Promise<void>;
  loadCatalog: () => Promise<void>;
  pin: (ref: PinRef, sub: string | null) => Promise<void>;
  unpin: (ref: PinRef) => Promise<void>;
  move: (key: string, to: number) => Promise<void>;
  nudge: (key: string, delta: number) => Promise<void>;
  /** Forget pins locally (the host already dropped them: a deleted project, a disabled tab). */
  drop: (ws: string, project: number, tab?: string) => void;
  setOpenIntent: (i: OpenIntent | null) => void;
  setCurrentTab: (t: { projectKey: string; tab: string } | null) => void;
}

/** Bumped by every edit, so a load that started before it can't overwrite it. */
let generation = 0;

const hostOf = (wsId: string) => getWorkspace(wsId);

const failed = (what: string, e: unknown) =>
  notify({ kind: 'error', title: `Couldn't ${what}`, body: e instanceof Error ? e.message : String(e) });

export const usePins = create<PinsState>()((set, get) => {
  /** Write some pins' positions back to their hosts; on failure reload the truth. */
  const writePositions = async (changed: Pin[]) => {
    try {
      await Promise.all(
        changed.map((p) => {
          const ws = hostOf(p.ws);
          return ws ? wsSetTabPin(ws, p.project, p.tab, p.sub, p.position) : Promise.resolve();
        }),
      );
    } catch (e) {
      failed('move the pin', e);
      void get().load();
    }
  };

  return {
    pins: [],
    loaded: false,
    catalog: {},
    openIntent: null,
    currentTab: null,

    load: async (retry = true) => {
      const gen = generation;
      const wss = listWorkspaces().filter((w) => w.id === LOCAL_ID || w.url);
      const loads = await Promise.all(
        wss.map(async (ws) => ({ ws: ws.id, pins: await wsListTabPins(ws).catch(() => null) })),
      );
      if (gen !== generation) {
        // An edit landed meanwhile and this answer may predate it: ask again, once.
        if (retry) void get().load(false);
        return;
      }
      const pins = mergeLoad(get().pins, loads);
      if (JSON.stringify(pins) !== JSON.stringify(get().pins) || !get().loaded) set({ pins, loaded: true });
    },

    loadCatalog: async () => {
      if (!hasDaemon()) return;
      try {
        const tabs = await listAvailableTabs();
        set({ catalog: Object.fromEntries(tabs.map((t) => [t.id, { name: t.name, icon: t.icon }])) });
      } catch {
        /* the fallback names do */
      }
    },

    pin: async (ref, sub) => {
      const ws = hostOf(ref.ws);
      if (!ws) return;
      generation++;
      const { pins, pin } = addPin(get().pins, ref, sub);
      set({ pins });
      try {
        await wsSetTabPin(ws, pin.project, pin.tab, pin.sub, pin.position);
      } catch (e) {
        failed('pin the tab', e);
        void get().load(); // the hosts' truth, not a snapshot that may undo a later edit
      }
    },

    unpin: async (ref) => {
      const ws = hostOf(ref.ws);
      generation++;
      set({ pins: removePin(get().pins, ref) });
      if (!ws) return;
      try {
        await wsUnpinTab(ws, ref.project, ref.tab);
      } catch (e) {
        failed('unpin the tab', e);
        void get().load();
      }
    },

    move: async (key, to) => {
      generation++;
      const { pins, changed } = movePin(get().pins, key, to);
      if (!changed.length) return;
      set({ pins });
      await writePositions(changed);
    },

    nudge: async (key, delta) => {
      generation++;
      const { pins, changed } = nudgePin(get().pins, key, delta);
      if (!changed.length) return;
      set({ pins });
      await writePositions(changed);
    },

    drop: (ws, project, tab) => {
      generation++;
      set({ pins: dropPins(get().pins, ws, project, tab) });
    },

    setOpenIntent: (openIntent) => set({ openIntent }),
    setCurrentTab: (currentTab) => {
      const cur = get().currentTab;
      if (cur?.projectKey === currentTab?.projectKey && cur?.tab === currentTab?.tab) return;
      set({ currentTab });
    },
  };
});

/** A tab's name and icon: the built-ins, the host's registry, or a fallback. */
export function tabMeta(tab: string, catalog: PinsState['catalog']): { name: string; icon: TabIconName } {
  const b = BUILTIN_TABS.find((t) => t.id === tab);
  if (b) return { name: b.label, icon: b.icon };
  const c = Object.prototype.hasOwnProperty.call(catalog, tab) ? catalog[tab] : undefined;
  const name = c?.name ?? prettyTabId(tab);
  return { name, icon: stashTabIcon({ id: tab, name, icon: c?.icon }) };
}

/** A pin's label ("Chess · Puzzles"). */
export const labelOf = (p: Pin, catalog: PinsState['catalog']): string => pinLabel(tabMeta(p.tab, catalog).name, p.tab, p.sub);

/** The sub-view a tab is in now, for a tab that has them (its own per-device preference). */
export function readSubView(tab: string): string | null {
  const sv = SUB_VIEWS[tab];
  if (!sv) return null;
  try {
    const v = localStorage.getItem(sv.storageKey);
    return v && sv.labels[v] ? v : null;
  } catch {
    return null;
  }
}

/** Point a tab at a pin's sub-view before it opens. True when that changed it. */
export function applySubView(tab: string, sub: string | null): boolean {
  const sv = SUB_VIEWS[tab];
  if (!sv || !sub || !sv.labels[sub]) return false;
  if (readSubView(tab) === sub) return false;
  try {
    localStorage.setItem(sv.storageKey, sub);
    return true;
  } catch {
    return false;
  }
}

export const isPinned = (pins: Pin[], ref: PinRef): boolean => pins.some((p) => samePin(p, ref));
export { pinKey };

// Rail views of tab modules (src/tabs/modules.ts `rail`): which ones the sidebar shows. A module's
// view shows when the host was built with its tab (`GET /tabs`) and the user turned it on in
// Settings → Plug-ins. That switch is a per-user host setting (`RAIL_SETTING`), so it follows the
// user to their other devices; nothing here is kept in localStorage.

import { create } from 'zustand';
import { hasDaemon, listAvailableTabs } from '../lib/daemon';
import { getUserSetting, setUserSetting } from '../lib/api';
import { RAIL_MODULES, RAIL_SETTING, type TabModule } from '../tabs/modules';

interface RailState {
  /** The user the switches belong to (the host's signed-in member, or the desktop's profile). */
  userId: number | null;
  /** Tab ids the host was built with; null until known. */
  hostTabs: string[] | null;
  /** The user's switches, by module id. */
  on: Record<string, boolean>;
  load: (userId: number | null) => Promise<void>;
  setOn: (id: string, on: boolean) => Promise<void>;
}

let generation = 0;

export const useRailTabs = create<RailState>((set, get) => ({
  userId: null,
  hostTabs: null,
  on: {},

  load: async (userId) => {
    const gen = ++generation;
    // Another user's switches never stay on screen for this one.
    if (userId !== get().userId) set({ userId, on: {} });
    if (!RAIL_MODULES.length || !hasDaemon()) return;
    let tabs: string[];
    try {
      tabs = (await listAvailableTabs()).map((d) => d.id);
    } catch {
      return; // a passing failure keeps what we knew, rather than hiding a view the user is in
    }
    const offered = RAIL_MODULES.filter((m) => tabs.includes(m.id));
    const on: Record<string, boolean> = {};
    if (userId != null) {
      await Promise.all(
        offered.map(async (m) => {
          try {
            const s = await getUserSetting(userId, RAIL_SETTING(m.id));
            on[m.id] = s === 'on';
          } catch {
            on[m.id] = !!get().on[m.id];
          }
        }),
      );
    }
    if (gen === generation) set({ hostTabs: tabs, on });
  },

  setOn: async (id, value) => {
    const { userId, on } = get();
    if (userId == null) throw new Error('No signed-in user to save this for.');
    set({ on: { ...on, [id]: value } });
    try {
      await setUserSetting(userId, RAIL_SETTING(id), value ? 'on' : 'off');
    } catch (e) {
      set({ on: { ...get().on, [id]: !value } });
      throw e;
    }
  },
}));

/** The rail modules the host offers (for the Plug-ins switches). */
export const offeredRails = (hostTabs: string[] | null): TabModule[] =>
  hostTabs ? RAIL_MODULES.filter((m) => hostTabs.includes(m.id)) : [];

/** The rail modules the sidebar shows: offered by the host and turned on by the user. */
export const shownRails = (hostTabs: string[] | null, on: Record<string, boolean>): TabModule[] =>
  offeredRails(hostTabs).filter((m) => on[m.id]);

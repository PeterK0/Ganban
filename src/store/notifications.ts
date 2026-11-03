import { create } from 'zustand';

export type NotifKind = 'info' | 'success' | 'error' | 'progress';
/** Which dropdown tab a notification belongs to. */
export type NotifCategory = 'task' | 'event' | 'comment' | 'system';

export interface Notif {
  id: string;
  kind: NotifKind;
  category: NotifCategory;
  title: string;
  body?: string;
  read: boolean;
  ts: number;
}

interface NotifState {
  items: Notif[];
  notify: (n: { kind?: NotifKind; category?: NotifCategory; title: string; body?: string; id?: string }) => string;
  update: (id: string, patch: Partial<Omit<Notif, 'id'>>) => void;
  markAllRead: () => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

let seq = 0;

/** App-wide notification feed (the bell). Replaces the old corner toast spam:
 * everything lands here and is reviewed from the notification center. */
export const useNotifications = create<NotifState>((set) => ({
  items: [],
  notify: ({ kind = 'info', category = 'system', title, body, id }) => {
    const nid = id ?? `n${Date.now()}_${seq++}`;
    set((s) => {
      // Dedup by id (lets callers update a "Downloading…" entry in place).
      const rest = s.items.filter((i) => i.id !== nid);
      return { items: [{ id: nid, kind, category, title, body, read: false, ts: Date.now() }, ...rest].slice(0, 100) };
    });
    return nid;
  },
  update: (id, patch) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) })),
  markAllRead: () => set((s) => ({ items: s.items.map((i) => ({ ...i, read: true })) })),
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clear: () => set({ items: [] }),
}));

/** Fire a notification from anywhere (including non-React code like downloads). */
export function notify(n: { kind?: NotifKind; category?: NotifCategory; title: string; body?: string; id?: string }): string {
  return useNotifications.getState().notify(n);
}
/** Update a notification in place (e.g. flip "Downloading…" → "Downloaded"). */
export function updateNotif(id: string, patch: Partial<Omit<Notif, 'id'>>): void {
  useNotifications.getState().update(id, patch);
}

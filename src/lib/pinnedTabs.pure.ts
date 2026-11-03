// Pinned tabs, the pure half: identity, order, labels and how many fit the top
// bar. A pin is (workspace, project, tab) plus the tab's sub-view where it has
// one; it lives on the host that owns the project (`tab_pins`), so a desktop
// with several workspaces merges them into one list ordered by `position`.
// No I/O here: scripts/test-pins.mjs runs this file under node.

/** What a host returns for one of the caller's pins. */
export interface HostPin {
  project_id: number;
  tab_id: string;
  sub_view: string | null;
  position: number;
}

export interface PinRef {
  /** Workspace id (K2): `local` or a remote's `ws-…`. */
  ws: string;
  project: number;
  tab: string;
}

export interface Pin extends PinRef {
  sub: string | null;
  position: number;
}

export const pinKey = (p: PinRef): string => `${p.ws}:${p.project}:${p.tab}`;
export const projectKeyOf = (p: { ws: string; project: number }): string => `${p.ws}:${p.project}`;
export const samePin = (a: PinRef, b: PinRef): boolean => a.ws === b.ws && a.project === b.project && a.tab === b.tab;

/** Position order; ties (two hosts that picked the same number) break on the key, so
 * every window shows the same order. */
export function sortPins(pins: Pin[]): Pin[] {
  return [...pins].sort((a, b) => a.position - b.position || (pinKey(a) < pinKey(b) ? -1 : pinKey(a) > pinKey(b) ? 1 : 0));
}

/** One workspace's answer to a load: its pins, or null when the host couldn't be reached. */
export interface HostLoad {
  ws: string;
  pins: HostPin[] | null;
}

/** Merge a load across workspaces. A host that failed keeps the pins we last had from it
 * (a blip shouldn't empty the bar, as the project list does). */
export function mergeLoad(previous: Pin[], loads: HostLoad[]): Pin[] {
  const out: Pin[] = [];
  for (const l of loads) {
    if (l.pins === null) out.push(...previous.filter((p) => p.ws === l.ws));
    else for (const h of l.pins) out.push({ ws: l.ws, project: h.project_id, tab: h.tab_id, sub: h.sub_view ?? null, position: h.position });
  }
  return sortPins(out);
}

/** Where a new pin goes: after the last one. */
export const endPosition = (pins: Pin[]): number => (pins.length ? Math.max(...pins.map((p) => p.position)) + 1 : 1);

/** Add a pin at the end, or re-target an existing pin's sub-view in place. */
export function addPin(pins: Pin[], ref: PinRef, sub: string | null): { pins: Pin[]; pin: Pin } {
  const old = pins.find((p) => samePin(p, ref));
  const pin: Pin = { ...ref, sub, position: old ? old.position : endPosition(pins) };
  return { pins: sortPins([...pins.filter((p) => !samePin(p, ref)), pin]), pin };
}

export const removePin = (pins: Pin[], ref: PinRef): Pin[] => pins.filter((p) => !samePin(p, ref));

/** Drop every pin to a project (deleted), or to one of its tabs (disabled). */
export const dropPins = (pins: Pin[], ws: string, project: number, tab?: string): Pin[] =>
  pins.filter((p) => !(p.ws === ws && p.project === project && (tab === undefined || p.tab === tab)));

const MIN_GAP = 1e-6;

/** Move a pin to index `to` of the ordered list. Usually only the moved pin gets a new
 * position (the midpoint of its new neighbours); when the gap has worn too thin, every
 * pin is renumbered 1..n. `changed` is what to write back. */
export function movePin(pins: Pin[], key: string, to: number): { pins: Pin[]; changed: Pin[] } {
  const list = sortPins(pins);
  const from = list.findIndex((p) => pinKey(p) === key);
  if (from < 0) return { pins: list, changed: [] };
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return { pins: list, changed: [] };
  const moving = list[from];
  const rest = list.filter((_, i) => i !== from);
  const before = rest[target - 1];
  const after = rest[target];
  let position: number;
  if (!before) position = after.position - 1;
  else if (!after) position = before.position + 1;
  else position = (before.position + after.position) / 2;
  const tight = (before && position - before.position < MIN_GAP) || (after && after.position - position < MIN_GAP);
  if (tight) {
    const order = [...rest.slice(0, target), moving, ...rest.slice(target)];
    const renumbered = order.map((p, i) => ({ ...p, position: i + 1 }));
    return { pins: renumbered, changed: renumbered.filter((p, i) => p.position !== order[i].position) };
  }
  const moved = { ...moving, position };
  return { pins: sortPins([...rest, moved]), changed: [moved] };
}

/** Move a pin one step left (-1) or right (+1). */
export function nudgePin(pins: Pin[], key: string, delta: number): { pins: Pin[]; changed: Pin[] } {
  const list = sortPins(pins);
  const i = list.findIndex((p) => pinKey(p) === key);
  return i < 0 ? { pins: list, changed: [] } : movePin(list, key, i + delta);
}

/** How many pins fit, given each chip's width: all of them if they fit outright, else as
 * many as leave room for the "more" button. Never negative. */
export function fitCount(widths: number[], available: number, gap: number, moreWidth: number): number {
  const total = (n: number) => widths.slice(0, n).reduce((s, w) => s + w, 0) + Math.max(0, n - 1) * gap;
  if (total(widths.length) <= available) return widths.length;
  let n = widths.length - 1;
  while (n > 0 && total(n) + gap + moreWidth > available) n--;
  return n;
}

/** A tab's sub-views the shell can pin: its storage key (the tab's own per-device
 * preference for which mode to open in), the short name a pin uses, and the modes' labels. */
export type SubViewDef = { storageKey: string; short: string; labels: Record<string, string> };

/** Tabs that expose a sub-view, registered by their tab module (`src/tabs/modules.ts`). Empty
 * until that module is imported: the app imports it from main.tsx, before anything reads this. */
export const SUB_VIEWS: Record<string, SubViewDef> = {};

export function registerSubView(tab: string, def: SubViewDef): void {
  SUB_VIEWS[tab] = def;
}

/** A pin's short label: "Chess · Puzzles" for a sub-view, else the tab's name. */
export function pinLabel(tabName: string, tab: string, sub: string | null): string {
  const sv = SUB_VIEWS[tab];
  const subLabel = sub && sv ? sv.labels[sub] : null;
  return subLabel ? `${sv.short} · ${subLabel}` : tabName;
}

/** A fallback name for a tab id the catalog doesn't know ("hello-world" → "Hello world"). */
export const prettyTabId = (id: string): string => {
  const s = id.replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : id;
};

/** A Tauri window label for a pin's window: letters, digits, `-` and `_` only. */
export const pinWindowLabel = (p: PinRef): string => `pin-${p.ws}-${p.project}-${p.tab}`.replace(/[^A-Za-z0-9_-]/g, '_');

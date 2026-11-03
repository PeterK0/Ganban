import { LOCAL_ID } from './workspaces';

/** Gilt's project colours (the `.c-*` helpers in src/styles/gilt.css set `--pc`
 * for `g-gem` and `g-tile`). Projects carry no colour, so each one gets a
 * stable pick from its composite key ('workspace:id'; ids collide across hosts). */
const COLOURS = ['c-pur', 'c-org', 'c-cyan', 'c-pink', 'c-grn', 'c-yel', 'c-teal', 'c-lav'] as const;

export function projectColorClass(p: { workspaceId?: string; id: number }): string {
  const key = `${p.workspaceId ?? LOCAL_ID}:${p.id}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return COLOURS[h % COLOURS.length];
}

/** The letter a project's `g-tile` shows. */
export function projectInitial(name: string): string {
  const ch = name.trim().match(/[\p{L}\p{N}]/u);
  return ch ? ch[0].toUpperCase() : '·';
}

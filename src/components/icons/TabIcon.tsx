// The tab icon set: thin line icons in the sidebar's style (NavIcon in App.tsx: a
// 24-unit box, 1.6 stroke, currentColor, round caps), so a tab's icon takes its
// label's colour (gold when selected). Every built-in tab, the stash tabs and the
// calendar's view modes draw from here; a tab the set doesn't know gets `tab`.

import type { ReactNode } from 'react';

const ICONS = {
  home: <path d="M3.5 11L12 4l8.5 7M6 9v11h4.5v-5.5h3V20H18V9" />,
  tasks: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8.5 12.2l2.4 2.4 4.6-5" />
    </>
  ),
  comments: <path d="M7.5 18H6.5A2.5 2.5 0 014 15.5v-9A2.5 2.5 0 016.5 4h11A2.5 2.5 0 0120 6.5v9a2.5 2.5 0 01-2.5 2.5H12l-4.5 3V18zM8 8.5h8M8 12h5" />,
  // The sidebar's Assistant bubble: the project's chats are its assistant chats.
  chats: <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />,
  files: <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />,
  events: <path d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />,
  reports: <path d="M4 20h16M7 16.5v-5M12 16.5v-9M17 16.5V10" />,
  members: (
    <path d="M15.5 19.5v-1.2a3.3 3.3 0 00-3.3-3.3H6.8a3.3 3.3 0 00-3.3 3.3v1.2M9.5 11.5a3 3 0 100-6 3 3 0 000 6zM20.5 19.5v-1.2a3.3 3.3 0 00-2.5-3.2M15.5 5.6a3 3 0 010 5.8" />
  ),
  kanban: (
    <>
      <rect x="3.5" y="4" width="4.5" height="14" rx="1" />
      <rect x="9.75" y="4" width="4.5" height="9" rx="1" />
      <rect x="16" y="4" width="4.5" height="11.5" rx="1" />
    </>
  ),
  anchor: (
    <>
      <circle cx="12" cy="5" r="2" />
      <path d="M12 7v13.5M8.5 10.5h7M4.5 13a7.5 7.5 0 0015 0M3 14.5l1.5-1.5 1.5 1.5M18 14.5l1.5-1.5 1.5 1.5" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21M8.5 21h7" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="M4 7l8 6 8-6" />
    </>
  ),
  document: <path d="M14 3.5H7.5a2 2 0 00-2 2v13a2 2 0 002 2h9a2 2 0 002-2V8L14 3.5zM14 3.5V8h4.5M9 13h6M9 16.5h4" />,
  cube: <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9" />,
  // The sidebar's Atlas map.
  map: <path d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />,
  cap: <path d="M12 5L2.5 9.5 12 14l9.5-4.5L12 5zM6.5 11.6V16c0 1.4 2.5 3 5.5 3s5.5-1.6 5.5-3v-4.4M21.5 9.5V15" />,
  month: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="1.5" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4M8 13h.01M12 13h.01M16 13h.01M8 16.5h.01M12 16.5h.01M16 16.5h.01" />
    </>
  ),
  week: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="1.5" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4M6.5 13h11v3h-11z" />
    </>
  ),
  day: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="1.5" />
      <path d="M3.5 9.5h17M8 3v4M16 3v4M10 12.5h4v4h-4z" />
    </>
  ),
  agenda: <path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />,
  // The Repeating view: two arrows chasing round.
  repeat: <path d="M4.5 11V9.5A3.5 3.5 0 018 6h11.5M16.5 3l3 3-3 3M19.5 13v1.5A3.5 3.5 0 0116 18H4.5M7.5 21l-3-3 3-3" />,
  // The sub-tab strips of Atlas and the Assistant.
  library: (
    <>
      <rect x="4" y="4.5" width="4" height="15" rx="1" />
      <rect x="10" y="4.5" width="4" height="15" rx="1" />
      <path d="M15.6 6.2l3.3-.9 3 13.6-3.3.8-3-13.5zM4 8h4M10 8h4" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l5 5" />
    </>
  ),
  layers: <path d="M12 4l8.5 4.25L12 12.5 3.5 8.25 12 4zM3.5 12.25L12 16.5l8.5-4.25M3.5 16.25L12 20.5l8.5-4.25" />,
  bot: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="2.5" />
      <path d="M12 8V4.5M10 4.5h4M9.5 12.5v1.5M14.5 12.5v1.5M9.5 16.5h5M3 12v3.5M21 12v3.5" />
    </>
  ),
  oracle: (
    <>
      <circle cx="12" cy="10.5" r="6.5" />
      <path d="M9 9a3 3 0 013-2.5M7 20.5h10M8.5 16.5l-1 4M15.5 16.5l1 4" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15.5 8.5l-2 5-5 2 2-5 5-2z" />
    </>
  ),
  wrench: <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.4-3.4a5.5 5.5 0 01-7.3 7.3l-6.5 6.5a2 2 0 01-2.8-2.8l6.5-6.5a5.5 5.5 0 017.3-7.3l-3.6 3.6z" />,
  activity: <path d="M21 12h-3.5l-2.75 7.5L9.25 4.5 6.5 12H3" />,
  // Finance: a wallet with its clasp.
  finance: (
    <>
      <path d="M17.5 8V5.5A1.5 1.5 0 0016 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12.5a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0018.5 8H6a2 2 0 01-2-2" />
      <path d="M20 11.5h-3a2 2 0 000 4h3M16.75 13.5h.01" />
    </>
  ),
  /** The neutral fallback, for a tab the set doesn't know. */
  tab: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type TabIconName = keyof typeof ICONS;

export const isTabIconName = (s: unknown): s is TabIconName => typeof s === 'string' && Object.prototype.hasOwnProperty.call(ICONS, s);

/** One icon of the set. 16px by default; pass a className to size it. */
export function TabIcon({ name, className = 'w-4 h-4' }: { name: TabIconName; className?: string }) {
  return (
    <svg
      className={`shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {ICONS[name] ?? ICONS.tab}
    </svg>
  );
}

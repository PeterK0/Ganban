// The tabs every project has (the stash tabs come from the host's registry, GET /tabs).
// Shared by the project page's tab strip and the top bar's pinned tabs.

import type { TabIconName } from '../components/icons/TabIcon';

export type BuiltinTab = 'home' | 'tasks' | 'files' | 'events' | 'reports' | 'chats' | 'comments' | 'members';

export const BUILTIN_TABS: { id: BuiltinTab; label: string; icon: TabIconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks' },
  { id: 'comments', label: 'Comments', icon: 'comments' },
  { id: 'chats', label: 'Chats', icon: 'chats' },
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'events', label: 'Events', icon: 'events' },
  { id: 'reports', label: 'Reports', icon: 'reports' },
  { id: 'members', label: 'Members', icon: 'members' },
];

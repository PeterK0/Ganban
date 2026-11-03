import { useState } from 'react';
import { getTaskAudience, getUsers } from '../lib/api';
import type { Area, Task, User } from '../types';

/** Whether a task is restricted (task visibility, ADR 0002): it narrows itself, or it
 * follows a restricted area. */
export function isRestricted(task: Task, areas: Area[]): boolean {
  if (task.visibility && task.visibility !== 'area') return true;
  return !!areas.find((a) => a.id === task.area_id)?.restricted;
}

let usersCache: Promise<User[]> | null = null;
/** The people the caller shares a project with, for naming an audience. */
export function audienceUsers(): Promise<User[]> {
  usersCache ??= getUsers().catch(() => {
    usersCache = null;
    return [];
  });
  return usersCache;
}

/** "Ana, Bo and Mia" from user ids. */
export function namesOf(ids: number[], users: User[]): string {
  const names = ids.map((id) => users.find((u) => u.id === id)?.full_name ?? `User ${id}`);
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * A 🔒 on a restricted task, for everyone who can see it. Hovering names the audience
 * (loaded on first hover).
 */
export default function TaskVisibilityBadge({ task, areas }: { task: Task; areas: Area[] }) {
  const [title, setTitle] = useState<string | null>(null);
  if (!isRestricted(task, areas)) return null;
  const area = areas.find((a) => a.id === task.area_id);
  const label = task.visibility === 'admins' ? 'Admins only' : task.visibility === 'members' ? 'Selected members' : area?.name ?? 'Restricted';
  const load = () => {
    if (title !== null) return;
    setTitle('Loading who can see it…');
    Promise.all([getTaskAudience(task.id), audienceUsers()])
      .then(([a, users]) => setTitle(`Visible to ${namesOf(a.audience, users)}`))
      .catch(() => setTitle('Restricted'));
  };
  return (
    <span
      onMouseEnter={load}
      title={title ?? 'Restricted: hover to see who can see it'}
      className="g-tag g-tag-warn shrink-0 !min-h-[20px] !px-2 !gap-1 text-[11px]"
    >
      🔒 {label}
    </span>
  );
}

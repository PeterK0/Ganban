// Copy, paste and duplicate for calendar events. A copy is a new event made
// through `create_event` plus the link commands: it keeps the time, duration,
// description, location, reminder, repeat rule and its project and task links,
// but not its files, its done mark or its imported-calendar origin. A series'
// skipped days go with it only when it stays on its own day.
import { createEvent, getEventProjects, getEventTasks, linkEventToProject, linkEventToTask } from './api';
import type { CreateEventInput, Event } from '../types';

/** The events Cmd/Ctrl+C took, kept for the session and shared by every calendar
 * (the Events page and each project's Events tab). A series copied from the
 * Repeating view keeps its rule; one day of a series is a single event (no rule). */
let clipboard: Event[] = [];
export const setEventClipboard = (events: Event[]) => {
  clipboard = [...events];
};
export const getEventClipboard = (): Event[] => clipboard;

const pad2 = (n: number) => String(n).padStart(2, '0');
/** A local YYYY-MM-DD. */
export const localDay = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** The source's event_date moved to `day` (YYYY-MM-DD), keeping its local time of day. */
export function movedEventDate(src: Event, day: string): string {
  const s = new Date(src.event_date);
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, s.getHours(), s.getMinutes(), s.getSeconds()).toISOString();
}

/** One day of a series as a single event: that day's date, no rule, no skipped days. */
export const singleDayOf = (occurrence: Event): Event => ({ ...occurrence, rrule: null, exdates: null, series_id: null });

/**
 * Create a copy of `src` on `day` (default: its own day). `projectId` adds a link to that
 * project (a project's own calendar keeps the copy in view). `as` overrides fields of
 * the new event. Link failures don't undo the copy; they come back in `linkErrors`.
 */
export async function copyEvent(
  src: Event,
  opts: { day?: string; projectId?: number; as?: Partial<CreateEventInput> } = {},
): Promise<{ event: Event; linkErrors: number }> {
  const input: CreateEventInput = {
    title: src.title,
    description: src.description || undefined,
    location: src.location || undefined,
    event_date: opts.day ? movedEventDate(src, opts.day) : src.event_date,
    start_time: src.start_time || undefined,
    end_time: src.end_time || undefined,
    all_day: src.all_day,
    reminder_minutes: src.reminder_minutes ?? undefined,
    notification_enabled: src.notification_enabled,
    rrule: src.rrule || null,
    exdates: src.rrule && (!opts.day || opts.day === localDay(new Date(src.event_date))) ? src.exdates || null : null,
    ...opts.as,
  };
  const [projects, tasks] = await Promise.all([
    getEventProjects(src.id).catch(() => []),
    getEventTasks(src.id).catch(() => []),
  ]);
  const event = await createEvent(input);
  const projectIds = new Set(projects.map((p) => p.id));
  if (opts.projectId != null) projectIds.add(opts.projectId);
  const links = await Promise.allSettled([
    ...[...projectIds].map((id) => linkEventToProject(event.id, id)),
    ...tasks.map((t) => linkEventToTask(event.id, t.id)),
  ]);
  return { event, linkErrors: links.filter((r) => r.status === 'rejected').length };
}

/** "Tue 4 Nov" for the paste toast. */
export const shortDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};

// One day of a repeating event at a time. A series is one stored event (its
// master) with a rule; these change a day, the days from one on, or all of them,
// through the ordinary event commands:
//   - "This event": the day joins the master's skipped days (`exdates`); an edit
//     or a past mark lands on a one-off copy for that day (`series_id` → master).
//   - "This and following": the master ends the day before (UNTIL) and a new
//     series starts on the day with the change.
//   - "All events": the master itself.
import { deleteEvent, getEvent, setEventDone, updateEvent } from './api';
import { copyEvent, localDay, movedEventDate } from './eventCopy';
import { addExdates, endRuleAt, parseExdates, splitRule } from './recur.pure';
import type { CreateEventInput, Event } from '../types';

export type SeriesScope = 'this' | 'following' | 'all';

/** A display event's selection key: its id and day ("12@2026-11-03"), so each
 * day of a series is its own pick. */
export const occurrenceKey = (e: Event) => `${e.id}@${localDay(new Date(e.event_date))}`;

/** The day before an ISO day. */
const dayBefore = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return localDay(new Date(y, m - 1, d - 1));
};

/** The series as stored now: a list or an editor may hold an older copy (or a
 * day's display clone), and a skip written over a stale one would undo another. */
const fresh = async (master: Event): Promise<Event> => (await getEvent(master.id).catch(() => null)) ?? master;

/** Skip `days` of the series. */
export const skipDays = async (master: Event, days: string[]) => {
  const m = await fresh(master);
  return updateEvent(m.id, { exdates: addExdates(m.exdates, ...days) || null });
};

/**
 * "This event": a one-off copy of `day` (with `change` on it, its links kept) takes
 * the day's place, and the series skips the day. Returns the copy.
 */
export async function detachDay(master: Event, day: string, change: Partial<CreateEventInput> = {}): Promise<Event> {
  const { event } = await copyEvent(master, {
    day,
    as: { event_date: movedEventDate(master, day), rrule: null, exdates: null, series_id: master.id, ...change },
  });
  try {
    await skipDays(master, [day]);
  } catch (e) {
    await deleteEvent(event.id).catch(() => {}); // the day isn't doubled
    throw e;
  }
  return event;
}

/**
 * "This and following": end the series the day before `day` and start a new one on
 * `day` with `change` (its links and rule kept, COUNT shared out, skipped days
 * from `day` on moved over). Returns the new series, or null when nothing comes
 * before `day`: then the whole series is "this and following", so change the master.
 */
export async function splitAt(stale: Event, day: string, change: Partial<CreateEventInput> = {}): Promise<Event | null> {
  const master = await fresh(stale);
  if (!master.rrule) return null;
  const { head, tail } = splitRule(master.rrule, new Date(master.event_date), day);
  if (!head) return null;
  const skipped = parseExdates(master.exdates);
  const { event } = await copyEvent(master, {
    day,
    as: {
      event_date: movedEventDate(master, day),
      rrule: tail,
      exdates: skipped.filter((d) => d >= day).join(',') || null,
      ...change,
    },
  });
  await updateEvent(master.id, { rrule: head, exdates: skipped.filter((d) => d < day).join(',') || null });
  return event;
}

/** End the series on `day` (its last possible day), COUNT dropped. A series
 * that starts after `day` has nothing left, so it goes to the Bin instead of
 * staying as a rule with no days. */
export async function endSeriesOn(master: Event, day: string): Promise<void> {
  const rrule = endRuleAt(master.rrule ?? '', new Date(master.event_date), day);
  if (rrule) await updateEvent(master.id, { rrule });
  else await deleteEvent(master.id);
}

/** Delete days of a series as `scope` says. `days` are the picked days of this master. */
export async function deleteDays(stale: Event, days: string[], scope: SeriesScope): Promise<void> {
  const master = scope === 'following' ? await fresh(stale) : stale;
  if (scope === 'this') {
    await skipDays(master, days);
    return;
  }
  if (scope === 'following' && master.rrule) {
    const first = [...days].sort()[0];
    const { head } = splitRule(master.rrule, new Date(master.event_date), first);
    if (head) {
      await endSeriesOn(master, dayBefore(first));
      return;
    }
  }
  await deleteEvent(master.id);
}

/**
 * Mark days of a series past (or upcoming again) as `scope` says: one-off copies
 * for "This event", a new series for "This and following", the master for "All".
 * Returns the events that now carry the mark.
 */
export async function markDays(master: Event, days: string[], done: boolean, scope: SeriesScope): Promise<Event[]> {
  if (scope === 'this') {
    const out: Event[] = [];
    for (const day of [...days].sort()) {
      const copy = await detachDay(master, day); // re-reads the series: the skips add up
      out.push(await setEventDone(copy.id, done));
    }
    return out;
  }
  if (scope === 'following') {
    const series = await splitAt(master, [...days].sort()[0]);
    if (series) return [await setEventDone(series.id, done)];
  }
  return [await setEventDone(master.id, done)];
}

/** A picked day of an event: the stored event (a series' master) and the day. */
export interface PickedDay {
  master: Event;
  day: string;
}

/** The picks grouped by stored event, each with its days. */
function byMaster(picks: PickedDay[]): { master: Event; days: string[] }[] {
  const groups = new Map<number, { master: Event; days: string[] }>();
  for (const p of picks) {
    const g = groups.get(p.master.id);
    if (g) g.days.push(p.day);
    else groups.set(p.master.id, { master: p.master, days: [p.day] });
  }
  return [...groups.values()];
}

/**
 * Apply a past mark or a delete to picked days. Days of a series ask `ask` once
 * which days the change covers (null = cancelled: nothing changes, returns null).
 * Returns how many stored events changed and how many failed.
 */
export async function applyToDays(
  picks: PickedDay[],
  what: { delete: true } | { done: boolean },
  ask: () => Promise<SeriesScope | null>,
): Promise<{ changed: number; failed: number } | null> {
  const groups = byMaster(picks);
  const scope = groups.some((g) => g.master.rrule) ? await ask() : 'all';
  if (!scope) return null;
  const results = await Promise.allSettled(
    groups.map(async ({ master, days }) => {
      const s: SeriesScope = master.rrule ? scope : 'all';
      if ('delete' in what) await deleteDays(master, days, s);
      else await markDays(master, days, what.done, s);
    }),
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  return { changed: results.length - failed, failed };
}

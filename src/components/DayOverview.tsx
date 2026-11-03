import { useCallback, useEffect, useState } from 'react';
import type { Event } from '../types';
import { getEvents, createEvent, linkEventToProject } from '../lib/api';
import { canExpand, seriesOccurrences } from '../lib/recur.pure';
import { applyToDays } from '../lib/eventSeries';
import { askSeriesScope } from './SeriesScopeDialog';
import { useDataPulse } from '../lib/livePulse';
import EventCard from './EventCard';

const toLocalDateString = (d: Date) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const localDateAtMidnight = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const shiftDate = (s: string, days: number) => {
  const d = localDateAtMidnight(s);
  d.setDate(d.getDate() + days);
  return toLocalDateString(d);
};

/** Right-pane overview for a single calendar day: the events on it (timed
 * first), with an Add Event button. Shown when a day is clicked in Month view,
 * so a click no longer fires a create-confirm modal. Self-contained — it loads
 * its own events and refreshes on the data pulse. */
export default function DayOverview({
  date,
  scopeProjectId,
  onOpenEvent,
  onChanged,
}: {
  date: string; // local YYYY-MM-DD
  scopeProjectId?: number | null;
  /** A day of a repeating event opens its series (the master) with that day. */
  onOpenEvent: (event: Event, occurrence?: string | null) => void;
  onChanged?: () => void;
}) {
  const [events, setEvents] = useState<Event[]>([]);
  const [masters, setMasters] = useState<Map<number, Event>>(new Map());
  const masterOf = (e: Event) => masters.get(e.id) ?? e;
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      // Fetch a ±1-day window so an event that lands on this LOCAL day but a
      // neighbouring UTC day (the backend filters on the UTC date) isn't
      // missed, then keep only this local day. Recurring masters come back
      // regardless of the window and are expanded here.
      const lo = shiftDate(date, -1);
      const hi = shiftDate(date, 1);
      const raw = await getEvents(lo, hi, false);
      const loDt = localDateAtMidnight(lo);
      const hiDt = new Date(`${hi}T23:59:59`);
      const expanded: Event[] = [];
      for (const e of raw) {
        if (!e.rrule || !canExpand(e.rrule)) {
          // A rule we can't expand shows as its master, as in CalendarView.
          expanded.push(e);
          continue;
        }
        for (const o of seriesOccurrences(e.rrule, new Date(e.event_date), e.exdates, loDt, hiDt)) {
          expanded.push({ ...e, event_date: o.toISOString() });
        }
      }
      const dayEvents = expanded
        .filter((e) => toLocalDateString(new Date(e.event_date)) === date)
        .sort((a, b) => Number(a.all_day) - Number(b.all_day) || (a.start_time || '').localeCompare(b.start_time || ''));
      setEvents(dayEvents);
      setMasters(new Map(raw.map((e) => [e.id, e])));
    } catch (err) {
      console.error('Failed to load day events:', err);
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);
  // A teammate's (or our own) write refreshes the list — including the event we
  // just added from here, once we navigate back to this overview.
  useDataPulse(() => void load(), ['events', 'projects']);

  const addEvent = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const newEvent = await createEvent({
        title: 'New Event',
        event_date: localDateAtMidnight(date).toISOString(),
        all_day: true,
        notification_enabled: false,
      });
      // In a project-scoped calendar, link the event so it belongs to (and
      // shows under) the project. Non-fatal if it fails.
      if (scopeProjectId != null) {
        try {
          await linkEventToProject(newEvent.id, scopeProjectId);
        } catch {
          /* keep the event; the link can be added from the editor */
        }
      }
      onChanged?.();
      onOpenEvent(newEvent); // open the editor so the user can fill it in
    } catch (err) {
      alert(`Failed to create event: ${err}`);
    } finally {
      setCreating(false);
    }
  };

  const d = localDateAtMidnight(date);
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gilt-b shrink-0">
        <div className="min-w-0">
          <div className="g-deco text-[13px] font-semibold text-gold">{d.toLocaleDateString('en-US', { weekday: 'long' })}</div>
          <div className="text-xs text-[color:var(--g-mut)]">
            {d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
          </div>
        </div>
        <button
          onClick={addEvent}
          disabled={creating}
          className="g-btn g-btn-pri g-btn-sm shrink-0"
        >
          {creating ? 'Adding…' : '+ Add Event'}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {loading ? (
          <p className="text-center text-[color:var(--g-mut)] py-8">Loading…</p>
        ) : events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center text-[color:var(--g-mut)]">
            <p>No events on this day.</p>
            <p className="text-xs mt-1">Use “Add Event” to create one.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {events.map((event) => (
              <EventCard
                key={`${event.id}-${event.event_date}`}
                event={event}
                onClick={() => (event.rrule ? onOpenEvent(masterOf(event), date) : onOpenEvent(event))}
                onToggleDone={async (done) => {
                  await applyToDays([{ master: masterOf(event), day: date }], { done }, () =>
                    askSeriesScope({ action: done ? 'past' : 'upcoming', title: event.title }),
                  );
                }}
                onChanged={() => {
                  void load();
                  onChanged?.();
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import { getEvents, createEvent, updateEvent } from '../lib/api';
import type { Event, UpdateEventInput } from '../types';
import { copyEvent } from '../lib/eventCopy';

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

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

const fieldClass =
  'g-field g-field-sm';

/** One event in the popover list: collapsed = title + when; click to expand for
 * details, with a pen to amend it inline (title/date/time/location/notes) — no
 * trip to the full calendar for a quick fix. */
function EventRow({ event, onChanged }: { event: Event; onChanged: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  // Edit-form state, (re)seeded from the event whenever we enter edit mode.
  const [title, setTitle] = useState(event.title);
  const [allDay, setAllDay] = useState(event.all_day);
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');

  const beginEdit = () => {
    setTitle(event.title);
    setAllDay(event.all_day);
    setDate(toLocalDateString(new Date(event.event_date)));
    setStartTime(event.start_time || '');
    setEndTime(event.end_time || '');
    setLocation(event.location || '');
    setDescription(event.description || '');
    setEditing(true);
  };

  const duplicate = async () => {
    setSaving(true);
    try {
      await copyEvent(event);
      onChanged();
    } catch (err) {
      alert(`Couldn't duplicate the event: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!title.trim() || !date) {
      alert('Title and date are required');
      return;
    }
    setSaving(true);
    try {
      const input: UpdateEventInput = {
        title: title !== event.title ? title : undefined,
        description: description !== (event.description || '') ? description || undefined : undefined,
        location: location !== (event.location || '') ? location || undefined : undefined,
        event_date:
          date !== toLocalDateString(new Date(event.event_date)) ? localDateAtMidnight(date).toISOString() : undefined,
        start_time: startTime !== (event.start_time || '') ? startTime || undefined : undefined,
        end_time: endTime !== (event.end_time || '') ? endTime || undefined : undefined,
        all_day: allDay !== event.all_day ? allDay : undefined,
      };
      await updateEvent(event.id, input);
      setEditing(false);
      onChanged();
    } catch (err) {
      console.error('Failed to update event:', err);
      alert(`Failed to update event: ${err}`);
    } finally {
      setSaving(false);
    }
  };

  const whenLabel = event.all_day
    ? 'All day'
    : event.start_time
    ? `${event.start_time}${event.end_time ? ` – ${event.end_time}` : ''}`
    : '';
  const dateLabel = new Date(event.event_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return (
    <div className="g-inset p-0 overflow-hidden">
      <div className="flex items-start gap-2 p-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex items-start gap-2 flex-1 min-w-0 text-left"
          title={expanded ? 'Collapse' : 'Expand'}
        >
          <svg className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          <div className="flex-1 min-w-0">
            <p className={`text-xs font-medium text-text ${expanded ? 'break-words' : 'truncate'} ${event.done_at ? 'line-through opacity-60' : ''}`}>{event.title}</p>
            <p className="text-xs text-subtext-0">
              {dateLabel}
              {whenLabel && ` · ${whenLabel}`}
              {event.done_at && ' · Done'}
            </p>
          </div>
        </button>
        {expanded && !editing && (
          <button
            onClick={() => void duplicate()}
            disabled={saving}
            title="Duplicate (a copy on the same day, with the same links)"
            aria-label="Duplicate event"
            className="shrink-0 p-1 rounded text-subtext-0 hover:bg-surface-2 hover:text-text transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="8" y="8" width="12" height="12" rx="2" strokeWidth={2} />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" />
            </svg>
          </button>
        )}
        {expanded && !editing && (
          <button
            onClick={beginEdit}
            title="Edit event"
            className="shrink-0 p-1 rounded text-subtext-0 hover:bg-surface-2 hover:text-text transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Expanded read-only details */}
      {expanded && !editing && (event.location || event.description) && (
        <div className="px-2 pb-2 pl-8 space-y-1">
          {event.location && (
            <p className="text-xs text-subtext-1 break-words">
              <span className="text-subtext-0">Location: </span>
              {event.location}
            </p>
          )}
          {event.description && <p className="text-xs text-subtext-1 whitespace-pre-wrap break-words">{event.description}</p>}
        </div>
      )}

      {/* Inline edit form */}
      {editing && (
        <div className="px-2 pb-2 pt-1 space-y-2">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className={fieldClass} />
          <label className="flex items-center gap-2 text-xs text-subtext-1">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
            All day
          </label>
          <div className="flex gap-2">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={fieldClass} />
            {!allDay && (
              <>
                <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={fieldClass} />
                <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={fieldClass} />
              </>
            )}
          </div>
          <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Location" className={fieldClass} />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Notes"
            rows={2}
            className={`${fieldClass} resize-none`}
          />
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="g-btn g-btn-ghost g-btn-sm"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="g-btn g-btn-pri g-btn-sm"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface EventDropdownProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateToCalendar: () => void;
  // The live clock now lives in this popup's header (the top bar shows only the
  // trigger icon). Passed from the parent so it ticks with the app's clock.
  dateLabel?: string;
  timeLabel?: string;
  tzLabel?: string;
}

export default function EventDropdown({ isOpen, onClose, onNavigateToCalendar, dateLabel, timeLabel, tzLabel }: EventDropdownProps) {
  const [events, setEvents] = useState<Event[]>([]);
  const failStreak = useRef(false);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [creating, setCreating] = useState(false);

  const isSameDay = (a: Date, b: Date) =>
    a.getDate() === b.getDate() &&
    a.getMonth() === b.getMonth() &&
    a.getFullYear() === b.getFullYear();

  useEffect(() => {
    if (isOpen) {
      loadEvents();
    }
  }, [isOpen, currentMonth]);

  const loadEvents = async () => {
    setIsLoading(true);
    try {
      // Get events for the current month
      const startOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
      const endOfMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0);

      const allEvents = await getEvents(
        startOfMonth.toISOString().split('T')[0],
        endOfMonth.toISOString().split('T')[0],
        false
      );
      setEvents(allEvents);
      failStreak.current = false;
    } catch (error) {
      if (!failStreak.current) console.warn('Events load failing (will retry quietly):', error);
      failStreak.current = true;
    } finally {
      setIsLoading(false);
    }
  };

  const getDaysInMonth = () => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startDayOfWeek = firstDay.getDay(); // 0 = Sunday

    const days: (Date | null)[] = [];

    // Add empty cells for days before the first day of month
    for (let i = 0; i < startDayOfWeek; i++) {
      days.push(null);
    }

    // Add all days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      days.push(new Date(year, month, day));
    }

    return days;
  };

  const getEventsForDate = (date: Date) => {
    return events.filter(event => {
      const eventDate = new Date(event.event_date);
      return (
        eventDate.getDate() === date.getDate() &&
        eventDate.getMonth() === date.getMonth() &&
        eventDate.getFullYear() === date.getFullYear()
      );
    });
  };

  const isToday = (date: Date) => {
    const today = new Date();
    return (
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    );
  };

  const goToPreviousMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1));
  };

  const goToNextMonth = () => {
    setCurrentMonth(new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1));
  };

  const goToToday = () => {
    setCurrentMonth(new Date());
    setSelectedDate(null);
  };

  // Quick-add an all-day placeholder on the selected day (or today). Stays in
  // the popup and refreshes the list so the new event shows immediately; the
  // user renames it later from the full calendar.
  const handleAddEvent = async () => {
    if (creating) return;
    setCreating(true);
    const target = selectedDate ?? new Date();
    const midnight = new Date(target.getFullYear(), target.getMonth(), target.getDate());
    try {
      await createEvent({
        title: 'New Event',
        event_date: midnight.toISOString(),
        all_day: true,
        notification_enabled: false,
      });
      setCurrentMonth(new Date(midnight.getFullYear(), midnight.getMonth()));
      setSelectedDate(midnight);
      await loadEvents();
    } catch (error) {
      console.error('Failed to create event:', error);
      alert(`Failed to create event: ${error}`);
    } finally {
      setCreating(false);
    }
  };

  if (!isOpen) return null;

  const days = getDaysInMonth();
  const monthName = currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
      />

      {/* Dropdown — anchored to the right since the trigger now lives in the
          right-hand toolbar (was a centered pill). */}
      <div className="g-card g-corners absolute top-full mt-3 right-0 w-96 max-h-[calc(100vh-7rem)] flex flex-col overflow-hidden shadow-2xl z-50 whitespace-normal">
        {/* Header */}
        <div className="shrink-0 px-5 pt-5 pb-4 border-b border-gilt-b">
          {(timeLabel || dateLabel) && (
            <div className="flex items-baseline gap-2 mb-3">
              <span className="g-deco text-2xl font-semibold text-text tabular-nums tracking-[.12em]">{timeLabel}</span>
              {tzLabel && <span className="text-xs text-subtext-0 font-medium">{tzLabel}</span>}
              <span className="ml-auto text-sm text-subtext-0">{dateLabel}</span>
            </div>
          )}
          {/* Month Navigation */}
          <div className="flex items-center justify-between">
            <button
              onClick={goToPreviousMonth}
              className="g-iconbtn" style={{ width: 32, height: 32 }}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="flex items-center gap-2">
              <span className="g-deco text-[13px] font-semibold text-gold">{monthName}</span>
              <button
                onClick={goToToday}
                className="px-2.5 min-h-[28px] text-xs text-gold rounded ring-1 ring-inset ring-gilt-a hover:bg-gilt-b transition-colors"
              >
                Today
              </button>
            </div>
            <button
              onClick={goToNextMonth}
              className="g-iconbtn" style={{ width: 32, height: 32 }}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>

        {/* Calendar Grid — fixed (shrink-0), never the scroller: its aspect-square
            cells make height depend on width, so scrolling it would oscillate the
            scrollbar (appear → narrower → shorter → fits → disappear → repeat). */}
        <div className="shrink-0 p-4">
          {/* Day Headers */}
          <div className="grid grid-cols-7 gap-1 mb-2">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
              <div key={day} className="text-center text-xs font-medium text-subtext-0 py-1">
                {day}
              </div>
            ))}
          </div>

          {/* Calendar Days */}
          <div className="grid grid-cols-7 gap-1">
            {days.map((date, index) => {
              if (!date) {
                return <div key={`empty-${index}`} className="aspect-square" />;
              }

              const dayEvents = getEventsForDate(date);
              const today = isToday(date);
              const selected = selectedDate ? isSameDay(date, selectedDate) : false;

              return (
                <div
                  key={index}
                  onClick={() => setSelectedDate(date)}
                  className={`aspect-square p-1 rounded border transition-colors cursor-pointer ${
                    today
                      ? 'border-primary bg-primary/10'
                      : dayEvents.length > 0
                      ? 'border-warning bg-warning/10 hover:bg-warning/20'
                      : 'border-surface-2 hover:bg-surface-1'
                  } ${selected ? 'ring-2 ring-primary' : ''}`}
                  title={dayEvents.length > 0 ? dayEvents.map(e => e.title).join(', ') : ''}
                >
                  <div className="flex flex-col items-center justify-center h-full">
                    <span className={`text-xs ${today ? 'font-bold text-primary' : 'text-text'}`}>
                      {date.getDate()}
                    </span>
                    {dayEvents.length > 0 && (
                      <div className="flex gap-0.5 mt-0.5">
                        {dayEvents.slice(0, 3).map((_, i) => (
                          <div key={i} className="w-1 h-1 rounded-full bg-warning" />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Events list — the ONLY scroller. Single-line (truncate) items, so its
            height doesn't depend on width: a scrollbar appears/stays cleanly with
            no flashing. Shrinks (min-h-0) to keep the popover within max-h; the
            popover still sizes to content when the list is short. */}
        <div className="min-h-0 overflow-y-auto border-t border-gilt-b p-4">
          {(() => {
            const dayEvents = selectedDate
              ? events
                  .filter((e) => isSameDay(new Date(e.event_date), selectedDate))
                  .sort(
                    (a, b) =>
                      new Date(a.event_date).getTime() - new Date(b.event_date).getTime()
                  )
              : events
                  .filter((e) => !e.done_at && new Date(e.event_date) >= startOfToday())
                  .sort(
                    (a, b) =>
                      new Date(a.event_date).getTime() - new Date(b.event_date).getTime()
                  )
                  .slice(0, 3);

            const heading = selectedDate
              ? `Events on ${selectedDate.toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })}`
              : 'Upcoming Events';

            return (
              <>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <h4 className="text-sm font-semibold text-text truncate">{heading}</h4>
                    <button
                      onClick={handleAddEvent}
                      disabled={creating}
                      title={`Add an event on ${(selectedDate ?? new Date()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
                      className="shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-primary/20 text-primary hover:bg-primary/30 transition-colors disabled:opacity-50"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                    </button>
                  </div>
                  {selectedDate && (
                    <button
                      onClick={() => setSelectedDate(null)}
                      className="shrink-0 text-xs text-primary hover:text-primary-hover"
                      title="Show upcoming events"
                    >
                      Reset
                    </button>
                  )}
                </div>
                {isLoading ? (
                  <p className="text-xs text-subtext-0">Loading...</p>
                ) : dayEvents.length > 0 ? (
                  <div className="space-y-2">
                    {dayEvents.map((event) => (
                      <EventRow key={event.id} event={event} onChanged={loadEvents} />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-subtext-0">
                    {selectedDate ? 'No events on this date' : 'No upcoming events'}
                  </p>
                )}
              </>
            );
          })()}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-gilt-b px-5 pt-4 pb-5">
          <button
            onClick={() => {
              onNavigateToCalendar();
              onClose();
            }}
            className="g-btn g-btn-pri g-glint w-full"
          >
            Open Full Calendar
          </button>
        </div>
      </div>
    </>
  );
}

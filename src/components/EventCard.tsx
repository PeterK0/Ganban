import { useState } from 'react';
import { setEventDone } from '../lib/api';
import type { Event } from '../types';

interface EventCardProps {
  event: Event;
  onClick: () => void;
  isSelected?: boolean;
  /** A `.c-*` colour class for the event's gem (its project's colour). Gold when absent. */
  gemClass?: string;
  /** Set to offer "Mark as past" / "Mark as upcoming" on the card; called once it's saved. */
  onChanged?: () => void;
  /** Marks the card's event (one day of a series asks which days); without it the
   * card marks the stored event itself. */
  onToggleDone?: (done: boolean) => Promise<void>;
  /** Set to offer "Duplicate" on the card. */
  onDuplicate?: () => void;
  /** Multi-select: the card shows a checkbox (on hover, or always while anything is selected). */
  select?: { on: boolean; any: boolean; onToggle: (e: React.MouseEvent) => void };
}

/** The checkbox that picks an event for the calendar's bulk actions. A plain
 * click toggles it (Shift-click is a range where the list has an order). */
export function SelectCheck({ on, onToggle, className = '' }: { on: boolean; onToggle: (e: React.MouseEvent) => void; className?: string }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={on ? 'Deselect event' : 'Select event'}
      title={on ? 'Deselect' : 'Select (Shift-click for a range in the agenda)'}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onToggle(e);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className={`g-hit shrink-0 w-4 h-4 rounded-sm border flex items-center justify-center text-[10px] leading-none transition-colors ${
        on ? 'bg-gold border-gold text-mantle' : 'border-[color:var(--g-mut)] text-transparent hover:border-gold bg-base'
      } ${className}`}
    >
      ✓
    </button>
  );
}

const MUTED = 'text-[color:var(--g-mut)]';

export default function EventCard({ event, onClick, isSelected = false, gemClass, onChanged, onToggleDone, onDuplicate, select }: EventCardProps) {
  const done = !!event.done_at;
  const files = event.file_count ?? 0;
  const [busy, setBusy] = useState(false);
  const toggleDone = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      if (onToggleDone) await onToggleDone(!done);
      else await setEventDone(event.id, !done);
      onChanged?.();
    } catch (err) {
      alert(`Couldn't mark the event: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const formatTime = (timeString?: string) => {
    if (!timeString) return '';
    // Time string is in HH:MM format
    const [hours, minutes] = timeString.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${minutes} ${ampm}`;
  };

  const getTimeDisplay = () => {
    if (event.all_day) {
      return 'All Day';
    }
    if (event.start_time && event.end_time) {
      return `${formatTime(event.start_time)} - ${formatTime(event.end_time)}`;
    }
    if (event.start_time) {
      return formatTime(event.start_time);
    }
    return '';
  };

  const isToday = () => {
    const today = new Date();
    const eventDate = new Date(event.event_date);
    return (
      eventDate.getDate() === today.getDate() &&
      eventDate.getMonth() === today.getMonth() &&
      eventDate.getFullYear() === today.getFullYear()
    );
  };

  const isPast = () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const eventDate = new Date(event.event_date);
    eventDate.setHours(0, 0, 0, 0);
    return eventDate < today;
  };

  const getDateIndicator = () => {
    if (done) {
      return { label: 'Done', color: 'g-tag-ok' };
    }
    if (isPast()) {
      return { label: 'Past', color: '' };
    }
    if (isToday()) {
      return { label: 'Today', color: 'text-gold bg-gilt-b' };
    }
    return null;
  };

  const dateIndicator = getDateIndicator();
  const d = new Date(event.event_date);

  return (
    <div
      onClick={(e) => {
        // ⌘/Ctrl-click picks the card, as elsewhere in the calendar.
        if (select && (e.metaKey || e.ctrlKey)) select.onToggle(e);
        else onClick();
      }}
      className={`group relative g-card p-4 flex gap-4 min-w-0 cursor-pointer transition-colors ${
        select?.on ? 'g-sel !border-gold' : isSelected ? '!border-gold' : 'hover:border-gold/55'
      } ${done ? 'opacity-60' : isPast() ? 'opacity-70' : ''}`}
    >
      {select && (
        <SelectCheck
          on={select.on}
          onToggle={select.onToggle}
          className={`absolute top-1.5 left-1.5 ${select.on || select.any ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
        />
      )}
      {/* Date block: deco month over a large day (the prototype's Upcoming events) */}
      <div className="w-[56px] shrink-0 text-center pt-1" title={formatDate(event.event_date)}>
        <span className={`g-deco block text-[10px] ${MUTED}`}>
          {d.toLocaleDateString('en-US', { month: 'short' })}
        </span>
        <span className="block font-deco text-[28px] leading-none text-text mt-1">{d.getDate()}</span>
        <span className={`block text-[11px] mt-1 ${MUTED}`}>
          {d.toLocaleDateString('en-US', { weekday: 'short' })}
        </span>
      </div>

      <div className="flex-1 min-w-0 border-l border-gilt-b pl-4">
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <h3 className="font-semibold text-text break-words flex items-center gap-2 min-w-0">
            <span className={`g-gem ${gemClass ?? ''}`} aria-hidden="true" />
            <span className={`min-w-0 break-words ${done ? 'line-through' : ''}`}>{event.title}</span>
          </h3>
          {dateIndicator && (
            <span className={`g-tag shrink-0 ${dateIndicator.color}`}>{dateIndicator.label}</span>
          )}
        </div>

        {/* Time */}
        <div className={`flex items-center gap-2 text-sm mb-1 ${MUTED}`}>
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="min-w-0 break-words tabular-nums">{getTimeDisplay()}</span>
        </div>

        {/* Location */}
        {event.location && (
          <div className={`flex items-center gap-2 text-sm mb-1 ${MUTED}`}>
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span className="min-w-0 break-words">{event.location}</span>
          </div>
        )}

        {/* Description preview */}
        {event.description && (
          <p className="text-sm text-[color:var(--g-fg2)] line-clamp-2 mt-2">{event.description}</p>
        )}

        {/* Files and the past mark */}
        {(files > 0 || onChanged || onDuplicate) && (
          <div className="flex items-center justify-between gap-2 mt-2">
            <span className={`flex items-center gap-1 text-xs ${MUTED}`}>
              {files > 0 && (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  {files} file{files === 1 ? '' : 's'}
                </>
              )}
            </span>
            <span className="flex items-center gap-3 shrink-0">
            {onDuplicate && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDuplicate();
                }}
                className="g-lnk !min-h-[32px] !text-xs"
                title="Make a copy on the same day"
              >
                Duplicate
              </button>
            )}
            {onChanged && (
              <button
                onClick={(e) => void toggleDone(e)}
                disabled={busy}
                className="g-lnk !min-h-[32px] !text-xs shrink-0"
                title={event.rrule && !onToggleDone ? 'Applies to the whole series' : undefined}
              >
                {done ? 'Mark as upcoming' : 'Mark as past'}
              </button>
            )}
            </span>
          </div>
        )}

        {/* Reminder indicator */}
        {event.notification_enabled && event.reminder_minutes !== null && (
          <div className="flex items-center gap-1 text-xs text-info mt-2">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path d="M10 2a6 6 0 00-6 6v3.586l-.707.707A1 1 0 004 14h12a1 1 0 00.707-1.707L16 11.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-3-3h6a3 3 0 01-3 3z" />
            </svg>
            Reminder {event.reminder_minutes} min before
          </div>
        )}
      </div>
    </div>
  );
}

// The calendar's Repeating view: one row per series (a repeating event's master),
// to read and clean up repeats en masse. Rows tick like the agenda's (Shift-click
// for a range); the bar acts on every ticked series.
import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { deleteEvent, getEventProjects, getEventTasks, updateEvent } from '../lib/api';
import { confirmDialog } from '../lib/confirm';
import { endSeriesOn, occurrenceKey } from '../lib/eventSeries';
import { localDay } from '../lib/eventCopy';
import { describeRrule, nextOccurrence, parseExdates, ruleEnd } from '../lib/recur.pure';
import type { Event, Project, Task } from '../types';
import { SelectCheck } from './EventCard';
import { Modal } from './gilt';
import RepeatControl from './RepeatControl';

const MUTED = 'text-[color:var(--g-mut)]';
/** Title · repeats · started · ends · next · linked · skipped. */
const COLS = 'grid grid-cols-[1.25rem_minmax(9rem,1.4fr)_minmax(10rem,1.6fr)_6.5rem_7rem_7rem_minmax(7rem,1fr)_4rem] items-center gap-x-3';

const shortDate = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const longDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const dayAt = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** "Every weekday, 09:00–18:00". */
export const seriesWords = (e: Event) => {
  const rule = describeRrule(e.rrule ?? '', { end: false });
  const time = e.all_day ? 'all day' : e.start_time ? `${e.start_time}${e.end_time ? `–${e.end_time}` : ''}` : '';
  return time ? `${rule}, ${time}` : rule;
};

type Links = { projects: Project[]; tasks: Task[] };

export default function RepeatingView({
  series,
  selected,
  onCheck,
  onOpen,
  isOpen,
  onClear,
  onCopy,
  onChanged,
  showToast,
}: {
  /** The series in view (masters with a rule), already scoped to the project. */
  series: Event[];
  selected: Map<string, Event>;
  onCheck: (e: ReactMouseEvent, event: Event, ordered: Event[]) => void;
  onOpen: (event: Event) => void;
  isOpen: (event: Event) => boolean;
  onClear: () => void;
  onCopy: () => void;
  onChanged: () => Promise<void> | void;
  showToast: (msg: string) => void;
}) {
  const [links, setLinks] = useState<Map<number, Links>>(new Map());
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'time' | 'repeat' | null>(null);

  const rows = [...series].sort((a, b) => a.title.localeCompare(b.title) || a.event_date.localeCompare(b.event_date));
  const ids = rows.map((e) => e.id).join(',');
  // Each series' project and task links, for the Linked column.
  useEffect(() => {
    let live = true;
    Promise.all(
      rows.map(async (e) => {
        const [projects, tasks] = await Promise.all([
          getEventProjects(e.id).catch(() => [] as Project[]),
          getEventTasks(e.id).catch(() => [] as Task[]),
        ]);
        return [e.id, { projects, tasks }] as const;
      }),
    ).then((pairs) => live && setLinks(new Map(pairs)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);

  const picked = rows.filter((e) => selected.has(occurrenceKey(e)));
  const now = new Date();
  const today = localDay(now);

  /** Run `fn` on every ticked series, then reload and say how it went. */
  const bulk = async (what: string, fn: (e: Event) => Promise<unknown>, clear = false) => {
    if (picked.length === 0 || busy) return;
    setBusy(true);
    try {
      const results = await Promise.allSettled(picked.map(fn));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (clear) onClear();
      await onChanged();
      showToast(`${picked.length - failed} series ${what}${failed ? `; ${failed} failed` : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const endToday = () => void bulk('end today', (e) => endSeriesOn(e, today));
  const removeRepeat = () =>
    void bulk('now single events', (e) => updateEvent(e.id, { rrule: null, exdates: null }), true);
  const remove = async () => {
    if (picked.length === 0) return;
    const ok = await confirmDialog(
      `Move ${picked.length === 1 ? `“${picked[0].title}” and every day of it` : `${picked.length} repeating events and every day of them`} to the Bin? You can restore them there.`,
    );
    if (ok) await bulk('moved to the Bin', (e) => deleteEvent(e.id), true);
  };

  return (
    <div className="space-y-3">
      {picked.length > 0 ? (
        <div className="flex items-center flex-wrap gap-2 -mx-8 px-8 py-2 bg-gilt-b border-y border-gilt-a" role="toolbar" aria-label="Selected series">
          <span className="text-sm text-text font-semibold mr-1">{picked.length} selected</span>
          <button onClick={endToday} disabled={busy} className="g-btn g-btn-gilt g-btn-sm" title="No days after today">
            End today
          </button>
          <button onClick={() => setDialog('time')} disabled={busy} className="g-btn g-btn-gilt g-btn-sm">
            Change time…
          </button>
          <button onClick={() => setDialog('repeat')} disabled={busy} className="g-btn g-btn-gilt g-btn-sm">
            Change repeat…
          </button>
          <button onClick={removeRepeat} disabled={busy} className="g-btn g-btn-gilt g-btn-sm" title="Each becomes a single event on its start date">
            Remove repeat
          </button>
          <button onClick={onCopy} disabled={busy} className="g-btn g-btn-gilt g-btn-sm" title="Copy the series, then click a day in another view and paste">
            Copy
          </button>
          <button onClick={() => onOpen(picked[0])} disabled={busy} className="g-btn g-btn-gilt g-btn-sm">
            Open
          </button>
          <button onClick={() => void remove()} disabled={busy} className="g-btn g-btn-danger g-btn-sm">
            Delete
          </button>
          <button onClick={onClear} className="g-lnk" title="Clear the selection (Esc)">
            Clear
          </button>
          {busy && <span className={`text-xs ${MUTED}`}>Working…</span>}
        </div>
      ) : (
        <p className={`text-xs ${MUTED}`}>
          Every repeating event, one row per series. Tick rows to end, retime or remove them together (Shift-click for a range).
        </p>
      )}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-56 text-center">
          <p className="g-deco text-[15px] text-text mb-2">No repeating events</p>
          <p className={MUTED}>Set “Repeats” on an event to make it a series.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <div className="min-w-[60rem]">
            <div className={`${COLS} px-2 pb-2 border-b border-gilt-a`}>
              <span />
              <span className="g-cap">Event</span>
              <span className="g-cap">Repeats</span>
              <span className="g-cap">Started</span>
              <span className="g-cap">Ends</span>
              <span className="g-cap">Next</span>
              <span className="g-cap">Linked</span>
              <span className="g-cap text-right">Skipped</span>
            </div>
            <ul>
              {rows.map((e) => {
                const on = selected.has(occurrenceKey(e));
                const end = ruleEnd(e.rrule ?? '');
                const next = nextOccurrence(e.rrule ?? '', new Date(e.event_date), e.exdates, now);
                const ended = end.kind === 'until' && end.date < today;
                const l = links.get(e.id);
                const skipped = parseExdates(e.exdates).length;
                return (
                  <li
                    key={e.id}
                    className={`${COLS} min-h-[44px] px-2 rounded transition-colors border-b border-gilt-b ${
                      on ? 'g-sel' : isOpen(e) ? 'bg-surface-0 shadow-[inset_2px_0_0_var(--color-gold)]' : 'hover:bg-surface-0'
                    }`}
                  >
                    <SelectCheck on={on} onToggle={(ev) => onCheck(ev, e, rows)} />
                    <button
                      type="button"
                      onClick={(ev) => (ev.shiftKey || ev.metaKey || ev.ctrlKey ? onCheck(ev, e, rows) : onOpen(e))}
                      className={`min-w-0 text-left text-sm text-text truncate self-stretch ${e.done_at ? 'line-through opacity-60' : ''}`}
                      title={e.title}
                    >
                      {e.calendar_id != null && <span className="mr-1 text-xs" title="Imported calendar">📥</span>}
                      {e.title}
                    </button>
                    <span className="min-w-0 text-sm text-[color:var(--g-fg2)] truncate" title={describeRrule(e.rrule ?? '')}>
                      {seriesWords(e)}
                    </span>
                    <span className={`text-xs tabular-nums ${MUTED}`}>{longDate(new Date(e.event_date))}</span>
                    <span className={`text-xs tabular-nums ${ended ? 'text-subtext-0' : MUTED}`}>
                      {end.kind === 'never' ? 'Never' : end.kind === 'count' ? `After ${end.count}` : `${ended ? 'Ended ' : ''}${longDate(dayAt(end.date))}`}
                    </span>
                    <span className={`text-xs tabular-nums ${next ? 'text-text' : MUTED}`}>{next ? shortDate(next) : '—'}</span>
                    <span className={`min-w-0 text-xs truncate ${MUTED}`} title={l ? [...l.projects.map((p) => p.name), ...l.tasks.map((t) => t.title)].join(', ') : undefined}>
                      {!l ? '…' : l.projects.length + l.tasks.length === 0 ? '—' : [
                        l.projects[0]?.name,
                        l.projects.length > 1 ? `+${l.projects.length - 1}` : null,
                        l.tasks.length ? `${l.tasks.length} task${l.tasks.length === 1 ? '' : 's'}` : null,
                      ].filter(Boolean).join(' · ')}
                    </span>
                    <span className={`text-xs tabular-nums text-right ${MUTED}`}>{skipped || '—'}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {dialog === 'time' && (
        <TimeDialog
          first={picked[0]}
          count={picked.length}
          onClose={() => setDialog(null)}
          onApply={(t) => {
            setDialog(null);
            void bulk('retimed', (e) =>
              updateEvent(e.id, t.allDay ? { all_day: true } : { all_day: false, start_time: t.start, end_time: t.end }),
            );
          }}
        />
      )}
      {dialog === 'repeat' && picked[0] && (
        <RepeatDialog
          first={picked[0]}
          count={picked.length}
          onClose={() => setDialog(null)}
          onApply={(rrule) => {
            setDialog(null);
            void bulk(
              rrule ? 'repeat changed' : 'now single events',
              (e) => updateEvent(e.id, rrule ? { rrule } : { rrule: null, exdates: null }),
              !rrule,
            );
          }}
        />
      )}
    </div>
  );
}

/** "Change time…": one start and end (or all day) for every ticked series. */
function TimeDialog({
  first,
  count,
  onClose,
  onApply,
}: {
  first?: Event;
  count: number;
  onClose: () => void;
  onApply: (t: { allDay: boolean; start: string; end: string }) => void;
}) {
  const [allDay, setAllDay] = useState(!!first?.all_day);
  const [start, setStart] = useState(first?.start_time ?? '09:00');
  const [end, setEnd] = useState(first?.end_time ?? '');
  const bad = !allDay && (!start || (!!end && end <= start));
  return (
    <Modal onClose={onClose} title="Change time" className="w-[400px]">
      <div className="px-6 pt-1 pb-5 space-y-4">
        <p className={`text-[13px] text-center ${MUTED}`}>For {count === 1 ? 'every day of the series' : `every day of ${count} series`}.</p>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="w-4 h-4 accent-[color:var(--color-primary)]" />
          All day
        </label>
        {!allDay && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="g-flbl">Start</label>
              <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className="g-field" />
            </div>
            <div>
              <label className="g-flbl">End</label>
              <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className="g-field" />
            </div>
          </div>
        )}
        {bad && start && <p className="text-xs text-error">The end comes after the start.</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="g-btn g-btn-ghost g-btn-sm">
            Cancel
          </button>
          <button type="button" disabled={bad} onClick={() => onApply({ allDay, start, end })} className="g-btn g-btn-pri g-btn-sm">
            Change time
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** "Change repeat…": one rule (the Repeats control) for every ticked series. */
function RepeatDialog({
  first,
  count,
  onClose,
  onApply,
}: {
  first: Event;
  count: number;
  onClose: () => void;
  onApply: (rrule: string) => void;
}) {
  const [rrule, setRrule] = useState(first.rrule ?? '');
  return (
    <Modal onClose={onClose} title="Change repeat" className="w-[460px]">
      <div className="px-6 pt-1 pb-5 space-y-4">
        <p className={`text-[13px] text-center ${MUTED}`}>
          {count === 1 ? `For “${first.title}”.` : `For ${count} series; each keeps its own start date.`}
        </p>
        <RepeatControl rrule={rrule} startDate={localDay(new Date(first.event_date))} onChange={setRrule} />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="g-btn g-btn-ghost g-btn-sm">
            Cancel
          </button>
          <button type="button" onClick={() => onApply(rrule)} className="g-btn g-btn-pri g-btn-sm">
            Change repeat
          </button>
        </div>
      </div>
    </Modal>
  );
}

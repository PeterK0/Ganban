import { useState, useEffect, useRef, useCallback, useMemo, type MouseEvent as ReactMouseEvent } from 'react';
import { confirmDialog } from '../lib/confirm';
import { canExpand, describeRrule, isoWeek, monthGridRange, seriesOccurrences, weekStart } from '../lib/recur.pure';
import { applyToDays, occurrenceKey, type PickedDay } from '../lib/eventSeries';
import { askSeriesScope } from './SeriesScopeDialog';
import RepeatingView from './RepeatingView';
import ScrollArea from './ScrollArea';
import { useDataPulse } from '../lib/livePulse';
import { getEvents, createEvent, getProjectEvents, linkEventToProject, getTaskLinkedEventIds } from '../lib/api';
import { copyEvent, getEventClipboard, localDay, movedEventDate, setEventClipboard, shortDay, singleDayOf } from '../lib/eventCopy';
import { hasDaemon, listCalendarSubscriptions } from '../lib/daemon';
import { useAppStore } from '../store/appStore';
import type { Event, CreateEventInput } from '../types';
import EventCard, { SelectCheck } from './EventCard';
import MultiSelectDropdown from './MultiSelectDropdown';
import DetailPane, { useDetailStack } from './DetailPane';
import CalendarSubscriptionsModal from './CalendarSubscriptionsModal';
import { ResizablePane } from './gilt';
import { projectColorClass } from '../lib/projectColor';
import { TabIcon, type TabIconName } from './icons/TabIcon';

const MUTED = 'text-[color:var(--g-mut)]';
/** The month grid: a narrow week-number column, then Monday to Sunday. */
const MONTH_COLS = 'grid-cols-[1.75rem_repeat(7,minmax(0,1fr))]';
/** Event cards add columns as the window widens. */
const CARD_GRID = 'grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,300px),1fr))]';
/** Month cells: pill height + gap, and the room the day number and padding take.
 * Keep in step with the grid's gap-1.5 (6px), the cell's p-1.5 and the pill's min-h-[22px]. */
const GRID_GAP = 6;
const PILL_ROW = 24;
const CELL_CHROME = 34;
const MORE_LINE = 16;

type ViewMode = 'month' | 'week' | 'day' | 'agenda' | 'repeating';

const VIEW_TABS: { id: ViewMode; label: string; icon: TabIconName }[] = [
  { id: 'month', label: 'Month', icon: 'month' },
  { id: 'week', label: 'Week', icon: 'week' },
  { id: 'day', label: 'Day', icon: 'day' },
  { id: 'agenda', label: 'Agenda', icon: 'agenda' },
  { id: 'repeating', label: 'Repeating', icon: 'repeat' },
];

const WEEKDAY_HEADS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "3–9 Nov", or "27 Oct – 2 Nov" across months: the days of the week starting `monday`. */
const weekSpan = (monday: Date) => {
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  const mon = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short' });
  return monday.getMonth() === sunday.getMonth()
    ? `${monday.getDate()}–${sunday.getDate()} ${mon(sunday)}`
    : `${monday.getDate()} ${mon(monday)} – ${sunday.getDate()} ${mon(sunday)}`;
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

/** The copy/paste keys as this platform writes them. */
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Whether a key press belongs to a field (typing) rather than the calendar. */
const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

type AgendaFilterOption = { key: string; checked: boolean; set: (v: boolean) => void; label: string; hint: string };

/** Agenda hygiene filters as a single "Filters" dropdown (replaces a row of
 * loose checkboxes in the tab bar). Shows a count badge when any are active and
 * closes on an outside click. */
function AgendaFilters({ options }: { options: AgendaFilterOption[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const active = options.filter((o) => o.checked).length;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`g-btn g-btn-sm ${active > 0 ? 'g-btn-gilt' : 'g-btn-ghost'}`}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h18M6 12h12M10 20h4" />
        </svg>
        Filters
        {active > 0 && (
          <span className="ml-0.5 inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-gold text-mantle text-[10px] font-bold">
            {active}
          </span>
        )}
      </button>
      {open && (
        <div className="g-card absolute right-0 z-20 mt-1.5 w-72 shadow-lg p-2">
          <div className="flex items-center justify-between px-2 pt-1 pb-1.5">
            <span className={`g-deco text-[11px] font-semibold ${MUTED}`}>Hide events</span>
            {active > 0 && (
              <button
                type="button"
                onClick={() => options.forEach((o) => o.set(false))}
                className="g-lnk !text-xs !min-h-[32px]"
              >
                Clear
              </button>
            )}
          </div>
          {options.map((o) => (
            <label key={o.key} className="flex items-start gap-2.5 px-2 py-2 rounded hover:bg-gilt-b cursor-pointer">
              <input type="checkbox" checked={o.checked} onChange={(e) => o.set(e.target.checked)} className="mt-0.5 accent-[color:var(--color-primary)]" />
              <span className="flex flex-col leading-tight">
                <span className="text-sm text-text">{o.label}</span>
                <span className={`text-xs mt-0.5 ${MUTED}`}>{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export default function CalendarView({ scopeProjectId }: { scopeProjectId?: number } = {}) {
  const { projects } = useAppStore();
  const [viewMode, setViewMode] = useState<ViewMode>('month');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [events, setEvents] = useState<Event[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [filterProjectIds, setFilterProjectIds] = useState<number[]>(
    scopeProjectId != null ? [scopeProjectId] : []
  );
  const [projectEventIds, setProjectEventIds] = useState<Set<number> | null>(null);
  const [showSubs, setShowSubs] = useState(false);
  // Agenda hygiene filters: hide events with no project link, events orphaned
  // from a removed/disabled calendar, and past/over events. Each loads its
  // backing set lazily (only when the toggle is on).
  const [hideUnconnected, setHideUnconnected] = useState(false);
  const [hideProjectLinked, setHideProjectLinked] = useState(false);
  const [hideTaskLinked, setHideTaskLinked] = useState(false);
  const [hideOrphaned, setHideOrphaned] = useState(false);
  const [hidePast, setHidePast] = useState(false);
  const [linkedEventIds, setLinkedEventIds] = useState<Set<number> | null>(null);
  const [taskLinkedEventIds, setTaskLinkedEventIds] = useState<Set<number> | null>(null);
  const [enabledCalIds, setEnabledCalIds] = useState<Set<number> | null>(null);
  // Multi-select for bulk actions (cmd/ctrl = toggle one, shift = range in the
  // view's order). Each day of a series is its own pick, keyed by
  // `occurrenceKey` ("12@2026-11-03") and kept as the day's display event.
  // Empty = normal single-open behaviour.
  const [selected, setSelected] = useState<Map<string, Event>>(new Map());
  const [lastClicked, setLastClicked] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // The day a paste lands on: the last day clicked (a month cell, a week day, an
  // agenda heading or an event's day). Day view always pastes on its own day.
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const showToast = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  };
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);
  const detail = useDetailStack({
    scope: scopeProjectId != null ? 'project-calendar' : 'calendar',
    onShow: (show) => setDetailHidden(!show),
  });
  // How many event pills a month cell has room for (cells grow with the window).
  const monthGridRef = useRef<HTMLDivElement>(null);
  const [monthFit, setMonthFit] = useState(3);
  useEffect(() => {
    const el = monthGridRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const cellH = (el.clientHeight - 5 * GRID_GAP) / 6;
      // Keep a line for "+N more"; never fewer than the 3 pills it always showed.
      setMonthFit(Math.max(3, Math.floor((cellH - CELL_CHROME - MORE_LINE) / PILL_ROW)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewMode, isLoading]);
  // The right-hand detail pane is collapsible (hidden by default — the
  // calendar gets the full width until the user opens an event or toggles it).
  const [detailHidden, setDetailHidden] = useState(true);
  // What the pane shows: an event, and for a series the day it was opened on.
  const openTarget = detail.current?.kind === 'event' ? detail.current : null;
  const selectedEventId = openTarget ? openTarget.event.id : null;
  /** Whether a display event is the one open (a series opened whole lights every day). */
  const isOpenEvent = (e: Event) =>
    !!openTarget && openTarget.event.id === e.id && (!e.rrule || !openTarget.occurrence || openTarget.occurrence === localDay(new Date(e.event_date)));

  const masterOf = (e: Event) => events.find((x) => x.id === e.id) ?? e;
  // Open the stored event. A day of a series opens the series' master with that
  // day: a change then asks which days it covers.
  const openEvent = (event: Event) => {
    const master = masterOf(event);
    detail.open({ kind: 'event', event: master, occurrence: master.rrule && event !== master ? localDay(new Date(event.event_date)) : null });
    setDetailHidden(false);
  };
  /** Open a whole series (the Repeating view). */
  const openSeries = (master: Event) => {
    detail.open({ kind: 'event', event: master, occurrence: null });
    setDetailHidden(false);
  };

  const clearSelection = () => {
    setSelected(new Map());
    setLastClicked(null);
  };
  const toggleSelect = (event: Event, key = occurrenceKey(event)) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, event);
      return next;
    });
    setLastClicked(key);
  };
  // Select the contiguous range (in `ordered`) between the last click and `event`.
  const selectRange = (event: Event, ordered: Event[], keyOf = occurrenceKey) => {
    const keys = ordered.map(keyOf);
    const from = lastClicked != null ? keys.indexOf(lastClicked) : -1;
    const to = keys.indexOf(keyOf(event));
    if (from < 0 || to < 0) {
      toggleSelect(event, keyOf(event));
      return;
    }
    const [lo, hi] = from < to ? [from, to] : [to, from];
    setSelected((prev) => {
      const next = new Map(prev);
      for (let i = lo; i <= hi; i++) next.set(keys[i], ordered[i]);
      return next;
    });
    setLastClicked(keys[to]);
  };
  // A click that may carry cmd/ctrl (toggle) or shift (range); else open.
  const onEventClick = (e: ReactMouseEvent, event: Event, ordered: Event[]) => {
    setPickedDay(localDay(new Date(event.event_date)));
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      toggleSelect(event);
    } else if (e.shiftKey) {
      e.preventDefault();
      selectRange(event, ordered);
    } else {
      openEvent(event);
    }
  };
  // The checkbox: a plain click toggles; Shift-click selects a range in the
  // view's order.
  const onCheckClick = (e: ReactMouseEvent, event: Event, ordered: Event[]) => {
    if (e.shiftKey && ordered.length) selectRange(event, ordered);
    else toggleSelect(event);
  };

  // The picked days (display events), as the latest load has them, and their
  // stored events.
  const selectedEvents = () =>
    [...selected.entries()].map(([k, e]) => (viewMode === 'repeating' ? masterOf(e) : displayByKey.get(k) ?? e));
  const picks = (list: Event[]): PickedDay[] => list.map((e) => ({ master: masterOf(e), day: localDay(new Date(e.event_date)) }));

  // A day of a series copies as a single event on that day; the Repeating view
  // copies whole series.
  const clipOf = (e: Event): Event => (e.rrule && viewMode !== 'repeating' ? singleDayOf(e) : masterOf(e));
  const copySelection = () => {
    const picked = selectedEvents();
    let list = picked.map(clipOf);
    if (picked.length === 0 && openTarget) {
      const m = masterOf(openTarget.event);
      list = [m.rrule && openTarget.occurrence ? singleDayOf({ ...m, event_date: movedEventDate(m, openTarget.occurrence) }) : m];
    }
    if (list.length === 0) return;
    setEventClipboard(list);
    const what = list.every((e) => e.rrule) ? `${list.length} series` : plural(list.length, 'event');
    showToast(`${what} copied. Click a day and press ${MOD}V.`);
  };

  // Copies land on `day`, each keeping its time and length. In a project's
  // calendar they're linked to that project too, so they stay in view.
  const pasteOn = async (day: string) => {
    // The latest copy of each (it may have been edited since it was copied); a
    // copied day of a series stays a single event.
    const clip = getEventClipboard().map((c) => {
      const m = events.find((e) => e.id === c.id);
      return !m ? c : c.rrule || !m.rrule ? m : singleDayOf({ ...m, event_date: c.event_date });
    });
    if (clip.length === 0) {
      showToast(`Nothing to paste. Select events and press ${MOD}C first.`);
      return;
    }
    await makeCopies(clip, day);
  };
  const duplicateEvents = async (list: Event[]) => {
    if (list.length) await makeCopies(list, null);
  };
  const makeCopies = async (list: Event[], day: string | null) => {
    if (bulkBusy) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        list.map((e) => copyEvent(e, { day: day ?? undefined, projectId: scopeProjectId })),
      );
      const made = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const failed = results.length - made.length;
      const linkErrors = made.reduce((n, r) => n + r.linkErrors, 0);
      if (scopeProjectId != null && made.length) {
        setProjectEventIds((prev) => {
          const next = new Set(prev ?? []);
          made.forEach((r) => next.add(r.event.id));
          return next;
        });
      }
      await loadEvents();
      let msg = day
        ? `${plural(made.length, 'event')} pasted on ${shortDay(day)}`
        : `${plural(made.length, 'event')} duplicated`;
      if (failed) msg += `; ${failed} failed`;
      if (linkErrors) msg += `; ${plural(linkErrors, 'link')} not copied`;
      showToast(msg);
    } finally {
      setBulkBusy(false);
    }
  };

  /** Days of a series picked among `list` (asks which days once for all of them). */
  const seriesDays = (list: Event[]) => list.filter((e) => masterOf(e).rrule).length;

  // Mark the selection past, or upcoming again when all of it already is. Days of
  // a series ask once which days the mark covers.
  const markPast = async (list: Event[], done = !list.every((e) => e.done_at)) => {
    if (list.length === 0 || bulkBusy) return;
    setBulkBusy(true);
    try {
      const res = await applyToDays(picks(list), { done }, () =>
        askSeriesScope({ action: done ? 'past' : 'upcoming', title: list[0].title, days: seriesDays(list) }),
      );
      if (!res) return;
      await loadEvents();
      if (list.length > 1 || res.failed) showToast(`${plural(list.length, 'event')} marked ${done ? 'past' : 'upcoming'}${res.failed ? `; ${res.failed} failed` : ''}`);
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkDelete = async () => {
    const list = selectedEvents();
    if (list.length === 0 || bulkBusy) return;
    // Days of a series ask which days instead (it says what each choice removes).
    if (!seriesDays(list) && !await confirmDialog(`Move ${plural(list.length, 'event')} to the Bin? You can restore them there.`)) return;
    setBulkBusy(true);
    try {
      const res = await applyToDays(picks(list), { delete: true }, () =>
        askSeriesScope({ action: 'delete', title: list[0].title, days: seriesDays(list) }),
      );
      if (!res) return;
      clearSelection();
      if (openTarget && list.some((e) => isOpenEvent(e))) detail.close();
      await loadEvents();
    } finally {
      setBulkBusy(false);
    }
  };

  // The day a paste lands on right now.
  const pasteDay = viewMode === 'day' ? localDay(currentDate) : pickedDay;

  // ⌘/Ctrl+C copies the selection (or the open event), ⌘/Ctrl+V pastes on the
  // picked day, Esc clears the selection. Ignored while typing, while text is
  // selected (a normal copy) and under the imported-calendars modal.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (showSubs || isTyping(e.target) || e.altKey) return;
    if (document.querySelector('.g-scrim')) return;
    const key = e.key.toLowerCase();
    if (key === 'escape' && !e.metaKey && !e.ctrlKey) {
      if (selected.size > 0) {
        e.preventDefault();
        clearSelection();
      }
      return;
    }
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return;
    if (key === 'c') {
      if (window.getSelection()?.toString()) return;
      if (selected.size === 0 && selectedEventId == null) return;
      e.preventDefault();
      copySelection();
    } else if (key === 'v') {
      if (getEventClipboard().length === 0) return;
      e.preventDefault();
      if (!pasteDay) showToast(`Click a day first, then press ${MOD}V.`);
      else void pasteOn(pasteDay);
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // A picked day belongs to the period on screen.
  useEffect(() => setPickedDay(null), [currentDate, viewMode]);
  // The Repeating view picks whole series, the others days: a switch between them
  // starts a new selection.
  const pickingSeries = viewMode === 'repeating';
  useEffect(() => clearSelection(), [pickingSeries]);

  // Agenda groups months like the month view does, so prev/next & header reuse it.
  const isMonthlyRange = viewMode === 'month' || viewMode === 'agenda';

  // When embedded in a project tab, lock the filter to that project.
  useEffect(() => {
    if (scopeProjectId != null) setFilterProjectIds([scopeProjectId]);
  }, [scopeProjectId]);

  useEffect(() => {
    loadEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDate, viewMode]);

  const loadProjectEventIds = useCallback(async () => {
    if (filterProjectIds.length === 0) {
      setProjectEventIds(null);
      return;
    }
    try {
      const lists = await Promise.all(filterProjectIds.map((pid) => getProjectEvents(pid, false)));
      const ids = new Set<number>();
      for (const list of lists) for (const e of list) ids.add(e.id);
      setProjectEventIds(ids);
    } catch (error) {
      console.error('Failed to load project events:', error);
      setProjectEventIds(new Set());
    }
  }, [filterProjectIds]);

  useEffect(() => {
    void loadProjectEventIds();
  }, [loadProjectEventIds]);

  // Backing sets for the agenda hygiene filters — computed only when a toggle is
  // on. "Linked" = the union of every project's events (so anything absent is
  // unconnected); "enabled calendars" = subscriptions still present + enabled
  // (so an event whose calendar_id isn't there is orphaned).
  const loadAgendaMeta = useCallback(async () => {
    // The project-membership set backs both "Unconnected" (hide if absent) and
    // "Connected to projects" (hide if present), so load it for either.
    if (hideUnconnected || hideProjectLinked) {
      try {
        const lists = await Promise.all(projects.filter((p) => !p.archived).map((p) => getProjectEvents(p.id, false)));
        const ids = new Set<number>();
        for (const list of lists) for (const e of list) ids.add(e.id);
        setLinkedEventIds(ids);
      } catch {
        setLinkedEventIds(new Set());
      }
    } else {
      setLinkedEventIds(null);
    }
    if (hideTaskLinked) {
      try {
        setTaskLinkedEventIds(new Set(await getTaskLinkedEventIds()));
      } catch {
        setTaskLinkedEventIds(new Set());
      }
    } else {
      setTaskLinkedEventIds(null);
    }
    if (hideOrphaned) {
      try {
        const subs = await listCalendarSubscriptions();
        setEnabledCalIds(new Set(subs.filter((s) => s.enabled).map((s) => s.id)));
      } catch {
        setEnabledCalIds(new Set());
      }
    } else {
      setEnabledCalIds(null);
    }
  }, [hideUnconnected, hideProjectLinked, hideTaskLinked, hideOrphaned, projects]);

  useEffect(() => {
    void loadAgendaMeta();
  }, [loadAgendaMeta]);

  // Host pulse → refetch both the events and the project-membership filter, so a
  // teammate's new/linked event shows live in a project-scoped view too.
  // Filtered to event/project pulses — a task or comment write elsewhere no
  // longer refetches the calendar.
  useDataPulse(() => {
    void loadEvents();
    void loadProjectEventIds();
    void loadAgendaMeta();
  }, ['events', 'projects']);

  // Spinner only before the FIRST data arrives. After that, refetches (pulse,
  // period nav) swap the grid in place — blanking to "Loading…" on every
  // teammate write made the calendar unreadable.
  const loadedOnce = useRef(false);
  const failStreak = useRef(false);
  const loadSeq = useRef(0); // concurrent fetches (pulse vs period nav) resolve out of order
  const loadEvents = async () => {
    const seq = ++loadSeq.current;
    if (!loadedOnce.current) setIsLoading(true);
    try {
      const { start, end } = getDateRange();
      const allEvents = await getEvents(start, end);
      if (seq !== loadSeq.current) return; // superseded — a newer load owns the state
      setEvents(allEvents);
      loadedOnce.current = true;
      failStreak.current = false;
    } catch (error) {
      if (!failStreak.current) console.warn('Events load failing (will retry quietly):', error);
      failStreak.current = true;
    } finally {
      setIsLoading(false);
    }
  };

  const getDateRange = () => {
    const start = new Date(currentDate);
    const end = new Date(currentDate);

    if (viewMode === 'month') {
      // The whole grid, so the other months' leading and trailing days show
      // their events too.
      const { first, last } = monthGridRange(currentDate.getFullYear(), currentDate.getMonth());
      start.setTime(first.getTime());
      end.setTime(new Date(last.getFullYear(), last.getMonth(), last.getDate(), 23, 59, 59, 999).getTime());
    } else if (isMonthlyRange) {
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      end.setMonth(end.getMonth() + 1);
      end.setDate(0);
      end.setHours(23, 59, 59, 999);
    } else if (viewMode === 'week') {
      // Weeks start on Monday (ISO 8601, as the repeat rules count them).
      const monday = weekStart(start);
      start.setTime(monday.getTime());
      end.setTime(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6, 23, 59, 59, 999).getTime());
    } else if (viewMode === 'repeating') {
      // The series come whatever the window (get_events returns every master);
      // keep it to today so the one-off events stay out.
      start.setTime(new Date().setHours(0, 0, 0, 0));
      end.setTime(start.getTime());
    } else {
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
    }

    return { start: toLocalDateString(start), end: toLocalDateString(end) };
  };

  const handlePrevious = () => {
    const newDate = new Date(currentDate);
    if (isMonthlyRange) {
      newDate.setMonth(newDate.getMonth() - 1);
    } else if (viewMode === 'week') {
      newDate.setDate(newDate.getDate() - 7);
    } else {
      newDate.setDate(newDate.getDate() - 1);
    }
    setCurrentDate(newDate);
  };

  const handleNext = () => {
    const newDate = new Date(currentDate);
    if (isMonthlyRange) {
      newDate.setMonth(newDate.getMonth() + 1);
    } else if (viewMode === 'week') {
      newDate.setDate(newDate.getDate() + 7);
    } else {
      newDate.setDate(newDate.getDate() + 1);
    }
    setCurrentDate(newDate);
  };

  const handleToday = () => setCurrentDate(new Date());

  // Clicking a day (Month view) opens its overview in the right pane — events
  // on that day plus an Add button — instead of jumping straight to a create
  // prompt.
  const openDay = (date: Date) => {
    setPickedDay(toLocalDateString(date));
    detail.open({ kind: 'day', date: toLocalDateString(date), scopeProjectId: scopeProjectId ?? null });
    setDetailHidden(false);
  };

  // The explicit "Add Event" buttons (Day/Week views) create an all-day
  // placeholder for that date and open it in the editor to fill in.
  const createEventForDate = async (dateStr: string) => {
    try {
      const input: CreateEventInput = {
        title: 'New Event',
        event_date: localDateAtMidnight(dateStr).toISOString(),
        all_day: true,
        notification_enabled: false,
      };
      const newEvent = await createEvent(input);
      // In a project-scoped view, link the new event to that project so it (a)
      // actually belongs to the project and (b) passes the project filter and
      // shows immediately — no reload. Add its id to the filter set right away.
      if (scopeProjectId != null) {
        await linkEventToProject(newEvent.id, scopeProjectId);
        setProjectEventIds((prev) => {
          const next = new Set(prev ?? []);
          next.add(newEvent.id);
          return next;
        });
      }
      setEvents((prev) => [...prev, newEvent]);
      openEvent(newEvent);
    } catch (error) {
      console.error('Failed to create event:', error);
      alert(`Failed to create event: ${error}`);
    }
  };

  const getMonthCalendarDays = () => {
    const startDate = monthGridRange(currentDate.getFullYear(), currentDate.getMonth()).first;

    const days: Date[] = [];
    const current = new Date(startDate);
    for (let i = 0; i < 42; i++) {
      days.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    return days;
  };

  const getWeekDays = () => {
    const start = weekStart(currentDate);
    const days: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      days.push(day);
    }
    return days;
  };

  const passesFilter = (event: Event) => !projectEventIds || projectEventIds.has(event.id);

  // When does an event finish (for the "hide past" agenda filter)? All-day or
  // untimed → end of its day; timed → its end time. event_date is per-occurrence
  // for recurring masters (displayEvents expands them), so this is occurrence-aware.
  const eventEndsAt = (e: Event): Date => {
    const day = e.event_date.slice(0, 10);
    return e.all_day || !e.end_time ? new Date(`${day}T23:59:59`) : new Date(`${day}T${e.end_time}`);
  };

  // Agenda-only hygiene filters layered on top of the project filter.
  const agendaPasses = (e: Event): boolean => {
    if (!passesFilter(e)) return false;
    if (hideUnconnected && linkedEventIds && !linkedEventIds.has(e.id)) return false;
    if (hideProjectLinked && linkedEventIds && linkedEventIds.has(e.id)) return false;
    if (hideTaskLinked && taskLinkedEventIds && taskLinkedEventIds.has(e.id)) return false;
    if (hideOrphaned && e.calendar_id != null && !enabledCalIds?.has(e.calendar_id)) return false;
    if (hidePast && (e.done_at || eventEndsAt(e) < new Date())) return false;
    return true;
  };

  // Events to display: non-recurring as-is, plus each recurring master expanded
  // into occurrence clones (same id; date set per occurrence) within the visible
  // window. Recurring masters are fetched regardless of date (see get_events), so
  // a series that started in the past still populates this month.
  const displayEvents = useMemo(() => {
    const { start, end } = getDateRange();
    const lo = new Date(`${start}T00:00:00`);
    const hi = new Date(`${end}T23:59:59`);
    const out: Event[] = [];
    for (const e of events) {
      if (!e.rrule) {
        out.push(e);
        continue;
      }
      if (canExpand(e.rrule)) {
        for (const o of seriesOccurrences(e.rrule, new Date(e.event_date), e.exdates, lo, hi)) out.push({ ...e, event_date: o.toISOString() });
      } else {
        // A rule we can't expand: fall back to the master if its own date lands
        // in the window.
        const md = new Date(e.event_date);
        if (md >= lo && md <= hi) out.push(e);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, currentDate, viewMode, isMonthlyRange]);

  const displayByKey = useMemo(() => new Map(displayEvents.map((e) => [occurrenceKey(e), e])), [displayEvents]);

  // The period's days in date order (a day's events as its cell lists them): the
  // order a Shift-click range runs in, in the month, week and day views.
  const periodOrder = displayEvents
    .filter(passesFilter)
    .sort((a, b) => toLocalDateString(new Date(a.event_date)).localeCompare(toLocalDateString(new Date(b.event_date))));

  const getEventsForDate = (date: Date) => {
    const dateStr = toLocalDateString(date);
    return displayEvents.filter((event) => toLocalDateString(new Date(event.event_date)) === dateStr && passesFilter(event));
  };

  // Agenda: filtered events grouped by day, days ascending, timed events first.
  const getAgendaGroups = () => {
    const map = new Map<string, Event[]>();
    for (const e of displayEvents) {
      if (!agendaPasses(e)) continue;
      const key = toLocalDateString(new Date(e.event_date));
      const arr = map.get(key);
      if (arr) arr.push(e);
      else map.set(key, [e]);
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, evs]) => ({
        day,
        events: evs.sort((x, y) => Number(x.all_day) - Number(y.all_day) || (x.start_time || '').localeCompare(y.start_time || '')),
      }));
  };

  const isToday = (date: Date) => {
    const today = new Date();
    return (
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    );
  };

  const isCurrentMonth = (date: Date) => date.getMonth() === currentDate.getMonth();

  const formatHeader = () => {
    if (viewMode === 'repeating') return 'Repeating events';
    if (isMonthlyRange) {
      return currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    } else if (viewMode === 'week') {
      const start = weekStart(currentDate);
      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      return `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
    } else {
      return currentDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }
  };

  // Gilt: events wear their project's gem colour where the project is known
  // (a project's own calendar, or a filter on exactly one project); gold
  // otherwise, since an event carries no project of its own.
  const gemProjectId = scopeProjectId ?? (filterProjectIds.length === 1 ? filterProjectIds[0] : null);
  const gemProject = gemProjectId != null ? projects.find((p) => p.id === gemProjectId) : undefined;
  const gemClass = gemProject ? projectColorClass(gemProject) : '';

  return (
    <div className="flex h-full flex-1 min-w-0">
      <div className="flex-1 flex flex-col bg-mantle min-w-0">
        {/* View tabs (Gilt's .ptab) + tools */}
        <nav className="flex items-center flex-wrap gap-0.5 px-4 border-b border-gilt-b bg-mantle">
          {VIEW_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setViewMode(t.id)}
              aria-current={viewMode === t.id ? 'page' : undefined}
              className={`min-h-[42px] px-4 inline-flex items-center text-sm font-medium transition-colors ${
                viewMode === t.id
                  ? 'text-gold shadow-[inset_0_-2px_0_var(--color-gold)]'
                  : 'text-[color:var(--g-fg2)] hover:text-text'
              }`}
            >
              <TabIcon name={t.icon} className="w-4 h-4 mr-2" />
              {t.label}
            </button>
          ))}
          {scopeProjectId == null && (
            <div className="ml-auto flex items-center gap-2 py-1.5">
              {hasDaemon() && (
                <button
                  onClick={() => setShowSubs(true)}
                  className="g-iconbtn"
                  title="Import & sync external calendars (ICS/webcal)"
                  aria-label="Imported calendars"
                >
                  📥
                </button>
              )}
              <MultiSelectDropdown
                className="w-40"
                label="All Projects"
                items={projects.filter((p) => !p.archived).sort((a, b) => a.name.localeCompare(b.name))}
                selectedIds={filterProjectIds}
                onChange={setFilterProjectIds}
                getDisplayName={(p) => p.name}
                emptyMessage="No projects"
              />
              <button
                onClick={() => setDetailHidden((v) => !v)}
                className="g-btn g-btn-ghost g-btn-sm"
                title={detailHidden ? 'Show the detail panel' : 'Hide the detail panel'}
              >
                {detailHidden ? (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                )}
                {detailHidden ? 'Show editor' : 'Hide editor'}
              </button>
            </div>
          )}
        </nav>

        {/* Period header + navigation */}
        <div className="flex items-end justify-between gap-4 flex-wrap px-8 pt-6 pb-4">
          <div className="min-w-0">
            <div className="g-deco text-xs text-gold">
              {VIEW_TABS.find((t) => t.id === viewMode)?.label}
              {gemProject && <> · {gemProject.name}</>}
            </div>
            <div className="flex items-baseline gap-3 flex-wrap">
              <h1 className={`g-ptitle text-text ${scopeProjectId != null ? '!text-[28px]' : ''}`}>{formatHeader()}</h1>
              {viewMode === 'week' && (
                <span className="g-deco text-[12px] text-subtext-0">Week {isoWeek(currentDate).week}</span>
              )}
            </div>
          </div>
          <div className={`flex items-center gap-1.5 ${viewMode === 'repeating' ? 'hidden' : ''}`}>
            <button onClick={handlePrevious} className="g-iconbtn" title="Previous" aria-label="Previous">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button onClick={handleToday} className="g-btn g-btn-gilt g-btn-sm">
              Today
            </button>
            <button onClick={handleNext} className="g-iconbtn" title="Next" aria-label="Next">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </div>

        {/* Bulk-selection action bar */}
        {selected.size > 0 && viewMode !== 'repeating' && (
          <div className="flex items-center flex-wrap gap-2 px-8 py-2 bg-gilt-b border-y border-gilt-a" role="toolbar" aria-label="Selected events">
            <span className="text-sm text-text font-semibold mr-1">{selected.size} selected</span>
            <button onClick={copySelection} disabled={bulkBusy} className="g-btn g-btn-gilt g-btn-sm" title={`Copy (${MOD}C), then click a day and paste (${MOD}V)`}>
              Copy
            </button>
            <button onClick={() => void duplicateEvents(selectedEvents().map(clipOf))} disabled={bulkBusy} className="g-btn g-btn-gilt g-btn-sm" title="Make copies on the same days">
              Duplicate
            </button>
            <button onClick={() => void markPast(selectedEvents())} disabled={bulkBusy} className="g-btn g-btn-gilt g-btn-sm">
              {selectedEvents().length > 0 && selectedEvents().every((e) => e.done_at) ? 'Mark as upcoming' : 'Mark as past'}
            </button>
            <button onClick={bulkDelete} disabled={bulkBusy} className="g-btn g-btn-danger g-btn-sm">
              Delete
            </button>
            <button onClick={clearSelection} className="g-lnk" title="Clear the selection (Esc)">
              Clear
            </button>
            {bulkBusy && <span className={`text-xs ${MUTED}`}>Working…</span>}
          </div>
        )}

        {/* Calendar Content */}
        <ScrollArea className="flex-1 min-h-0" contentClassName="px-8 pt-2 pb-8">
          {isLoading ? (
            <div className="flex items-center justify-center h-full">
              <p className={MUTED}>Loading events...</p>
            </div>
          ) : viewMode === 'repeating' ? (
            <RepeatingView
              series={events.filter((e) => e.rrule && passesFilter(e))}
              selected={selected}
              onCheck={onCheckClick}
              onOpen={openSeries}
              isOpen={(e) => openTarget?.event.id === e.id}
              onClear={clearSelection}
              onCopy={copySelection}
              onChanged={loadEvents}
              showToast={showToast}
            />
          ) : viewMode === 'month' ? (
            /* Month View: fills the pane; cells grow with the window */
            <div className="h-full min-h-[640px] flex flex-col">
              <div className={`grid ${MONTH_COLS} gap-1.5 mb-1.5`}>
                <span aria-hidden="true" />
                {WEEKDAY_HEADS.map((day) => (
                  <div key={day} className={`g-deco text-center text-[11px] font-semibold py-1.5 ${MUTED}`}>
                    {day}
                  </div>
                ))}
              </div>
              <div
                ref={monthGridRef}
                className={`flex-1 grid ${MONTH_COLS} gap-1.5`}
                style={{ gridTemplateRows: 'repeat(6, minmax(96px, 1fr))' }}
              >
                {getMonthCalendarDays().flatMap((date, index) => {
                  const dayEvents = getEventsForDate(date);
                  const today = isToday(date);
                  const inMonth = isCurrentMonth(date);
                  // Show as many pills as the cell has room for, then "+N more".
                  const shown = Math.min(dayEvents.length, monthFit);
                  const target = pasteDay === toLocalDateString(date);
                  const cell = (
                    <div
                      key={index}
                      onClick={() => openDay(date)}
                      className={`min-w-0 overflow-hidden p-1.5 rounded border cursor-pointer transition-colors ${
                        target
                          ? 'bg-base border-dashed !border-gold'
                          : today
                          ? 'bg-base border-gold shadow-[inset_0_0_0_1px_var(--color-gold)]'
                          : inMonth
                          ? 'bg-base border-surface-0 hover:border-gilt-a'
                          : 'bg-transparent border-transparent hover:border-surface-0'
                      }`}
                    >
                      <div className="flex items-center mb-1 px-1">
                        <span
                          className={`font-deco text-[15px] leading-none pt-[3px] tabular-nums ${
                            today ? 'text-gold font-bold' : inMonth ? 'text-[color:var(--g-fg2)]' : 'text-overlay-0'
                          }`}
                        >
                          {date.getDate()}
                        </span>
                        {target && getEventClipboard().length > 0 && (
                          <span className={`ml-auto text-[10px] ${MUTED}`}>{MOD}V pastes here</span>
                        )}
                      </div>
                      <div className="space-y-0.5">
                        {dayEvents.slice(0, shown).map((event) => {
                          const ticked = selected.has(occurrenceKey(event));
                          const on = ticked || isOpenEvent(event);
                          return (
                            <div
                              key={`${event.id}-${event.event_date}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                // ⌘/Ctrl-click toggles, Shift-click picks a range (in
                                // date order); a plain click opens.
                                onEventClick(e, event, periodOrder);
                              }}
                              title={event.done_at ? `${event.title} (done)` : event.title}
                              className={`group flex items-center gap-1.5 min-h-[22px] px-1.5 rounded text-xs transition-colors ${gemClass} ${
                                on
                                  ? 'g-on'
                                  : 'text-text hover:bg-surface-0'
                              } ${event.done_at ? 'opacity-60 line-through' : ''}`}
                            >
                              {selected.size > 0 ? (
                                <SelectCheck on={ticked} onToggle={(e) => onCheckClick(e, event, periodOrder)} className="!w-3.5 !h-3.5" />
                              ) : (
                                <span className="relative shrink-0 w-3.5 h-3.5 flex items-center justify-center">
                                  <span className="g-gem !w-1.5 !h-1.5 group-hover:opacity-0" aria-hidden="true" />
                                  <SelectCheck on={false} onToggle={(e) => onCheckClick(e, event, periodOrder)} className="!absolute inset-0 !w-3.5 !h-3.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
                                </span>
                              )}
                              <span className="truncate min-w-0">
                                {event.calendar_id != null && <span className="mr-0.5">📥</span>}
                                {!event.all_day && event.start_time && (
                                  <span className={`tabular-nums mr-1 ${on ? '' : MUTED}`}>{event.start_time}</span>
                                )}
                                {event.title}
                              </span>
                            </div>
                          );
                        })}
                        {dayEvents.length > shown && (
                          <div className={`text-xs px-1.5 ${MUTED}`}>+{dayEvents.length - shown} more</div>
                        )}
                      </div>
                    </div>
                  );
                  // Each row starts with its ISO week number.
                  if (index % 7 !== 0) return [cell];
                  return [
                    <div
                      key={`w${index}`}
                      className="g-deco text-[10px] text-subtext-0 pt-2 text-center tabular-nums select-none"
                      title={`Week ${isoWeek(date).week}`}
                    >
                      W{isoWeek(date).week}
                    </div>,
                    cell,
                  ];
                })}
              </div>
            </div>
          ) : viewMode === 'week' ? (
            /* Week View */
            <div className="space-y-4">
              {getWeekDays().map((date) => {
                const dayEvents = getEventsForDate(date);
                const today = isToday(date);
                const day = toLocalDateString(date);
                const target = pasteDay === day;
                return (
                  <section
                    key={date.toISOString()}
                    onClick={() => setPickedDay(day)}
                    className={`g-card px-5 py-4 ${target ? 'border-dashed !border-gold' : today ? '!border-gold' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <h3 className={`g-deco text-[13px] font-semibold ${today ? 'text-gold' : 'text-text'}`}>
                        {date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                        {target && getEventClipboard().length > 0 && (
                          <span className={`ml-3 normal-case tracking-normal font-normal text-xs ${MUTED}`}>{MOD}V pastes here</span>
                        )}
                      </h3>
                      <button
                        onClick={() => createEventForDate(toLocalDateString(date))}
                        className="g-btn g-btn-gilt g-btn-sm"
                      >
                        Add Event
                      </button>
                    </div>
                    {dayEvents.length > 0 ? (
                      <div className={CARD_GRID}>
                        {dayEvents.map((event) => (
                          <EventCard
                            key={`${event.id}-${event.event_date}`}
                            event={event}
                            gemClass={gemClass}
                            onClick={() => openEvent(event)}
                            isSelected={isOpenEvent(event)}
                            onChanged={() => void loadEvents()}
                            onToggleDone={(done) => markPast([event], done)}
                            onDuplicate={() => void duplicateEvents([clipOf(event)])}
                            select={{ on: selected.has(occurrenceKey(event)), any: selected.size > 0, onToggle: (e) => onCheckClick(e, event, periodOrder) }}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className={`text-sm ${MUTED}`}>No events</p>
                    )}
                  </section>
                );
              })}
            </div>
          ) : viewMode === 'day' ? (
            /* Day View */
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <h2 className="g-deco text-[13px] font-semibold text-gold">
                  {currentDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                </h2>
                <button
                  onClick={() => createEventForDate(toLocalDateString(currentDate))}
                  className="g-btn g-btn-pri g-glint"
                >
                  Add Event
                </button>
              </div>
              {getEventsForDate(currentDate).length > 0 ? (
                <div className={CARD_GRID}>
                  {getEventsForDate(currentDate).map((event) => (
                    <EventCard
                      key={`${event.id}-${event.event_date}`}
                      event={event}
                      gemClass={gemClass}
                      onClick={() => openEvent(event)}
                      isSelected={isOpenEvent(event)}
                      onChanged={() => void loadEvents()}
                      onToggleDone={(done) => markPast([event], done)}
                      onDuplicate={() => void duplicateEvents([clipOf(event)])}
                      select={{ on: selected.has(occurrenceKey(event)), any: selected.size > 0, onToggle: (e) => onCheckClick(e, event, periodOrder) }}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-64 text-center">
                  <svg className="w-14 h-14 text-gilt-a mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                    />
                  </svg>
                  <p className="g-deco text-[15px] text-text mb-2">No Events Today</p>
                  <p className={MUTED}>Click "Add Event" to create one</p>
                </div>
              )}
            </div>
          ) : (
            /* Agenda View — events grouped by day */
            (() => {
              const groups = getAgendaGroups();
              // Ranges run in the list's order, a day of a series at a time.
              const ordered = groups.flatMap((g) => g.events);
              const filterOptions = [
                { key: 'unconnected', checked: hideUnconnected, set: setHideUnconnected, label: 'Unconnected', hint: 'Not linked to any project' },
                { key: 'project-linked', checked: hideProjectLinked, set: setHideProjectLinked, label: 'Connected to projects', hint: 'Linked to at least one project' },
                { key: 'task-linked', checked: hideTaskLinked, set: setHideTaskLinked, label: 'Connected to tasks', hint: 'Linked to at least one task' },
                { key: 'orphaned', checked: hideOrphaned, set: setHideOrphaned, label: 'Orphaned', hint: 'From a removed/disabled calendar' },
                { key: 'past', checked: hidePast, set: setHidePast, label: 'Past', hint: 'Already finished' },
              ];
              const anyFilter = filterOptions.some((o) => o.checked);
              return (
                <div className="space-y-5">
                  <div className="flex items-center justify-between gap-3">
                    <p className={`text-xs ${MUTED}`}>
                      Tick events to act on them (Shift-click for a range). {MOD}C copies them; click a day and {MOD}V pastes.
                    </p>
                    <AgendaFilters options={filterOptions} />
                  </div>
                  {groups.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-56 text-center">
                      <p className="g-deco text-[15px] text-text mb-2">No events this month</p>
                      <p className={MUTED}>
                        {anyFilter ? 'Try clearing the filters, or switch months.' : 'Switch months or add an event from another view.'}
                      </p>
                    </div>
                  ) : (
                  /* One list, top to bottom: a heading per day, then its events by time. */
                  <div className="space-y-6">
                  {groups.map(({ day, events: dayEvents }, gi) => {
                    const d = localDateAtMidnight(day);
                    const today = isToday(d);
                    const target = pasteDay === day;
                    // A quiet divider where a new ISO week starts.
                    const monday = weekStart(d);
                    const newWeek = gi === 0 || weekStart(localDateAtMidnight(groups[gi - 1].day)).getTime() !== monday.getTime();
                    return (
                      <div key={day} className="space-y-3">
                      {newWeek && (
                        <div className="flex items-center gap-3 px-2 pt-1 text-subtext-0" role="separator" aria-label={`Week ${isoWeek(d).week}`}>
                          <span className="g-deco text-[10px] whitespace-nowrap">Week {isoWeek(d).week} · {weekSpan(monday)}</span>
                          <span className="flex-1 border-t border-gilt-b" aria-hidden="true" />
                        </div>
                      )}
                      <section onClick={() => setPickedDay(day)} aria-label={d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}>
                        <h3
                          className={`flex items-baseline gap-3 px-2 pb-2 mb-1 border-b ${target ? 'border-dashed border-gold' : 'border-gilt-a'}`}
                        >
                          <span className={`font-deco text-[24px] leading-none tabular-nums ${today ? 'text-gold' : 'text-text'}`}>{d.getDate()}</span>
                          <span className={`g-deco text-[12px] ${today ? 'text-gold' : 'text-[color:var(--g-fg2)]'}`}>
                            {d.toLocaleDateString('en-US', { weekday: 'long' })} · {d.toLocaleDateString('en-US', { month: 'short' })}
                          </span>
                          {today && <span className="g-tag text-gold">Today</span>}
                          <span className={`ml-auto text-xs font-normal ${MUTED}`}>
                            {target && getEventClipboard().length > 0 && `${MOD}V pastes here · `}
                            {plural(dayEvents.length, 'event')}
                          </span>
                        </h3>
                        <ul>
                          {dayEvents.map((event) => {
                            const picked = selected.has(occurrenceKey(event));
                            return (
                              <li
                                key={`${event.id}-${event.event_date}`}
                                className={`group flex items-center gap-3 min-h-[44px] pl-2 rounded transition-colors ${gemClass} ${
                                  picked
                                    ? 'g-sel'
                                    : isOpenEvent(event)
                                    ? 'bg-surface-0 shadow-[inset_2px_0_0_var(--color-gold)]'
                                    : 'hover:bg-surface-0'
                                }`}
                              >
                                <SelectCheck on={picked} onToggle={(e) => onCheckClick(e, event, ordered)} />
                                <button
                                  type="button"
                                  onClick={(e) => onEventClick(e, event, ordered)}
                                  className="flex-1 min-w-0 self-stretch flex items-center gap-3 pr-2 text-left"
                                >
                                  <span className={`shrink-0 text-xs tabular-nums w-24 ${MUTED}`}>
                                    {event.all_day ? 'All day' : event.start_time ? `${event.start_time}${event.end_time ? `–${event.end_time}` : ''}` : '—'}
                                  </span>
                                  <span className="g-gem !w-1.5 !h-1.5" aria-hidden="true" />
                                  {event.calendar_id != null && (
                                    <span className="shrink-0 text-xs" title="Imported calendar">📥</span>
                                  )}
                                  <span className={`flex-1 min-w-0 text-sm text-text truncate ${event.done_at ? 'line-through opacity-60' : ''}`}>{event.title}</span>
                                  {event.location && (
                                    <span className={`hidden lg:block shrink min-w-0 max-w-[30%] text-xs truncate ${MUTED}`}>{event.location}</span>
                                  )}
                                  {event.rrule && (
                                    <span className={`shrink-0 text-xs ${MUTED}`} title={describeRrule(event.rrule)} aria-label={describeRrule(event.rrule)}>↻</span>
                                  )}
                                  {event.done_at && <span className="g-tag g-tag-ok shrink-0">Done</span>}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                      </div>
                    );
                  })}
                  </div>
                  )}
                </div>
              );
            })()
          )}
        </ScrollArea>
      </div>

      {/* Right panel — navigable detail. Collapsible: hidden by default;
          ✕ hides it, the toolbar toggle reopens it. Clicking an event/day
          un-hides it. */}
      <ResizablePane
        id="side-pane"
        side="right"
        min={340}
        max={900}
        defaultWidth={420}
        collapsible
        collapsed={detailHidden}
        className="border-l border-surface-2 bg-surface-0"
      >
        <DetailPane
          controller={detail}
          onChanged={loadEvents}
          onClose={() => setDetailHidden(true)}
          emptyHint="Select an event to view it here. Its linked tasks open in place — use the ‹ › buttons to go back."
        />
      </ResizablePane>

      {toast && (
        <div role="status" className="g-card fixed bottom-6 left-1/2 -translate-x-1/2 z-40 px-4 py-2.5 text-sm text-text shadow-lg">
          {toast}
        </div>
      )}

      {/* Imported-calendars manager */}
      {showSubs && <CalendarSubscriptionsModal onClose={() => setShowSubs(false)} onChanged={loadEvents} />}
    </div>
  );
}

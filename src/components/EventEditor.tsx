import { useState, useEffect, useRef } from 'react';
import {
  updateEvent as updateEventApi,
} from '../lib/api';
import RepeatControl from './RepeatControl';
import {
  deleteEvent,
  getEventTasks,
  linkEventToTask,
  unlinkEventFromTask,
  getEventProjects,
  linkEventToProject,
  unlinkEventFromProject,
  getTasks,
  setEventDone,
  getEvent,
} from '../lib/api';
import { onBeforeRestart } from '../lib/restartFlush';
import { inflightSaves } from '../lib/inflightSaves';
import { isUnloading } from '../lib/daemon';
import { copyEvent, movedEventDate, singleDayOf } from '../lib/eventCopy';
import { deleteDays, detachDay, markDays, splitAt, type SeriesScope } from '../lib/eventSeries';
import { parseExdates } from '../lib/recur.pure';
import { askSeriesScope } from './SeriesScopeDialog';
import { useAppStore } from '../store/appStore';
import type { CreateEventInput, Event, UpdateEventInput, Task, Project } from '../types';
import MarkdownPreview from './MarkdownPreview';
import MultiSelectDropdown from './MultiSelectDropdown';
import EventFiles from './EventFiles';
import { projectColorClass } from '../lib/projectColor';


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

/** The editor's fields. */
interface Form {
  title: string;
  description: string;
  location: string;
  eventDate: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  reminderMinutes: number | '';
  notificationEnabled: boolean;
  rrule: string;
}
const EMPTY_FORM: Form = {
  title: '', description: '', location: '', eventDate: '', startTime: '', endTime: '',
  allDay: false, reminderMinutes: '', notificationEnabled: false, rrule: '',
};
const formOf = (e: Event): Form => ({
  title: e.title,
  description: e.description || '',
  location: e.location || '',
  eventDate: toLocalDateString(new Date(e.event_date)),
  startTime: e.start_time || '',
  endTime: e.end_time || '',
  allDay: e.all_day,
  reminderMinutes: e.reminder_minutes ?? '',
  notificationEnabled: e.notification_enabled,
  rrule: e.rrule ?? '',
});

/** The form for one day (`occ`, YYYY-MM-DD) of a series, or for the event itself. */
const viewOf = (e: Event, occ: string | null): Form => (occ ? { ...formOf(e), eventDate: occ } : formOf(e));

/** `day` moved by as many days as `from` → `to`. */
const shiftDay = (day: string, from: string, to: string) => {
  const delta = Math.round((localDateAtMidnight(to).getTime() - localDateAtMidnight(from).getTime()) / 86400000);
  const d = localDateAtMidnight(day);
  return toLocalDateString(new Date(d.getFullYear(), d.getMonth(), d.getDate() + delta));
};

/** The form's changes against the saved event (undefined = unchanged). An
 * emptied text field sends '' so it really clears. For one day (`occ`) of a
 * series, a new date moves the whole series by as many days. */
const diffOf = (event: Event, f: Form, occ: string | null = null): UpdateEventInput => ({
  title: f.title !== event.title ? f.title : undefined,
  description: f.description !== (event.description || '') ? f.description : undefined,
  location: f.location !== (event.location || '') ? f.location : undefined,
  event_date: !f.eventDate || f.eventDate === viewOf(event, occ).eventDate
    ? undefined
    : occ
    ? movedEventDate(event, shiftDay(toLocalDateString(new Date(event.event_date)), occ, f.eventDate))
    : localDateAtMidnight(f.eventDate).toISOString(),
  start_time: f.startTime !== (event.start_time || '') ? f.startTime : undefined,
  end_time: f.endTime !== (event.end_time || '') ? f.endTime : undefined,
  all_day: f.allDay !== event.all_day ? f.allDay : undefined,
  reminder_minutes: f.reminderMinutes !== (event.reminder_minutes ?? '') && f.reminderMinutes !== ''
    ? Number(f.reminderMinutes)
    : undefined,
  notification_enabled: f.notificationEnabled !== event.notification_enabled ? f.notificationEnabled : undefined,
  // Omit when unchanged; null clears the recurrence; a string sets it.
  rrule: f.rrule !== (event.rrule ?? '') ? (f.rrule || null) : undefined,
});
/** The form as a new event's fields (a one-off day or a new series made from
 * `event`); the rule only when the form changed it. */
const changeOf = (event: Event, f: Form): Partial<CreateEventInput> => ({
  title: f.title,
  description: f.description || undefined,
  location: f.location || undefined,
  event_date: movedEventDate(event, f.eventDate),
  start_time: f.startTime || undefined,
  end_time: f.endTime || undefined,
  all_day: f.allDay,
  reminder_minutes: f.reminderMinutes === '' ? undefined : Number(f.reminderMinutes),
  notification_enabled: f.notificationEnabled,
  ...(f.rrule !== (event.rrule ?? '') ? { rrule: f.rrule || null } : {}),
});
const isDirty = (input: UpdateEventInput) => Object.values(input).some((v) => v !== undefined);
const invalid = (f: Form) => (!f.title.trim() ? 'A title is needed to save.' : !f.eventDate ? 'A date is needed to save.' : null);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** How long typing pauses before the editor saves. */
const AUTOSAVE_MS = 800;

interface EventEditorProps {
  event: Event | null;
  /** The day (YYYY-MM-DD) of a repeating `event` that was opened: changes then
   * ask "This event / This and following / All events". */
  occurrence?: string | null;
  /** The editor moved on to another event: the one-off copy or the new series a
   * change to one day made (with the day it now shows, for a series). */
  onReplaced?: (event: Event, occurrence: string | null, fromId: number) => void;
  onSave: (event: Event) => void;
  onDelete: () => void;
  /** Open a linked task in a navigable detail pane (click-through). */
  onOpenTask?: (task: Task) => void;
  /** Set to offer "Duplicate"; called with the new copy. */
  onDuplicated?: (event: Event) => void;
  /** Fill the parent (used inside DetailPane) instead of a fixed-width rail. */
  fill?: boolean;
}

export default function EventEditor({ event, occurrence = null, onReplaced, onSave, onDelete, onOpenTask, onDuplicated, fill = false }: EventEditorProps) {
  const { projects } = useAppStore();
  const [activeTab, setActiveTab] = useState<'details' | 'linked-tasks' | 'linked-projects' | 'files'>('details');
  const [fileCount, setFileCount] = useState(event?.file_count ?? 0);
  const [markingDone, setMarkingDone] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  // Tasks available to link — loaded here across the user's projects rather than
  // read from the store, which isn't populated on the Events screen.
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [form, setForm] = useState<Form>(() => (event ? viewOf(event, event.rrule ? occurrence : null) : EMPTY_FORM));
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const { title, description, location, eventDate, startTime, endTime, allDay, reminderMinutes, notificationEnabled, rrule } = form;
  const [linkedTasks, setLinkedTasks] = useState<Task[]>([]);
  const [linkedProjects, setLinkedProjects] = useState<Project[]>([]);

  // ---- Auto-save --------------------------------------------------------
  // Edits save on their own after a pause, and on switch, close or restart
  // (as in TaskEditor). `base` is the event as last saved; saves run one at a
  // time and diff against it, so a save never sends a stale field.
  const baseRef = useRef<Event | null>(null);
  const formRef = useRef(form);
  formRef.current = form;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onReplacedRef = useRef(onReplaced);
  onReplacedRef.current = onReplaced;
  // One day of a series: the day being edited (null for a whole event), the
  // answer to "which days?" for this editing session, and the question while it's up.
  const occRef = useRef<string | null>(event?.rrule ? occurrence : null);
  const scopeRef = useRef<SeriesScope | null>(null);
  const askingRef = useRef<Promise<SeriesScope | null> | null>(null);
  const [seriesTitle, setSeriesTitle] = useState<string | null>(null);

  /** The editor now edits `e` (a one-off copy or a new series a change made). */
  const adopt = (e: Event, occ: string | null) => {
    const old = baseRef.current;
    const fromId = old?.id ?? e.id;
    // The form follows the new event where it still shows the old one's values
    // (a one-off day has no rule; a new series may count differently).
    if (old) {
      const before = viewOf(old, occRef.current);
      const after = viewOf(e, e.rrule ? occ : null);
      const next = { ...formRef.current };
      for (const k of Object.keys(after) as (keyof Form)[]) {
        if (next[k] === before[k]) (next as Record<keyof Form, unknown>)[k] = after[k];
      }
      formRef.current = next;
      setForm(next);
    }
    baseRef.current = e;
    occRef.current = e.rrule ? occ : null;
    onReplacedRef.current?.(e, occRef.current, fromId);
    onSaveRef.current(e);
    void loadLinks(e.id);
  };

  /** Ask once per editing session which days an edit covers. Cancel puts the
   * form back. */
  const askScope = (): Promise<SeriesScope | null> => {
    if (scopeRef.current) return Promise.resolve(scopeRef.current);
    const base = baseRef.current;
    if (!askingRef.current && base) {
      askingRef.current = askSeriesScope({ action: 'edit', title: base.title }).then((s) => {
        askingRef.current = null;
        if (s && baseRef.current?.id === base.id) scopeRef.current = s;
        if (!s && baseRef.current?.id === base.id) {
          setForm(viewOf(base, occRef.current));
          setSaveState('idle');
          setSaveError(null);
        }
        return s;
      });
    }
    return askingRef.current ?? Promise.resolve(null);
  };
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  // Updates on their way, sent again as keepalive if the page goes before they land.
  const inflightRef = useRef(inflightSaves());
  const [saveState, setSaveState] = useState<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  /** Save `f` onto `base`'s event (queued behind any save in flight).
   * `lenient` (on close or switch, where nobody can fix the form any more)
   * saves the other edits and leaves an emptied title or date as it was. */
  const persist = (base: Event, f: Form, lenient = false): Promise<Event> => {
    const occAtCall = baseRef.current?.id === base.id ? occRef.current : null;
    const scopeAtCall = baseRef.current?.id === base.id ? scopeRef.current : null;
    const run = chain.current.then(async () => {
      const current = baseRef.current?.id === base.id;
      const latest = current ? baseRef.current! : base;
      const occ = latest.rrule && current ? occRef.current : latest.rrule ? occAtCall : null;
      const input = diffOf(latest, f, occ);
      if (lenient) {
        if (!f.title.trim()) input.title = undefined;
        if (!f.eventDate) input.event_date = undefined;
      }
      if (!isDirty(input)) return latest;
      const why = lenient ? null : invalid(f);
      if (why) throw new Error(why);
      if (occ) {
        // One day of a series: which days the edit covers, asked once.
        let scope = current ? scopeRef.current : scopeAtCall;
        if (!scope) {
          if (lenient || !current) return latest; // nobody left to ask: the edit is dropped
          scope = await askScope();
          if (!scope) return latest;
        }
        if (scope === 'this') {
          const copy = await detachDay(latest, occ, changeOf(latest, f));
          if (baseRef.current?.id === base.id) adopt(copy, null);
          else onSaveRef.current(copy);
          return copy;
        }
        if (scope === 'following') {
          const series = await splitAt(latest, occ, changeOf(latest, f));
          if (series) {
            if (baseRef.current?.id === base.id) {
              scopeRef.current = 'all'; // the new series is "this and following" now
              adopt(series, f.eventDate);
            } else onSaveRef.current(series);
            return series;
          }
          // Nothing comes before this day: the whole series it is.
        }
      }
      if (occ && input.event_date && latest.exdates) {
        // The whole series moves: its skipped days move with it.
        input.exdates = parseExdates(latest.exdates).map((d) => shiftDay(d, occ, f.eventDate)).join(',') || null;
      }
      const updated = await inflightRef.current.track(() => updateEventApi(base.id, input));
      if (baseRef.current?.id === base.id) {
        baseRef.current = updated;
        if (occ && input.event_date) {
          occRef.current = f.eventDate;
          onReplacedRef.current?.(updated, f.eventDate, updated.id);
        }
      }
      onSaveRef.current(updated);
      return updated;
    });
    chain.current = run.catch(() => undefined);
    return run;
  };

  /** Save the open event now; errors show inline and the edits stay. */
  const saveNow = async (): Promise<boolean> => {
    const base = baseRef.current;
    if (!base) return false;
    setSaveState('saving');
    setSaveError(null);
    try {
      await persist(base, formRef.current);
      if (!baseRef.current) return true;
      setSaveState(isDirty(diffOf(baseRef.current, formRef.current, occRef.current)) ? 'pending' : 'saved');
      return true;
    } catch (e) {
      if (baseRef.current?.id === base.id) {
        setSaveState('error');
        setSaveError(errText(e));
      }
      return false;
    }
  };

  // A pause in typing saves.
  useEffect(() => {
    const base = baseRef.current;
    if (!event || !base || base.id !== event.id) return;
    if (!isDirty(diffOf(base, form, occRef.current))) return;
    // The first edit to one day of a series asks which days it covers.
    const why = invalid(form);
    if (occRef.current && !scopeRef.current && !why) void askScope();
    setSaveState('pending');
    // An emptied title or date says so after the pause, not mid-typing.
    const t = window.setTimeout(() => {
      if (why) {
        setSaveState('error');
        setSaveError(why);
      } else void saveNow();
    }, AUTOSAVE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  // Closing the editor (or the app restarting into an update) saves what's open.
  useEffect(() => {
    const flush = async () => {
      // The page is going away: an update still in flight would be cut off,
      // and this save queues behind it, so the update goes out again (as
      // keepalive) now. Days split off a series aren't re-sent: not idempotent.
      const again = isUnloading() ? inflightRef.current.resend() : null;
      try {
        const base = baseRef.current;
        if (base) await persist(base, formRef.current, true);
      } finally {
        await again;
      }
    };
    const offRestart = onBeforeRestart(flush);
    return () => {
      offRestart();
      flush().catch((e) => {
        console.warn('Event auto-save on close failed:', e);
        alert(`Couldn't save your changes to the event: ${errText(e)}`);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const prev = baseRef.current;
    if (!event) {
      if (prev) {
        const f = formRef.current;
        persist(prev, f, true).catch((e) => alert(`Couldn't save your changes to "${f.title || prev.title}": ${errText(e)}`));
      }
      baseRef.current = null;
      occRef.current = null;
      setForm(EMPTY_FORM);
      setLinkedTasks([]);
      setLinkedProjects([]);
      return;
    }
    const occ = event.rrule ? occurrence : null;
    // The same event on the same day (another day of a series is a switch).
    if (prev && prev.id === event.id && occ === occRef.current) {
      // An older copy (a reload that raced our save) changes nothing.
      if (new Date(event.updated_at).getTime() < new Date(prev.updated_at).getTime()) return;
      // The same event, saved or refreshed: take its new values, but keep any
      // field edited since (a save in flight mustn't eat fresh typing).
      const before = viewOf(prev, occ);
      const after = viewOf(event, occ);
      setForm((f) => {
        const next = { ...f };
        for (const k of Object.keys(after) as (keyof Form)[]) {
          if (f[k] === before[k]) (next as Record<keyof Form, unknown>)[k] = after[k];
        }
        return next;
      });
      baseRef.current = event;
      setFileCount(event.file_count ?? 0);
      return;
    }
    // Switching events: save the previous one's edits first.
    if (prev) {
      const f = formRef.current;
      persist(prev, f, true).catch((e) => alert(`Couldn't save your changes to "${f.title || prev.title}": ${errText(e)}`));
    }
    baseRef.current = event;
    occRef.current = occ;
    scopeRef.current = null;
    setForm(viewOf(event, occ));
    setSaveState('idle');
    setSaveError(null);
    setFileCount(event.file_count ?? 0);
    void loadLinks(event.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, occurrence]);

  // A one-off day of a series names the series it came from.
  const seriesId = event?.series_id ?? null;
  useEffect(() => {
    setSeriesTitle(null);
    if (seriesId == null) return;
    let live = true;
    getEvent(seriesId)
      .then((m) => live && setSeriesTitle(m?.title ?? null))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [seriesId]);

  // Load linkable tasks across the user's (non-archived) projects so the picker
  // is populated regardless of which screen opened the editor.
  useEffect(() => {
    let cancelled = false;
    const active = projects.filter((p) => !p.archived);
    Promise.all(active.map((p) => getTasks(p.id, false).catch(() => [] as Task[]))).then((arrs) => {
      if (!cancelled) setAllTasks(arrs.flat());
    });
    return () => {
      cancelled = true;
    };
  }, [projects]);

  const loadLinkedTasks = async (id = baseRef.current?.id ?? event?.id) => {
    if (id == null) return;
    try {
      const tasks = await getEventTasks(id);
      if (baseRef.current?.id === id) setLinkedTasks(tasks);
    } catch (error) {
      console.error('Failed to load linked tasks:', error);
    }
  };

  const loadLinkedProjects = async (id = baseRef.current?.id ?? event?.id) => {
    if (id == null) return;
    try {
      const linked = await getEventProjects(id);
      if (baseRef.current?.id === id) setLinkedProjects(linked);
    } catch (error) {
      console.error('Failed to load linked projects:', error);
    }
  };
  const loadLinks = (id: number) => Promise.all([loadLinkedTasks(id), loadLinkedProjects(id)]);

  // Mark past (or upcoming again) right away, saving any edits first.
  const handleToggleDone = async () => {
    if (!event) return;
    setMarkingDone(true);
    try {
      if (!(await saveNow())) return;
      const base = baseRef.current ?? event;
      const done = !base.done_at;
      const occ = base.rrule ? occRef.current : null;
      if (occ) {
        const scope = await askSeriesScope({ action: done ? 'past' : 'upcoming', title: base.title });
        if (!scope) return;
        const [marked] = await markDays(base, [occ], done, scope);
        if (marked.id === base.id) onSave(marked);
        else adopt(marked, scope === 'following' ? occ : null);
        return;
      }
      onSave(await setEventDone(base.id, done));
    } catch (error) {
      alert(`Couldn't mark the event: ${errText(error)}`);
    } finally {
      setMarkingDone(false);
    }
  };

  // A copy on the same day, made from the saved event (edits saved first).
  const handleDuplicate = async () => {
    if (!event || !onDuplicated) return;
    setDuplicating(true);
    try {
      if (!(await saveNow())) return;
      const base = baseRef.current ?? event;
      // One day of a series duplicates as a single event on that day.
      const occ = base.rrule ? occRef.current : null;
      const src = occ ? singleDayOf({ ...base, event_date: movedEventDate(base, occ) }) : base;
      const { event: copy, linkErrors } = await copyEvent(src);
      if (linkErrors) alert(`The copy was made, but ${linkErrors} of its links couldn't be copied.`);
      onDuplicated(copy);
    } catch (error) {
      alert(`Couldn't duplicate the event: ${errText(error)}`);
    } finally {
      setDuplicating(false);
    }
  };

  const handleDelete = async () => {
    if (!event) return;

    // Archive the event (soft delete). Edits not saved yet go with it; a save
    // already under way finishes first. One day of a series asks which days.
    // A save in flight may have moved the editor on (to a one-off day or a new series).
    await chain.current;
    const prev = baseRef.current;
    const target = prev ?? event;
    const occ = target.rrule ? occRef.current : null;
    const scope = occ ? await askSeriesScope({ action: 'delete', title: target.title }) : 'all';
    if (!scope) return;
    baseRef.current = null;
    try {
      await chain.current;
      if (occ) await deleteDays(target, [occ], scope);
      else await deleteEvent(target.id);
      onDelete();
    } catch (error) {
      baseRef.current = prev;
      console.error('Failed to archive event:', error);
      alert(`Failed to archive event: ${error}`);
    }
  };

  const handleLinkTask = async (taskId: number) => {
    if (!event) return;

    try {
      await linkEventToTask(event.id, taskId);
      await loadLinkedTasks();
    } catch (error) {
      console.error('Failed to link task:', error);
      alert(`Failed to link task: ${error}`);
    }
  };

  const handleUnlinkTask = async (taskId: number) => {
    if (!event) return;

    try {
      await unlinkEventFromTask(event.id, taskId);
      await loadLinkedTasks();
    } catch (error) {
      console.error('Failed to unlink task:', error);
      alert(`Failed to unlink task: ${error}`);
    }
  };

  const handleUnlinkProject = async (projectId: number) => {
    if (!event) return;

    try {
      await unlinkEventFromProject(event.id, projectId);
      await loadLinkedProjects();
    } catch (error) {
      console.error('Failed to unlink project:', error);
      alert(`Failed to unlink project: ${error}`);
    }
  };

  const handleProjectSelectionChange = async (newSelectedIds: number[]) => {
    if (!event) return;
    const currentIds = linkedProjects.map((p) => p.id);
    const toLink = newSelectedIds.filter((id) => !currentIds.includes(id));
    const toUnlink = currentIds.filter((id) => !newSelectedIds.includes(id));
    if (toLink.length === 0 && toUnlink.length === 0) return;
    try {
      await Promise.all([
        ...toLink.map((id) => linkEventToProject(event.id, id)),
        ...toUnlink.map((id) => unlinkEventFromProject(event.id, id)),
      ]);
      await loadLinkedProjects();
    } catch (error) {
      console.error('Failed to update project links:', error);
      alert(`Failed to update project links: ${error}`);
    }
  };

  // Fixed-width right rail by default; fills its parent inside DetailPane.
  const rootClass = fill
    ? 'bg-base flex flex-col h-full w-full'
    : 'w-96 bg-base border-l border-gilt-a flex flex-col h-full';

  if (!event) {
    return (
      <div className={fill ? 'bg-base flex items-center justify-center h-full w-full' : 'w-96 bg-base border-l border-gilt-a flex items-center justify-center'}>
        <p className="text-[color:var(--g-mut)]">Select an event to view details</p>
      </div>
    );
  }

  const availableTasks = allTasks.filter(
    (task) =>
      !task.archived &&
      !linkedTasks.some((lt) => lt.id === task.id) &&
      // An event linked to projects offers only those projects' tasks —
      // everything else is noise. With no project linked, all tasks remain.
      (linkedProjects.length === 0 || linkedProjects.some((p) => p.id === task.project_id))
  );

  return (
    <div className={rootClass}>
      {/* No title bar: the DetailPane header already shows "EVENT <title>".
          Delete ("Move to Bin") lives in the footer next to Save. */}

      {/* Imported-calendar banner — these events arrive unallocated */}
      {event.calendar_id != null && (
        <div className="px-[22px] py-2.5 bg-gilt-b border-b border-gilt-b text-xs text-[color:var(--g-fg2)] flex-shrink-0">
          📥 Imported from a calendar. Allocate it via the{' '}
          <button onClick={() => setActiveTab('linked-tasks')} className="text-gold font-semibold hover:underline">Tasks</button>{' '}
          or{' '}
          <button onClick={() => setActiveTab('linked-projects')} className="text-gold font-semibold hover:underline">Projects</button>{' '}
          tabs — those links persist, but edits to the details below are overwritten on the next sync.
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-gilt-b flex-shrink-0">
        <button
          onClick={() => setActiveTab('details')}
          className={`g-dtab flex-1 px-2 ${activeTab === 'details' ? 'g-on' : ''}`}
        >
          Details
        </button>
        <button
          onClick={() => setActiveTab('linked-tasks')}
          className={`g-dtab flex-1 px-2 ${activeTab === 'linked-tasks' ? 'g-on' : ''}`}
        >
          Tasks ({linkedTasks.length})
        </button>
        <button
          onClick={() => setActiveTab('linked-projects')}
          className={`g-dtab flex-1 px-2 ${activeTab === 'linked-projects' ? 'g-on' : ''}`}
        >
          Projects ({linkedProjects.length})
        </button>
        <button
          onClick={() => setActiveTab('files')}
          className={`g-dtab flex-1 px-2 ${activeTab === 'files' ? 'g-on' : ''}`}
        >
          Files ({fileCount})
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-[22px] pt-5 pb-7">
        {activeTab === 'details' && (
          <div className="space-y-[18px]">
            {event.series_id != null && (
              <p className="g-inset text-[13px] text-subtext-1">
                Edited occurrence of {seriesTitle ? <strong className="text-text">{seriesTitle}</strong> : 'a repeating event'}.
              </p>
            )}
            {event.rrule && occRef.current && (
              <p className="g-inset text-[13px] text-subtext-1">
                One day of a repeating event. A change asks whether it covers this day, the days from here on, or all of them.
              </p>
            )}
            {event.done_at && (
              <p className="g-inset text-[13px] text-subtext-1 flex items-center gap-2">
                <span className="g-tag g-tag-ok shrink-0">Done</span>
                Marked past on {new Date(event.done_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                {event.rrule ? ', for the whole series.' : '.'}
              </p>
            )}
            {/* Title */}
            <div>
              <label className="g-flbl">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => set('title', e.target.value)}
                className={`g-field font-semibold`}
                placeholder="Event title..."
              />
            </div>

            {/* Date */}
            <div>
              <label className="g-flbl">Date</label>
              <input
                type="date"
                value={eventDate}
                onChange={(e) => set('eventDate', e.target.value)}
                className="g-field"
              />
            </div>

            {/* All Day Toggle */}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="all-day"
                checked={allDay}
                onChange={(e) => set('allDay', e.target.checked)}
                className="w-4 h-4 accent-[color:var(--color-primary)]"
              />
              <label htmlFor="all-day" className="text-sm text-text font-medium">
                All Day Event
              </label>
            </div>

            {/* Time Range */}
            {!allDay && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="g-flbl">Start Time</label>
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) => set('startTime', e.target.value)}
                    className="g-field"
                  />
                </div>
                <div>
                  <label className="g-flbl">End Time</label>
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) => set('endTime', e.target.value)}
                    className="g-field"
                  />
                </div>
              </div>
            )}

            {/* Location */}
            <div>
              <label className="g-flbl">Location</label>
              <input
                type="text"
                value={location}
                onChange={(e) => set('location', e.target.value)}
                className="g-field"
                placeholder="Event location..."
              />
            </div>

            {/* Description */}
            <div>
              <label className="g-flbl">Description</label>
              <textarea
                value={description}
                onChange={(e) => set('description', e.target.value)}
                rows={4}
                className={`g-field py-2.5 leading-relaxed resize-y`}
                placeholder="Event description..."
              />
              {description && (
                <div className="g-card mt-2 px-4 py-3">
                  <p className={`g-flbl !mb-2`}>Preview</p>
                  <div className="prose prose-sm prose-invert max-w-[72ch]">
                    <MarkdownPreview content={description} />
                  </div>
                </div>
              )}
            </div>

            {/* Repeats */}
            <RepeatControl rrule={rrule} startDate={eventDate} onChange={(r) => set('rrule', r)} />

            {/* Reminder */}
            <div>
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="checkbox"
                  id="notification"
                  checked={notificationEnabled}
                  onChange={(e) => set('notificationEnabled', e.target.checked)}
                  className="w-4 h-4 accent-[color:var(--color-primary)]"
                />
                <label htmlFor="notification" className="text-sm text-text font-medium">
                  Enable Reminder
                </label>
              </div>
              {notificationEnabled && (
                <div>
                  <label className="g-flbl">
                    Remind me (minutes before)
                  </label>
                  <input
                    type="number"
                    value={reminderMinutes}
                    onChange={(e) => set('reminderMinutes', e.target.value ? Number(e.target.value) : '')}
                    min="0"
                    className="g-field"
                    placeholder="15"
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'files' && <EventFiles eventId={event.id} eventTitle={event.title} onCount={setFileCount} />}

        {activeTab === 'linked-tasks' && (
          <div className="space-y-4">
            {/* Linked Tasks List */}
            {linkedTasks.length > 0 && (
              <div className="space-y-2">
                <h3 className="g-flbl">Linked Tasks</h3>
                {linkedTasks.map((task) => (
                  <div
                    key={task.id}
                    className="g-card px-3.5 py-3 flex items-start justify-between"
                  >
                    <button
                      onClick={() => onOpenTask?.(task)}
                      disabled={!onOpenTask}
                      className={`flex-1 min-w-0 text-left ${onOpenTask ? 'hover:text-gold cursor-pointer' : 'cursor-default'}`}
                      title={onOpenTask ? 'Open task' : undefined}
                    >
                      <p className="text-sm text-text font-medium">{task.title}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="g-tag">{task.status}</span>
                        <span className="g-tag">{task.priority}</span>
                      </div>
                    </button>
                    <button
                      onClick={() => handleUnlinkTask(task.id)}
                      className="g-iconbtn ml-2 !w-8 !h-8 !text-error hover:!bg-error/10"
                      title="Unlink task"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add Task */}
            <div>
              <h3 className="g-flbl">Link a Task</h3>
              {availableTasks.length > 0 ? (
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {availableTasks.map((task) => (
                    <button
                      key={task.id}
                      onClick={() => handleLinkTask(task.id)}
                      className="g-plain w-full px-3.5 py-3 hover:bg-surface-0 hover:border-gilt-a transition-colors text-left"
                    >
                      <p className="text-sm text-text font-medium">{task.title}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="g-tag">{task.status}</span>
                        <span className="g-tag">{task.priority}</span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-[color:var(--g-mut)]">No available tasks to link</p>
              )}
            </div>
          </div>
        )}

        {activeTab === 'linked-projects' && (
          <div className="space-y-4">
            {/* Linked Projects List */}
            {linkedProjects.length > 0 && (
              <div className="space-y-2">
                <h3 className="g-flbl">Linked Projects</h3>
                {linkedProjects.map((project) => (
                  <div
                    key={project.id}
                    className={`g-card px-3.5 py-3 flex items-start justify-between ${projectColorClass(project)}`}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-text font-medium truncate flex items-center gap-2">
                        <span className="g-gem" aria-hidden="true" />
                        <span className="truncate">{project.name}</span>
                      </p>
                      {project.description && (
                        <p className="text-xs text-[color:var(--g-mut)] line-clamp-2 mt-1">{project.description}</p>
                      )}
                    </div>
                    <button
                      onClick={() => handleUnlinkProject(project.id)}
                      className="g-iconbtn ml-2 !w-8 !h-8 !text-error hover:!bg-error/10"
                      title="Unlink project"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add Project */}
            <div>
              <h3 className="g-flbl">Link a Project</h3>
              <MultiSelectDropdown
                label="Select projects..."
                items={projects.filter((p) => !p.archived)}
                selectedIds={linkedProjects.map((p) => p.id)}
                onChange={handleProjectSelectionChange}
                getDisplayName={(p) => p.name}
                emptyMessage="No projects available"
              />
            </div>
          </div>
        )}
      </div>

      {/* Footer: the save state (edits save on their own), then the actions. */}
      <div className="px-[22px] py-3.5 border-t border-gilt-a bg-mantle flex-shrink-0 space-y-2">
        <div className="flex items-center gap-3 min-h-[32px]" aria-live="polite">
          <span
            className={`flex-1 min-w-0 text-xs ${saveState === 'error' ? 'text-error' : saveState === 'saved' ? 'text-success' : 'text-[color:var(--g-mut)]'}`}
          >
            {saveState === 'pending' || saveState === 'saving'
              ? '◆ Saving…'
              : saveState === 'saved'
              ? '◆ Saved'
              : saveState === 'error'
              ? `Not saved: ${saveError}`
              : 'Changes save as you type.'}
          </span>
          <button
            onClick={() => void saveNow()}
            disabled={saveState === 'saving' || !title.trim() || !eventDate}
            className="g-btn g-btn-ghost g-btn-sm shrink-0"
            title="Save now"
          >
            {saveState === 'error' ? 'Retry' : 'Save'}
          </button>
        </div>
        <div className={onDuplicated ? 'grid grid-cols-2 gap-2' : ''}>
        {onDuplicated && (
          <button
            onClick={() => void handleDuplicate()}
            disabled={duplicating}
            title="Make a copy on the same day, with the same links"
            className="g-btn g-btn-gilt w-full"
          >
            {duplicating ? 'Duplicating…' : 'Duplicate'}
          </button>
        )}
        <button
          onClick={() => void handleToggleDone()}
          disabled={markingDone}
          title={event.rrule && !occRef.current ? 'Applies to the whole series' : undefined}
          className="g-btn g-btn-gilt w-full"
        >
          {markingDone ? 'Saving...' : event.done_at ? 'Mark as upcoming' : 'Mark as past'}
        </button>
        </div>
        {event.rrule && !occRef.current && (
          <p className="text-xs text-[color:var(--g-mut)] text-center">A repeating event is marked past as a whole series.</p>
        )}
        <button
          onClick={handleDelete}
          title="Restorable from the Bin"
          className="g-btn g-btn-danger w-full"
        >
          Move to Bin
        </button>
      </div>
    </div>
  );
}

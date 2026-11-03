import { useState } from "react";
import { confirmDialog } from '../../lib/confirm';
import type { CreateEventInput, Event, Project, Task } from "../../types";
import {
  archiveEvent,
  createEvent,
  deleteEvent,
  getEventProjects,
  getEventTasks,
  getEvents,
  getProjects,
  getTasks,
  linkEventToProject,
  linkEventToTask,
  unlinkEventFromProject,
  unlinkEventFromTask,
  updateEvent,
} from "../../lib/api";
import { useNav } from "../nav";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Fab,
  Field,
  ListRow,
  RefreshBtn,
  Screen,
  SectionHeader,
  Segmented,
  Sheet,
  Spinner,
  TextArea,
  TextInput,
  Toggle,
  dateInputToIso,
  errMsg,
  isoToDateInput,
  useAsync,
} from "../ui";

type ViewMode = "Day" | "Week" | "Month" | "Year";
const MODES: ViewMode[] = ["Day", "Week", "Month", "Year"];

const dayLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });

const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const endOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};
const startOfWeek = (d: Date) => {
  const x = startOfDay(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // week starts Monday
  return x;
};
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};

function periodRange(mode: ViewMode, anchor: Date): { start: Date; end: Date; label: string } {
  switch (mode) {
    case "Day":
      return {
        start: startOfDay(anchor),
        end: endOfDay(anchor),
        label: anchor.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }),
      };
    case "Week": {
      const start = startOfWeek(anchor);
      const last = addDays(start, 6);
      return {
        start,
        end: endOfDay(last),
        label: `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${last.toLocaleDateString(
          undefined,
          { month: "short", day: "numeric" }
        )}`,
      };
    }
    case "Month":
      return {
        start: new Date(anchor.getFullYear(), anchor.getMonth(), 1),
        end: endOfDay(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)),
        label: anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
      };
    case "Year":
      return {
        start: new Date(anchor.getFullYear(), 0, 1),
        end: endOfDay(new Date(anchor.getFullYear(), 11, 31)),
        label: String(anchor.getFullYear()),
      };
  }
}

function shift(anchor: Date, mode: ViewMode, dir: 1 | -1): Date {
  const x = new Date(anchor);
  if (mode === "Day") x.setDate(x.getDate() + dir);
  else if (mode === "Week") x.setDate(x.getDate() + dir * 7);
  else if (mode === "Month") x.setMonth(x.getMonth() + dir);
  else x.setFullYear(x.getFullYear() + dir);
  return x;
}

export default function CalendarScreen() {
  const nav = useNav();
  const [mode, setMode] = useState<ViewMode>("Week");
  const [anchor, setAnchor] = useState(() => new Date());
  const [creating, setCreating] = useState(false);

  const { start, end, label } = periodRange(mode, anchor);
  const startMs = start.getTime();
  const endMs = end.getTime();

  const { data, loading, error, reload } = useAsync(
    () => getEvents(new Date(startMs).toISOString(), new Date(endMs).toISOString(), false),
    [startMs, endMs]
  );

  const events = (data ?? []).slice().sort((a, b) => a.event_date.localeCompare(b.event_date));

  // Group by calendar day for an agenda view.
  const groups: { day: string; label: string; items: Event[] }[] = [];
  for (const ev of events) {
    const day = isoToDateInput(ev.event_date);
    const lastGroup = groups[groups.length - 1];
    if (lastGroup && lastGroup.day === day) lastGroup.items.push(ev);
    else groups.push({ day, label: dayLabel(ev.event_date), items: [ev] });
  }

  return (
    <Screen title="Calendar" right={<RefreshBtn onClick={reload} />}>
      <div className="p-3 pb-1 space-y-1 border-b border-gilt-a bg-crust/40">
        <Segmented options={MODES} value={mode} onChange={setMode} columns={4} />
        <div className="flex items-center justify-between">
          <button onClick={() => setAnchor(shift(anchor, mode, -1))} className="g-iconbtn w-11 h-11 text-gold text-xl active:bg-surface-0" aria-label="Previous">
            ‹
          </button>
          <button onClick={() => setAnchor(new Date())} className="g-deco min-h-[44px] px-2 text-[13px] font-semibold text-text active:opacity-60" style={{ letterSpacing: "0.14em" }} title="Jump to today">
            {label}
          </button>
          <button onClick={() => setAnchor(shift(anchor, mode, 1))} className="g-iconbtn w-11 h-11 text-gold text-xl active:bg-surface-0" aria-label="Next">
            ›
          </button>
        </div>
      </div>

      {error && <ErrorBanner message={error} onRetry={reload} />}
      {loading && !data ? (
        <Spinner />
      ) : events.length === 0 ? (
        <EmptyState text="No events in this period. Tap + to add one." />
      ) : (
        <div className="pb-24 min-[700px]:grid min-[700px]:grid-cols-2 min-[700px]:gap-x-4 min-[700px]:items-start">
          {groups.map((g) => (
            <div key={g.day} className="min-w-0">
              <SectionHeader>{g.label}</SectionHeader>
              {g.items.map((ev) => (
                <ListRow
                  key={ev.id}
                  title={ev.title}
                  subtitle={`${ev.all_day ? "All day" : ev.start_time || "—"}${ev.location ? " · " + ev.location : ""}`}
                  right={ev.notification_enabled ? <Badge className="text-info bg-info/10">🔔</Badge> : undefined}
                  onClick={() => nav.push(<EventDetailScreen event={ev} onChanged={reload} />)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      <Fab onClick={() => setCreating(true)} label="New event" />
      {creating && <EventForm onClose={() => setCreating(false)} onSaved={() => { setCreating(false); reload(); }} />}
    </Screen>
  );
}

export function EventDetailScreen({ event: initial, onChanged }: { event: Event; onChanged: () => void }) {
  const nav = useNav();
  const [event, setEvent] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [linkingTask, setLinkingTask] = useState(false);
  const [linkingProject, setLinkingProject] = useState(false);

  const { data, reload } = useAsync(
    () => Promise.all([getEventTasks(event.id), getEventProjects(event.id)]),
    [event.id]
  );
  const linkedTasks = data?.[0] ?? [];
  const linkedProjects = data?.[1] ?? [];

  return (
    <Screen
      title={event.title}
      onBack={nav.pop}
      subtitle={dayLabel(event.event_date)}
      right={
        <button onClick={() => setEditing(true)} className="g-lnk min-h-[44px] px-3 text-sm">
          Edit
        </button>
      }
    >
      <div className="m-4 p-4 g-card g-corners space-y-2 text-sm">
        {!event.all_day && (event.start_time || event.end_time) && (
          <div>
            <span className="g-flbl inline mr-2">Time</span>
            {event.start_time || "?"}
            {event.end_time ? ` – ${event.end_time}` : ""}
          </div>
        )}
        {event.all_day && <div className="gm-fg2">All day</div>}
        {event.location && (
          <div>
            <span className="g-flbl inline mr-2">Location</span>
            {event.location}
          </div>
        )}
        {event.reminder_minutes != null && (
          <div>
            <span className="g-flbl inline mr-2">Reminder</span>
            {event.reminder_minutes} min before
          </div>
        )}
        {event.description && <p className="whitespace-pre-wrap pt-1 max-w-[72ch]">{event.description}</p>}
      </div>

      <SectionHeader right={<button onClick={() => setLinkingTask(true)} className="g-lnk min-h-[44px] px-2 text-sm">+ Link</button>}>
        Linked tasks
      </SectionHeader>
      {linkedTasks.length === 0 ? (
        <p className="px-4 py-2 text-sm gm-mut italic">No linked tasks</p>
      ) : (
        linkedTasks.map((t) => (
          <ListRow
            key={t.id}
            title={t.title}
            subtitle={t.status}
            deleteLabel="Unlink"
            onDelete={async () => {
              try {
                await unlinkEventFromTask(event.id, t.id);
                reload();
              } catch (e) {
                alert(errMsg(e));
              }
            }}
          />
        ))
      )}

      <SectionHeader right={<button onClick={() => setLinkingProject(true)} className="g-lnk min-h-[44px] px-2 text-sm">+ Link</button>}>
        Linked projects
      </SectionHeader>
      {linkedProjects.length === 0 ? (
        <p className="px-4 py-2 text-sm gm-mut italic">No linked projects</p>
      ) : (
        linkedProjects.map((p) => (
          <ListRow
            key={p.id}
            title={p.name}
            deleteLabel="Unlink"
            onDelete={async () => {
              try {
                await unlinkEventFromProject(event.id, p.id);
                reload();
              } catch (e) {
                alert(errMsg(e));
              }
            }}
          />
        ))
      )}

      <div className="p-4 space-y-2">
        <Button
          full
          variant="surface"
          onClick={async () => {
            try {
              await archiveEvent(event.id, true);
              onChanged();
              nav.pop();
            } catch (e) {
              alert(errMsg(e));
            }
          }}
        >
          Archive event
        </Button>
        <Button
          full
          variant="danger"
          onClick={async () => {
            if (!await confirmDialog("Move this event to the bin?")) return;
            try {
              await deleteEvent(event.id);
              onChanged();
              nav.pop();
            } catch (e) {
              alert(errMsg(e));
            }
          }}
        >
          Delete (to bin)
        </Button>
      </div>

      {editing && (
        <EventForm
          existing={event}
          onClose={() => setEditing(false)}
          onSaved={(updated) => {
            setEvent(updated);
            setEditing(false);
            onChanged();
          }}
        />
      )}
      {linkingTask && (
        <TaskPicker
          linkedIds={linkedTasks.map((t) => t.id)}
          onClose={() => setLinkingTask(false)}
          onPick={async (t) => {
            try {
              await linkEventToTask(event.id, t.id);
              setLinkingTask(false);
              reload();
            } catch (e) {
              alert(errMsg(e));
            }
          }}
        />
      )}
      {linkingProject && (
        <ProjectPicker
          linkedIds={linkedProjects.map((p) => p.id)}
          onClose={() => setLinkingProject(false)}
          onPick={async (p) => {
            try {
              await linkEventToProject(event.id, p.id);
              setLinkingProject(false);
              reload();
            } catch (e) {
              alert(errMsg(e));
            }
          }}
        />
      )}
    </Screen>
  );
}

function EventForm({
  existing,
  onClose,
  onSaved,
}: {
  existing?: Event;
  onClose: () => void;
  onSaved: (e: Event) => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [location, setLocation] = useState(existing?.location ?? "");
  const [date, setDate] = useState(existing ? isoToDateInput(existing.event_date) : "");
  const [startTime, setStartTime] = useState(existing?.start_time ?? "");
  const [endTime, setEndTime] = useState(existing?.end_time ?? "");
  const [allDay, setAllDay] = useState(existing?.all_day ?? false);
  const [reminder, setReminder] = useState(existing?.reminder_minutes != null ? String(existing.reminder_minutes) : "");
  const [notify, setNotify] = useState(existing?.notification_enabled ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!title.trim() || !date) {
      setError("Title and date are required.");
      return;
    }
    setBusy(true);
    setError(null);
    const eventDateIso = dateInputToIso(date)!;
    const reminderNum = reminder.trim() && !Number.isNaN(Number(reminder)) ? Number(reminder) : undefined;
    try {
      const saved = existing
        ? await updateEvent(existing.id, {
            title: title.trim(),
            description,
            location,
            event_date: eventDateIso,
            start_time: allDay ? undefined : startTime || undefined,
            end_time: allDay ? undefined : endTime || undefined,
            all_day: allDay,
            reminder_minutes: reminderNum,
            notification_enabled: notify,
          })
        : await createEvent({
            title: title.trim(),
            description: description || undefined,
            location: location || undefined,
            event_date: eventDateIso,
            start_time: allDay ? undefined : startTime || undefined,
            end_time: allDay ? undefined : endTime || undefined,
            all_day: allDay,
            reminder_minutes: reminderNum,
            notification_enabled: notify,
          } satisfies CreateEventInput);
      onSaved(saved);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <Sheet
      title={existing ? "Edit event" : "New event"}
      onClose={onClose}
      footer={
        <Button full onClick={save} disabled={busy || !title.trim() || !date}>
          {busy ? "Saving…" : "Save"}
        </Button>
      }
    >
      <Field label="Title">
        <TextInput value={title} onChange={setTitle} autoFocus />
      </Field>
      <Field label="Date">
        <TextInput value={date} onChange={setDate} type="date" />
      </Field>
      <Toggle label="All day" value={allDay} onChange={setAllDay} />
      {!allDay && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start">
            <TextInput value={startTime} onChange={setStartTime} type="time" />
          </Field>
          <Field label="End">
            <TextInput value={endTime} onChange={setEndTime} type="time" />
          </Field>
        </div>
      )}
      <Field label="Location">
        <TextInput value={location} onChange={setLocation} />
      </Field>
      <Field label="Description">
        <TextArea value={description} onChange={setDescription} rows={2} />
      </Field>
      <Field label="Reminder (minutes before)">
        <TextInput value={reminder} onChange={setReminder} inputMode="numeric" placeholder="e.g. 15" />
      </Field>
      <Toggle label="Notifications" value={notify} onChange={setNotify} />
      {error && <p className="text-sm text-error">{error}</p>}
    </Sheet>
  );
}

function TaskPicker({
  linkedIds,
  onClose,
  onPick,
}: {
  linkedIds: number[];
  onClose: () => void;
  onPick: (t: Task) => void;
}) {
  const { data, loading } = useAsync(async () => {
    const projects = (await getProjects()).filter((p) => !p.archived);
    const taskArrays = await Promise.all(projects.map((p) => getTasks(p.id, false)));
    return taskArrays.flat();
  }, []);
  const available = (data ?? []).filter((t) => !linkedIds.includes(t.id));
  return (
    <Sheet title="Link a task" onClose={onClose}>
      {loading && !data ? (
        <Spinner />
      ) : available.length === 0 ? (
        <p className="text-sm gm-mut italic">No tasks to link.</p>
      ) : (
        <div className="-mx-5">
          {available.map((t) => (
            <ListRow key={t.id} title={t.title} subtitle={t.status} onClick={() => onPick(t)} />
          ))}
        </div>
      )}
    </Sheet>
  );
}

function ProjectPicker({
  linkedIds,
  onClose,
  onPick,
}: {
  linkedIds: number[];
  onClose: () => void;
  onPick: (p: Project) => void;
}) {
  const { data, loading } = useAsync(() => getProjects(), []);
  const available = (data ?? []).filter((p) => !p.archived && !linkedIds.includes(p.id));
  return (
    <Sheet title="Link a project" onClose={onClose}>
      {loading && !data ? (
        <Spinner />
      ) : available.length === 0 ? (
        <p className="text-sm gm-mut italic">No projects to link.</p>
      ) : (
        <div className="-mx-5">
          {available.map((p) => (
            <ListRow key={p.id} title={p.name} subtitle={p.description || undefined} onClick={() => onPick(p)} />
          ))}
        </div>
      )}
    </Sheet>
  );
}

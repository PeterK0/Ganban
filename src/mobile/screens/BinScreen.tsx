import { type ReactNode } from "react";
import { confirmDialog } from '../../lib/confirm';
import {
  archiveProject,
  deleteProject,
  getContacts,
  getEvents,
  getProjects,
  getTasks,
  permanentlyDeleteContact,
  permanentlyDeleteEvent,
  permanentlyDeleteTask,
  restoreContact,
  restoreEvent,
  restoreTask,
} from "../../lib/api";
import { useNav } from "../nav";
import { EmptyState, ErrorBanner, RefreshBtn, Screen, SectionHeader, Spinner, errMsg, useAsync } from "../ui";

export default function BinScreen() {
  const nav = useNav();
  const { data, loading, error, reload } = useAsync(async () => {
    const allProjects = await getProjects();
    const taskArrays = await Promise.all(allProjects.map((p) => getTasks(p.id, true)));
    const tasks = taskArrays.flat();
    const events = await getEvents(undefined, undefined, true);
    const contacts = await getContacts(true);
    return { archivedProjects: allProjects.filter((p) => p.archived), tasks, events, contacts };
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      reload();
    } catch (e) {
      alert(errMsg(e));
    }
  };

  const empty =
    data &&
    data.archivedProjects.length === 0 &&
    data.tasks.length === 0 &&
    data.events.length === 0 &&
    data.contacts.length === 0;

  return (
    <Screen title="Bin" onBack={nav.pop} right={<RefreshBtn onClick={reload} />}>
      {error && <ErrorBanner message={error} onRetry={reload} />}
      {loading && !data ? (
        <Spinner />
      ) : empty ? (
        <EmptyState text="The bin is empty." />
      ) : (
        <div className="pb-8">
          {data!.archivedProjects.length > 0 && <SectionHeader>Projects</SectionHeader>}
          {data!.archivedProjects.map((p) => (
            <BinRow
              key={"p" + p.id}
              title={p.name}
              subtitle={p.description || undefined}
              onRestore={() => act(() => archiveProject(p.id, false))}
              onPurge={async () => (await confirmDialog(`Permanently delete "${p.name}"?`)) && act(() => deleteProject(p.id))}
            />
          ))}

          {data!.tasks.length > 0 && <SectionHeader>Tasks</SectionHeader>}
          {data!.tasks.map((t) => (
            <BinRow
              key={"t" + t.id}
              title={t.title}
              subtitle={t.status}
              onRestore={() => act(() => restoreTask(t.id))}
              onPurge={async () => (await confirmDialog(`Permanently delete "${t.title}"?`)) && act(() => permanentlyDeleteTask(t.id))}
            />
          ))}

          {data!.events.length > 0 && <SectionHeader>Events</SectionHeader>}
          {data!.events.map((ev) => (
            <BinRow
              key={"e" + ev.id}
              title={ev.title}
              subtitle={new Date(ev.event_date).toLocaleDateString()}
              onRestore={() => act(() => restoreEvent(ev.id))}
              onPurge={async () => (await confirmDialog(`Permanently delete "${ev.title}"?`)) && act(() => permanentlyDeleteEvent(ev.id))}
            />
          ))}

          {data!.contacts.length > 0 && <SectionHeader>Contacts</SectionHeader>}
          {data!.contacts.map((c) => (
            <BinRow
              key={"c" + c.id}
              title={c.full_name}
              subtitle={c.occupation || undefined}
              onRestore={() => act(() => restoreContact(c.id))}
              onPurge={async () => (await confirmDialog(`Permanently delete "${c.full_name}"?`)) && act(() => permanentlyDeleteContact(c.id))}
            />
          ))}
        </div>
      )}
    </Screen>
  );
}

function BinRow({
  title,
  subtitle,
  onRestore,
  onPurge,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onRestore: () => void;
  onPurge: () => void;
}) {
  return (
    <div className="flex items-center gap-2 pl-4 pr-3 py-2 min-h-[60px] border-b border-gilt-b">
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{title}</div>
        {subtitle && <div className="text-sm gm-mut truncate">{subtitle}</div>}
      </div>
      <button onClick={onRestore} className="g-btn g-btn-gilt g-btn-sm min-h-[44px] active:bg-gilt-b">
        Restore
      </button>
      <button onClick={onPurge} className="g-btn g-btn-danger g-btn-sm min-h-[44px]">
        Delete
      </button>
    </div>
  );
}

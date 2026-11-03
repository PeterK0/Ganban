import { useMemo, useState } from "react";
import Fuse from "fuse.js";
import { getEvents, getProjects, getTasks } from "../../lib/api";
import { useNav } from "../nav";
import { Badge, ListRow, Screen, SectionHeader, Spinner, priorityClasses, useAsync } from "../ui";
import ProjectDetailScreen from "./ProjectDetailScreen";
import TaskDetailScreen from "./TaskDetailScreen";
import { EventDetailScreen } from "./CalendarScreen";

export default function SearchScreen() {
  const nav = useNav();
  const [q, setQ] = useState("");
  const { data, loading, reload } = useAsync(async () => {
    const projects = (await getProjects()).filter((p) => !p.archived);
    const taskArrays = await Promise.all(projects.map((p) => getTasks(p.id, false)));
    const events = await getEvents(undefined, undefined, false);
    return { projects, tasks: taskArrays.flat(), events };
  }, []);

  const results = useMemo(() => {
    if (!q.trim() || !data) return { projects: [], tasks: [], events: [] };
    const pf = new Fuse(data.projects, { keys: ["name", "description"], threshold: 0.4 });
    const tf = new Fuse(data.tasks, { keys: ["title", "description", "prefix"], threshold: 0.4 });
    const ef = new Fuse(data.events, { keys: ["title", "description", "location"], threshold: 0.4 });
    return {
      projects: pf.search(q).map((r) => r.item).slice(0, 15),
      tasks: tf.search(q).map((r) => r.item).slice(0, 30),
      events: ef.search(q).map((r) => r.item).slice(0, 20),
    };
  }, [q, data]);

  const nothing = !results.projects.length && !results.tasks.length && !results.events.length;

  return (
    <Screen title="Search" onBack={nav.pop}>
      <div className="p-3 sticky top-0 bg-mantle border-b border-gilt-b z-10">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
          placeholder="Search projects, tasks & events…"
          className="g-field gm-field"
        />
      </div>

      {loading && !data ? (
        <Spinner />
      ) : !q.trim() ? (
        <p className="px-4 py-6 text-sm gm-mut text-center">Type to search.</p>
      ) : nothing ? (
        <p className="px-4 py-6 text-sm gm-mut text-center">No matches.</p>
      ) : (
        <div className="pb-8">
          {results.projects.length > 0 && <SectionHeader>Projects</SectionHeader>}
          {results.projects.map((p) => (
            <ListRow
              key={"p" + p.id}
              title={p.name}
              subtitle={p.description || undefined}
              onClick={() => nav.push(<ProjectDetailScreen project={p} onChanged={reload} />)}
            />
          ))}

          {results.tasks.length > 0 && <SectionHeader>Tasks</SectionHeader>}
          {results.tasks.map((t) => (
            <ListRow
              key={"t" + t.id}
              title={t.title}
              subtitle={t.status}
              right={<Badge className={priorityClasses(t.priority)}>{t.priority}</Badge>}
              onClick={() => nav.push(<TaskDetailScreen task={t} onChanged={reload} />)}
            />
          ))}

          {results.events.length > 0 && <SectionHeader>Events</SectionHeader>}
          {results.events.map((ev) => (
            <ListRow
              key={"e" + ev.id}
              title={ev.title}
              subtitle={new Date(ev.event_date).toLocaleDateString()}
              onClick={() => nav.push(<EventDetailScreen event={ev} onChanged={reload} />)}
            />
          ))}
        </div>
      )}
    </Screen>
  );
}

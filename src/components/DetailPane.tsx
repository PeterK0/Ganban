import type { Project, Task } from '../types';
import { deleteTask } from '../lib/api';
import TaskEditor from './TaskEditor';
import EventEditor from './EventEditor';
import ProjectDetailPanel from './ProjectDetailPanel';
import DayOverview from './DayOverview';
import { openTaskWindow } from '../lib/windows';
import { isTauri } from '../lib/daemon';
import { openInProjectTasks } from '../lib/gotoTask';
// Re-export the hook + types so existing imports (`from './DetailPane'`) keep
// working. The hook lives in its own module so Vite's React Fast Refresh
// doesn't reject the file (a hook exported alongside a component breaks the
// "consistent components exports" rule and forces a full reload on every HMR).
export { useDetailStack } from './useDetailStack';
export type { DetailTarget, DetailController } from './useDetailStack';
import type { DetailController } from './useDetailStack';

/** Renders the current detail target with a back/forward header. Linked items
 * inside the editors call onOpen → push onto the stack.
 *
 * `collapsible`: when true, the close (✕) button calls `onClose` instead of
 * clearing the stack — the parent hides the pane entirely (a slide-out), and
 * a reopen shows the same stack. The TaskEditor's auto-save-on-switch handles
 * persistence when navigating between tasks; an explicit close also saves. */
export default function DetailPane({
  controller,
  onChanged,
  onOpenProject,
  onClose,
  emptyHint,
  taskPage = false,
}: {
  controller: DetailController;
  onChanged?: () => void;
  onOpenProject?: (p: Project) => void;
  /** Called when the user clicks ✕ in collapsible mode. The parent hides the
   * pane; the stack is preserved so reopening shows the same target. */
  onClose?: () => void;
  emptyHint?: string;
  /** Render tasks in the full-page two-pane layout (Tasks tab only). */
  taskPage?: boolean;
}) {
  const { current, open, replace, back, close } = controller;

  if (!current) {
    return (
      <div className="h-full flex items-center justify-center bg-base text-subtext-0 text-sm p-8 text-center">
        {emptyHint ?? 'Pick something on the left to see it here.'}
      </div>
    );
  }

  const title =
    current.kind === 'task'
      ? current.task.title
      : current.kind === 'event'
      ? current.event.title
      : current.kind === 'project'
      ? current.project.name
      : new Date(`${current.date}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  const kindLabel = current.kind === 'task' ? 'Task' : current.kind === 'event' ? 'Event' : current.kind === 'project' ? 'Project' : 'Day';
  // Pop a task out into its own OS window (desktop only; not from a window
  // that's already standalone).
  const canPopOut = current.kind === 'task' && isTauri() && !new URLSearchParams(window.location.search).get('pane');
  // Keep the centred title clear of the corner's buttons (36px each).
  const actionCount = 1 + (current.kind === 'task' && !taskPage ? 1 : 0) + (canPopOut ? 1 : 0);
  const actionsInset = `${actionCount * 36 - 14}px`;

  return (
    <div className="h-full flex flex-col bg-base">
      {/* The title block: a gem and the title, centred over a gold hairline,
          with the pane's actions in its corner. Back and forward live in the
          top bar now (app history, which this pane reports to). */}
      <div className="relative shrink-0 px-[22px] pt-3.5 pb-4 text-center border-b border-gilt-a">
        <div className="absolute top-2 right-2 flex items-center gap-0.5">
          {current.kind === 'task' && !taskPage && (
            <button
              onClick={() => void openInProjectTasks(current.task)}
              title="Open in Project > Tasks"
              aria-label="Open in Project > Tasks"
              className="g-iconbtn"
            >
              <ProjectTasksIcon />
            </button>
          )}
          {canPopOut && current.kind === 'task' && (
            <button
              onClick={() => void openTaskWindow(current.task.id, current.task.project_id, current.task.title)}
              title="Open this task in a separate window"
              aria-label="Open in new window"
              className="g-iconbtn"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M14 4h6v6M20 4l-8 8M18 14v6H4V6h6" /></svg>
            </button>
          )}
          <button
            onClick={() => {
              // In collapsible mode, hide the pane (the parent controls
              // visibility); the stack is preserved so reopening shows the same
              // target. Otherwise clear the stack (the original behavior).
              if (onClose) onClose();
              else close();
            }}
            title={onClose ? 'Close (saves and hides)' : 'Close'}
            aria-label="Close"
            className="g-iconbtn"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div className="flex items-start justify-center gap-2.5" style={{ paddingInline: actionsInset }}>
          <span className="g-gem mt-[0.6em]" aria-hidden="true" title={kindLabel} />
          <span className="sr-only">{kindLabel}: </span>
          <div className="min-w-0 text-xl font-bold leading-snug text-text break-words line-clamp-3" title={title}>{title}</div>
        </div>
        {current.kind === 'task' && <TaskMarks task={current.task} />}
      </div>

      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        {current.kind === 'task' && (
          <TaskEditor
            // No key: TaskEditor resets its form on a [task?.id] change AND
            // auto-saves the *previous* task on that switch — both rely on the
            // same instance being reused, so remounting here would lose edits.
            task={current.task}
            fill
            page={taskPage}
            onSave={(t) => {
              // TaskEditor also fires onSave for the *previous* task when the
              // task prop switches — only refresh the stack entry if it's the
              // one we're showing, never overwrite the new current target.
              if (current.kind === 'task' && current.task.id === t.id) replace({ kind: 'task', task: t });
              onChanged?.();
            }}
            onDelete={async () => {
              // TaskEditor delegates deletion to the parent (unlike EventEditor).
              try {
                await deleteTask(current.task.id);
              } catch (e) {
                alert(`Failed to delete task: ${e}`);
                return;
              }
              onChanged?.();
              back();
            }}
            onOpenEvent={(event) => open({ kind: 'event', event })}
          />
        )}
        {current.kind === 'event' && (
          <EventEditor
            // No key: EventEditor resets its form on an [event] prop change.
            event={current.event}
            occurrence={current.occurrence ?? null}
            // A change to one day of a series moved the editor to a one-off copy
            // or a new series: show that here.
            onReplaced={(e, occurrence, fromId) => controller.swapEvent(fromId, e, occurrence)}
            fill
            onSave={(e) => {
              // The editor also saves after the pane has moved on (on close or
              // switch), so update the event's entries wherever they are.
              controller.refresh({ kind: 'event', event: e });
              onChanged?.();
            }}
            onDuplicated={(e) => {
              onChanged?.();
              open({ kind: 'event', event: e });
            }}
            onDelete={() => {
              // EventEditor already called deleteEvent — just clean up.
              onChanged?.();
              back();
            }}
            onOpenTask={(task) => open({ kind: 'task', task })}
          />
        )}
        {current.kind === 'project' && (
          <ProjectDetailPanel
            project={current.project}
            onOpenProject={onOpenProject}
            onOpenTask={(task) => open({ kind: 'task', task })}
          />
        )}
        {current.kind === 'day' && (
          <DayOverview
            date={current.date}
            scopeProjectId={current.scopeProjectId}
            onOpenEvent={(event, occurrence) => open({ kind: 'event', event, occurrence })}
            onChanged={onChanged}
          />
        )}
      </div>
    </div>
  );
}

/** "Open in Project > Tasks": a task list with the row in focus marked. */
export function ProjectTasksIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M9 6h11M9 12h11M9 18h11" />
      <path d="M4 5.5h1v1H4zM4 17.5h1v1H4z" />
      <path d="M3.5 10l2.5 2-2.5 2" />
    </svg>
  );
}

const STATUS_MARK: Record<string, string> = {
  'To Do': 'g-st',
  'In Progress': 'g-st g-st-progress',
  Done: 'g-st g-st-done',
  Blocked: 'g-st g-st-blocked',
};

/** The task's status, priority and deadline as Gilt tags under its title. */
function TaskMarks({ task }: { task: Task }) {
  const due = task.deadline ? new Date(task.deadline) : null;
  const late = !!due && task.status !== 'Done' && due.getTime() < new Date().setHours(0, 0, 0, 0);
  return (
    <div className="flex flex-wrap justify-center gap-1.5 mt-2.5">
      <span className="g-tag">
        <span className={STATUS_MARK[task.status] ?? 'g-st'} style={{ width: 11, height: 11 }} aria-hidden="true" />
        {task.status}
      </span>
      <span className={task.priority === 'High' ? 'g-tag g-tag-hi' : 'g-tag'}>{task.priority}</span>
      {due && (
        <span className={late ? 'g-tag g-tag-red' : 'g-tag'}>
          {late ? 'Overdue · ' : 'Due '}
          {due.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
        </span>
      )}
    </div>
  );
}

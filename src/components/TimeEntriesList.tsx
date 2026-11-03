import { useEffect, useState } from 'react';
import { deleteTimeEntry, getTimeCorrelation, type TimeCorrelation } from '../lib/api';
import type { TimeEntry } from '../types';

interface TimeEntriesListProps {
  entries: TimeEntry[];
  onEntriesChange: () => void;
  /** When given, show the project's human-vs-agent hours correlation. */
  projectId?: number;
}

function hm(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Human focus (timer) vs agent runtime (ledger), project-wide: totals plus a
 * 14-day strip of paired bars. Widths are CSS percentages (heights are the
 * WKWebView trap). */
function FocusVsAgents({ projectId }: { projectId: number }) {
  const [corr, setCorr] = useState<TimeCorrelation | null>(null);
  useEffect(() => {
    let alive = true;
    getTimeCorrelation(projectId)
      .then((c) => { if (alive) setCorr(c); })
      .catch(() => { /* host unreachable — section just doesn't render */ });
    return () => { alive = false; };
  }, [projectId]);
  if (!corr || (corr.human_seconds === 0 && corr.agent_seconds === 0)) return null;
  const max = Math.max(1, ...corr.days.map((d) => Math.max(d.human_seconds, d.agent_seconds)));
  return (
    <div className="g-inset mb-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <span className="g-flbl !mb-0">Focus vs agents · this project</span>
        <span className="text-[11px] text-subtext-0">
          <span className="text-primary">you {hm(corr.human_seconds)}</span>
          {' · '}
          <span className="text-warning">agents {hm(corr.agent_seconds)}</span>
        </span>
      </div>
      {corr.days.length > 0 && (
        <div className="space-y-1">
          {corr.days.slice(-14).map((d) => (
            <div key={d.date} className="flex items-center gap-2 text-[10px] text-subtext-0">
              <span className="w-12 shrink-0 tabular-nums">{d.date.slice(5)}</span>
              <div className="flex-1 space-y-0.5">
                <div className="h-1.5 rounded bg-primary/70" style={{ width: `${Math.max(1, (d.human_seconds / max) * 100)}%` }} title={`You: ${hm(d.human_seconds)}`} />
                <div className="h-1.5 rounded bg-warning/70" style={{ width: `${Math.max(1, (d.agent_seconds / max) * 100)}%` }} title={`Agents: ${hm(d.agent_seconds)}`} />
              </div>
              <span className="w-20 shrink-0 text-right tabular-nums">{hm(d.human_seconds)} / {hm(d.agent_seconds)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TimeEntriesList({
  entries,
  onEntriesChange,
  projectId,
}: TimeEntriesListProps) {
  const handleDelete = async (entryId: number) => {
    try {
      console.log('Deleting time entry:', entryId);
      await deleteTimeEntry(entryId);
      onEntriesChange();
      console.log('Time entry deleted successfully');
    } catch (error) {
      console.error('Failed to delete entry:', error);
      alert(`Failed to delete entry: ${error}`);
    }
  };

  const formatDuration = (seconds: number | null | undefined) => {
    if (!seconds) return 'In progress...';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) {
      return `Today ${date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })}`;
    } else if (date.toDateString() === yesterday.toDateString()) {
      return `Yesterday ${date.toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      })}`;
    } else {
      return date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  };

  if (entries.length === 0) {
    return (
      <div>
        <h4 className="g-flbl">Time entries</h4>
        {projectId != null && <FocusVsAgents projectId={projectId} />}
        <div className="text-center py-4 text-subtext-0">
          <svg
            className="w-8 h-8 mx-auto mb-2 text-gilt-a"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="text-sm">No time logged yet</p>
          <p className="text-xs mt-1">Turn on Active task to start the timer</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h4 className="g-flbl">Time entries</h4>
      {projectId != null && <FocusVsAgents projectId={projectId} />}
      <div className="border-t border-gilt-b">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="px-1 py-2.5 border-b border-gilt-b"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-text tabular-nums">
                  {formatDuration(entry.duration)}
                </span>
                {!entry.end_time && (
                  <span className="g-tag g-tag-ok">
                    Active
                  </span>
                )}
              </div>
              <p className="text-xs text-subtext-0 tabular-nums mt-0.5">
                {formatDate(entry.start_time)}
                {entry.end_time &&
                  ` - ${new Date(entry.end_time).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}`}
              </p>
              {entry.notes && (
                <p className="text-sm text-subtext-1 mt-2">{entry.notes}</p>
              )}
            </div>
            {entry.end_time && (
              <button
                onClick={() => handleDelete(entry.id)}
                className="g-iconbtn !w-8 !h-8 hover:!text-error"
                title="Delete entry"
                aria-label="Delete entry"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      ))}
      </div>
    </div>
  );
}

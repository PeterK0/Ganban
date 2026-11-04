/** The timer's "Agents" section: what each workspace's `get_agent_work` says, merged
 * into one row per task. Pure, so `scripts/test-agent-work.mjs` can run it. */

/** One row a host returns: an assistant working on a task in one run. */
export interface AgentWorkRow<T> {
  task_id: number;
  task: T;
  /** The personality's name. */
  who: string;
  /** When the run first touched the task (RFC 3339). */
  since: string;
}

export interface MergedAgentWork<T> {
  task: T;
  /** Every personality on the task, first to start first, joined with ", ". */
  who: string;
  /** When the first of them started (epoch ms). */
  since: number;
}

/** Merge the rows of every workspace into one entry per task, keyed by `keyOf` (the
 * task's workspace and id), oldest first. Two runs on one task (a delegate inside a
 * turn, or two chats) show as one row with both names and the earlier start. */
export function mergeAgentWork<T>(
  perWorkspace: { workspaceId: string; rows: AgentWorkRow<T>[] }[],
  tag: (task: T, workspaceId: string) => T,
  keyOf: (task: T) => string
): Record<string, MergedAgentWork<T>> {
  const all = perWorkspace
    .flatMap(({ workspaceId, rows }) =>
      rows.map((r) => ({ task: tag(r.task, workspaceId), who: r.who, since: Date.parse(r.since) || 0 }))
    )
    .sort((a, b) => a.since - b.since);
  const out: Record<string, MergedAgentWork<T>> = {};
  const names: Record<string, string[]> = {};
  for (const r of all) {
    const k = keyOf(r.task);
    if (!out[k]) {
      out[k] = { task: r.task, who: r.who, since: r.since };
      names[k] = [r.who];
    } else if (!names[k].includes(r.who)) {
      names[k].push(r.who);
      out[k].who = names[k].join(', ');
    }
  }
  return out;
}

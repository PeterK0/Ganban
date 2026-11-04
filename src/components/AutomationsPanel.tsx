import { useEffect, useMemo, useState } from 'react';
import { confirmDialog } from '../lib/confirm';
import { listRules, createRule, updateRule, deleteRule, type Rule } from '../lib/api';
import { useAppStore } from '../store/appStore';
import { getActiveWorkspaceId, LOCAL_ID } from '../lib/workspaces';
import {
  WEEKDAYS,
  cadenceProblem,
  defaultCadence,
  describeCadence,
  formatCadence,
  parseCadence,
  type Cadence,
  type CadenceMode,
} from '../lib/scheduleCadence';

// Settings → Automations: the owner's native rules (Epoch M(a)). A rule is
// "When <trigger> [filters], <action>" — executed by the host engine on the
// matching domain event, under existing scoping, loop-safe. Every firing lands
// in Activity. This panel edits the structured spec; it serializes to the
// trigger_json / action_json the engine parses.

const TRIGGERS = [
  { kind: 'task.status_changed', label: "a task's status changes" },
  { kind: 'task.created', label: 'a task is created' },
  { kind: 'comment.created', label: 'a comment is added' },
  { kind: 'event.created', label: 'an event is created' },
  // Fired by the host's 60s scheduler, not a domain event — so the action must
  // be context-free (notify): there is no task or event behind a clock tick.
  { kind: 'schedule', label: 'on a schedule' },
] as const;

const STATUSES = ['To Do', 'In Progress', 'Done', 'Blocked'];
const PRIORITIES = ['Low', 'Medium', 'High'];

const ACTIONS = [
  { kind: 'comment', label: 'add a comment' },
  { kind: 'set_task_field', label: 'set a task field' },
  { kind: 'notify', label: 'post a notification' },
] as const;

interface Draft {
  id: number | null;
  name: string;
  triggerKind: string;
  /** For 'schedule': interval, daily or weekly (lib/scheduleCadence.ts). */
  cadence: Cadence;
  status: string; // '' = any (for status_changed)
  projectId: number | ''; // '' = any project
  actionKind: string;
  text: string;
  field: 'priority' | 'status';
  value: string;
  enabled: boolean;
}

const blankDraft = (): Draft => ({
  id: null,
  name: '',
  triggerKind: 'task.status_changed',
  cadence: defaultCadence(),
  status: 'Blocked',
  projectId: '',
  actionKind: 'comment',
  text: '',
  field: 'priority',
  value: 'High',
  enabled: true,
});

function describe(rule: Rule, projectName: (id: number) => string): string {
  let t: any = {};
  let a: any = {};
  try { t = JSON.parse(rule.trigger_json); } catch { /* */ }
  try { a = JSON.parse(rule.action_json); } catch { /* */ }
  const trig = t.kind === 'schedule'
    ? describeCadence(t.every)
    : TRIGGERS.find((x) => x.kind === t.kind)?.label ?? t.kind ?? '?';
  const status = t.kind === 'task.status_changed' && t.status ? ` to ${t.status}` : '';
  const scope = t.project_id ? ` in ${projectName(t.project_id)}` : '';
  let act = '?';
  if (a.kind === 'comment') act = `add a comment${a.text ? ` “${a.text}”` : ''}`;
  else if (a.kind === 'notify') act = `notify${a.text ? `: “${a.text}”` : ''}`;
  else if (a.kind === 'set_task_field') act = `set ${a.field} to ${a.value}`;
  return t.kind === 'schedule' ? `${trig[0].toUpperCase()}${trig.slice(1)} → ${act}` : `When ${trig}${status}${scope} → ${act}`;
}

export default function AutomationsPanel() {
  const { projects } = useAppStore();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    listRules()
      .then((r) => { setRules(r); setError(null); })
      .catch((e) => { setRules([]); setError(e instanceof Error ? e.message : String(e)); });
  };
  useEffect(load, []);

  const projectName = useMemo(() => {
    const m = new Map(projects.map((p) => [p.id, p.name] as const));
    return (id: number) => m.get(id) ?? `project ${id}`;
  }, [projects]);
  // Rules live on (and the engine matches against) the project ids of the
  // workspace whose rules these are — the active one. Only offer ITS projects,
  // else a collided id from another host would scope the rule wrongly (K2).
  const activeProjects = useMemo(
    () => projects.filter((p) => !p.archived && (p.workspaceId ?? LOCAL_ID) === getActiveWorkspaceId()),
    [projects]
  );

  const edit = (rule: Rule) => {
    let t: any = {}, a: any = {};
    try { t = JSON.parse(rule.trigger_json); } catch { /* */ }
    try { a = JSON.parse(rule.action_json); } catch { /* */ }
    setDraft({
      id: rule.id,
      name: rule.name,
      triggerKind: t.kind ?? 'task.status_changed',
      cadence: parseCadence(t.every),
      status: t.status ?? '',
      projectId: t.project_id ?? '',
      actionKind: a.kind ?? 'comment',
      text: a.text ?? '',
      field: a.field === 'status' ? 'status' : 'priority',
      value: a.value ?? (a.field === 'status' ? 'Blocked' : 'High'),
      enabled: rule.enabled,
    });
  };

  const save = async () => {
    if (!draft || !draft.name.trim() || busy) return;
    if (draft.triggerKind === 'schedule' && cadenceProblem(draft.cadence)) return;
    setBusy(true);
    setError(null);
    const trigger: any = { kind: draft.triggerKind };
    if (draft.triggerKind === 'task.status_changed' && draft.status) trigger.status = draft.status;
    if (draft.triggerKind === 'schedule') trigger.every = formatCadence(draft.cadence);
    // event.created has no project at creation (events link to projects after),
    // so a project filter there could never match — don't write one.
    if (draft.projectId !== '' && draft.triggerKind !== 'event.created' && draft.triggerKind !== 'schedule') trigger.project_id = draft.projectId;
    // A clock tick carries no task/event — scheduled rules can only notify.
    const action: any = { kind: draft.triggerKind === 'schedule' ? 'notify' : draft.actionKind };
    if (draft.actionKind === 'set_task_field') {
      action.field = draft.field;
      action.value = draft.value;
    } else {
      action.text = draft.text;
    }
    const payload = {
      name: draft.name.trim(),
      trigger_json: JSON.stringify(trigger),
      action_json: JSON.stringify(action),
      enabled: draft.enabled,
    };
    try {
      if (draft.id == null) await createRule(payload);
      else await updateRule(draft.id, payload);
      setDraft(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (rule: Rule) => {
    try { await updateRule(rule.id, { enabled: !rule.enabled }); load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const remove = async (rule: Rule) => {
    if (!await confirmDialog(`Delete the rule “${rule.name}”?`)) return;
    try { await deleteRule(rule.id); load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const input = 'g-field';
  const taskAction = draft && draft.actionKind !== 'notify';
  const triggerHasTask = draft && draft.triggerKind !== 'event.created';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="g-h2 justify-start mb-1">Automations</h3>
          <p className="text-sm text-subtext-0">When something happens in your projects, do something automatically. Runs on the host; every firing is logged in Activity.</p>
        </div>
        {!draft && (
          <button onClick={() => setDraft(blankDraft())} className="g-btn g-btn-pri shrink-0">New rule</button>
        )}
      </div>

      {error && <div className="text-sm text-error bg-error/10 border border-error/30 rounded-lg px-3 py-2">{error}</div>}

      {/* Editor */}
      {draft && (
        <div className="g-card p-4 space-y-3">
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Rule name (e.g. Flag blocked tasks)" className={input} autoFocus />

          <div className="space-y-1">
            <label className="g-flbl">When</label>
            <div className="flex gap-2 flex-wrap">
              <select value={draft.triggerKind} onChange={(e) => setDraft({ ...draft, triggerKind: e.target.value })} className={input + ' flex-1'}>
                {TRIGGERS.map((t) => <option key={t.kind} value={t.kind}>{t.label}</option>)}
              </select>
              {draft.triggerKind === 'task.status_changed' && (
                <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })} className={input + ' flex-1'}>
                  <option value="">to any status</option>
                  {STATUSES.map((s) => <option key={s} value={s}>{`to ${s}`}</option>)}
                </select>
              )}
            </div>
            {draft.triggerKind === 'schedule' && (
              <div className="space-y-2">
                <ScheduleField cadence={draft.cadence} onChange={(cadence) => setDraft({ ...draft, cadence })} />
                <p className="text-xs text-subtext-0 mt-1">
                  Fires on the host's clock (5-minute floor). Scheduled rules can only notify — a clock tick has no task or event behind it.
                </p>
              </div>
            )}
            {draft.triggerKind !== 'event.created' && draft.triggerKind !== 'schedule' && (
              <select value={draft.projectId} onChange={(e) => setDraft({ ...draft, projectId: e.target.value === '' ? '' : Number(e.target.value) })} className={input}>
                <option value="">in any project</option>
                {activeProjects.map((p) => <option key={p.id} value={p.id}>{`in ${p.name}`}</option>)}
              </select>
            )}
          </div>

          <div className="space-y-1">
            <label className="g-flbl">Then</label>
            <select
              value={draft.triggerKind === 'schedule' ? 'notify' : draft.actionKind}
              onChange={(e) => setDraft({ ...draft, actionKind: e.target.value })}
              disabled={draft.triggerKind === 'schedule'}
              className={input + (draft.triggerKind === 'schedule' ? ' opacity-70' : '')}
            >
              {(draft.triggerKind === 'schedule' ? ACTIONS.filter((a) => a.kind === 'notify') : ACTIONS).map((a) => (
                <option key={a.kind} value={a.kind}>{a.label}</option>
              ))}
            </select>
            {draft.actionKind === 'set_task_field' ? (
              <div className="flex gap-2">
                <select value={draft.field} onChange={(e) => setDraft({ ...draft, field: e.target.value as 'priority' | 'status', value: e.target.value === 'status' ? 'Blocked' : 'High' })} className={input + ' flex-1'}>
                  <option value="priority">priority</option>
                  <option value="status">status</option>
                </select>
                <select value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} className={input + ' flex-1'}>
                  {(draft.field === 'status' ? STATUSES : PRIORITIES).map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
            ) : (
              <input value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} placeholder={draft.actionKind === 'notify' ? 'Notification text' : 'Comment text'} className={input} />
            )}
            {taskAction && !triggerHasTask && (
              <p className="text-xs text-warning">This action needs a task, but “an event is created” has none — it will be skipped. Pick a task-based trigger.</p>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <label className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
              Enabled
            </label>
            <div className="flex gap-2">
              <button onClick={() => setDraft(null)} className="g-btn g-btn-ghost">Cancel</button>
              <button onClick={save} disabled={!draft.name.trim() || busy || (draft.triggerKind === 'schedule' && !!cadenceProblem(draft.cadence))} className="g-btn g-btn-pri">{busy ? 'Saving…' : draft.id == null ? 'Create rule' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      {rules === null ? (
        <p className="text-sm text-subtext-0">Loading…</p>
      ) : rules.length === 0 ? (
        !draft && <p className="text-sm text-subtext-0 italic">No automations yet. Create one to react to changes in your projects.</p>
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => (
            <div key={rule.id} className="flex items-start gap-3 g-card p-4">
              <button onClick={() => toggle(rule)} title={rule.enabled ? 'Disable' : 'Enable'} className={`mt-0.5 relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${rule.enabled ? 'bg-primary' : 'bg-surface-2'}`}>
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${rule.enabled ? 'translate-x-5' : 'translate-x-1'}`} />
              </button>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text">{rule.name}</div>
                <div className="text-xs text-subtext-0">{describe(rule, projectName)}</div>
                <div className="text-[11px] text-subtext-0 mt-0.5">
                  Fired {rule.fire_count}×{rule.last_fired_at ? ` · last ${rule.last_fired_at}` : ''}{!rule.enabled ? ' · disabled' : ''}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button onClick={() => edit(rule)} className="px-2 py-1 text-xs text-subtext-0 hover:text-text">Edit</button>
                <button onClick={() => remove(rule)} className="g-btn g-btn-danger g-btn-sm">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const DAY_NAMES: Record<string, string> = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
};

/** The schedule trigger's cadence: every N (interval), daily at a time, or
 * weekly on picked days at a time. */
function ScheduleField({ cadence, onChange }: { cadence: Cadence; onChange: (c: Cadence) => void }) {
  const set = (patch: Partial<Cadence>) => onChange({ ...cadence, ...patch });
  const toggleDay = (d: Cadence['days'][number]) =>
    set({ days: cadence.days.includes(d) ? cadence.days.filter((x) => x !== d) : WEEKDAYS.filter((x) => x === d || cadence.days.includes(x)) });
  const problem = cadenceProblem(cadence);
  return (
    <div className="space-y-2">
      <div className="g-seg" role="group" aria-label="Repeats">
        {(
          [
            ['interval', 'Every…'],
            ['daily', 'Daily'],
            ['weekly', 'Weekly'],
          ] as [CadenceMode, string][]
        ).map(([mode, label]) => (
          <button key={mode} type="button" aria-pressed={cadence.mode === mode} onClick={() => set({ mode })} className="g-chip">
            {label}
          </button>
        ))}
      </div>
      {cadence.mode === 'interval' ? (
        <input
          value={cadence.interval}
          onChange={(e) => set({ interval: e.target.value })}
          placeholder="e.g. 1 hour · 30 min · 2 days"
          aria-label="How often"
          className="g-field"
        />
      ) : (
        <div className="flex items-center gap-3 flex-wrap">
          {cadence.mode === 'weekly' && (
            <div className="g-seg" role="group" aria-label="Days of the week">
              {WEEKDAYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={cadence.days.includes(d)}
                  aria-label={DAY_NAMES[d]}
                  title={DAY_NAMES[d]}
                  onClick={() => toggleDay(d)}
                  className="g-chip !px-0 w-9 justify-center"
                >
                  {d}
                </button>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-subtext-0">
            at
            <input type="time" value={cadence.time} onChange={(e) => set({ time: e.target.value })} className="g-field !w-auto" />
          </label>
        </div>
      )}
      {problem && <p className="text-xs text-error">{problem}</p>}
    </div>
  );
}

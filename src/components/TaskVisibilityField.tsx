import { useEffect, useState } from 'react';
import { getTaskAudience, setTaskVisibility } from '../lib/api';
import { useProjectRole } from '../lib/projectRole';
import type { Area, TaskAudience, TaskVisibility, User } from '../types';
import { audienceUsers, namesOf } from './TaskVisibilityBadge';

/**
 * Who can see a task (task visibility, ADR 0002). Admins pick: its area's say (everyone,
 * or a restricted area's members), selected members, or admins only. Everyone else sees
 * who it's visible to. The owner, admins and assignees always see it.
 */
export default function TaskVisibilityField({
  taskId,
  projectId,
  areas,
  savedAreaId,
}: {
  taskId: number;
  projectId: number;
  areas: Area[];
  /** The task's saved area: who "follows its area" admits depends on it. */
  savedAreaId?: number;
}) {
  const { canManage, members } = useProjectRole(projectId);
  const [audience, setAudience] = useState<TaskAudience | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTaskAudience(taskId)
      .then((a) => !cancelled && setAudience(a))
      .catch(() => !cancelled && setAudience(null));
    audienceUsers().then((u) => !cancelled && setUsers(u));
    return () => {
      cancelled = true;
    };
  }, [taskId, savedAreaId]);

  if (!audience) return null;
  const area = areas.find((a) => a.id === savedAreaId);
  const everyone = audience.visibility === 'area' && !audience.area?.restricted;

  const apply = async (visibility: TaskVisibility, selected: number[]) => {
    setSaving(true);
    setError(null);
    try {
      setAudience(await setTaskVisibility(taskId, visibility, selected));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const followsLabel = area?.restricted ? `Follows its area (${area.name}: its members)` : 'Follows its area (everyone in the project)';
  return (
    <div>
      <label className="g-flbl">Who can see it</label>
      {canManage ? (
        <div className="space-y-2">
          <select
            value={audience.visibility}
            disabled={saving}
            onChange={(e) => {
              const v = e.target.value as TaskVisibility;
              void apply(v, v === 'members' ? audience.selected : []);
            }}
            className="g-field"
          >
            <option value="area">{followsLabel}</option>
            <option value="members">Selected members</option>
            <option value="admins">Admins only</option>
          </select>
          {audience.visibility === 'members' && (
            <div className="flex flex-wrap gap-1.5">
              {members
                .filter((m) => m.role === 'member')
                .map((m) => {
                  const on = audience.selected.includes(m.user_id);
                  return (
                    <button
                      key={m.user_id}
                      type="button"
                      disabled={saving}
                      onClick={() =>
                        void apply('members', on ? audience.selected.filter((id) => id !== m.user_id) : [...audience.selected, m.user_id])
                      }
                      aria-pressed={on}
                      className={`g-tag g-hit min-h-[28px] transition-colors ${
                        on ? '!bg-gilt-b !text-gold shadow-[inset_0_0_0_1px_var(--color-gilt-a)]' : 'hover:!text-text'
                      }`}
                    >
                      {m.display_name}
                    </button>
                  );
                })}
            </div>
          )}
        </div>
      ) : null}
      <p className="mt-1.5 text-[13px] text-subtext-0">
        {everyone ? 'Everyone in the project' : `🔒 Visible to ${namesOf(audience.audience, users)}`}
        {!everyone && ' (admins and assignees always see it)'}
      </p>
      {error && <p className="mt-1 text-xs text-error">{error}</p>}
    </div>
  );
}

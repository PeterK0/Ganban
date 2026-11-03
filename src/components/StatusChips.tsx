import { STATUSES, toggleStatus, type Status } from './statusFilter';
import { statusMark } from './taskMarks';

/** Multi-choice status chips (`g-seg` + `g-chip`): "All" plus one chip per
 * status, each with an optional count. The empty selection is "All". */
export default function StatusChips({
  value,
  onChange,
  counts,
  className = '',
  label = 'Filter by status',
}: {
  value: Status[];
  onChange: (next: Status[]) => void;
  counts?: Record<Status, number>;
  className?: string;
  label?: string;
}) {
  const total = counts ? STATUSES.reduce((n, s) => n + counts[s], 0) : undefined;
  return (
    <div role="group" aria-label={label} className={`g-seg ${className}`}>
      <button type="button" aria-pressed={value.length === 0} onClick={() => onChange([])} className="g-chip">
        All
        {total !== undefined && <span className="tabular-nums opacity-70">{total}</span>}
      </button>
      {STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={value.includes(s)}
          onClick={() => onChange(toggleStatus(value, s))}
          className="g-chip"
        >
          <span className={statusMark(s)} aria-hidden="true" />
          {s}
          {counts && <span className="tabular-nums opacity-70">{counts[s]}</span>}
        </button>
      ))}
    </div>
  );
}

import { useEffect, useState } from 'react';
import {
  describeRrule,
  isWorkweek,
  modelToRrule,
  rruleToModel,
  WEEK_ORDER,
  WORKWEEK,
  type RepeatEnd,
  type RepeatFreq,
  type RepeatModel,
} from '../lib/recur.pure';

const MUTED = 'text-[color:var(--g-mut)]';
const UNIT: Record<RepeatFreq, string> = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
const CHIP_LABEL: Record<string, string> = { MO: 'M', TU: 'T', WE: 'W', TH: 'T', FR: 'F', SA: 'S', SU: 'S' };
const CHIP_NAME: Record<string, string> = {
  MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday',
};
const JS_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

type Preset = '' | RepeatFreq | 'WEEKDAYS' | 'custom';

/** The start date's weekday code ("MO"), Monday when there's no date yet. */
const startWeekday = (startDate: string) => {
  const [y, m, d] = startDate.split('-').map(Number);
  return y ? JS_DAY[new Date(y, m - 1, d).getDay()] : 'MO';
};
const plusMonth = (startDate: string) => {
  const [y, m, d] = startDate.split('-').map(Number);
  const t = y ? new Date(y, m, d) : new Date(new Date().setMonth(new Date().getMonth() + 1));
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
};

/** A whole number field that lets you clear it while typing (commits ≥ 1). */
function CountField({ value, onCommit, label, max = 999 }: { value: number; onCommit: (n: number) => void; label: string; max?: number }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return (
    <input
      type="number"
      min={1}
      max={max}
      aria-label={label}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = parseInt(e.target.value, 10);
        if (n >= 1 && n <= max) onCommit(n);
      }}
      onBlur={() => setDraft(String(value))}
      className="g-field g-field-sm !w-20 text-center tabular-nums"
    />
  );
}

/**
 * The event editor's Repeats control: a preset (daily, every weekday, weekly…),
 * "every N", weekday chips for weekly, and when it ends (never, on a date, after
 * N times). Writes a standard RRULE. A rule it can't show (an imported one) stays
 * as it is, offered as "custom (kept)", until you pick something else.
 */
export default function RepeatControl({
  rrule,
  startDate,
  onChange,
}: {
  rrule: string;
  /** The event's date (YYYY-MM-DD): weekly starts on its weekday. */
  startDate: string;
  onChange: (rrule: string) => void;
}) {
  const model = rruleToModel(rrule);
  const preset: Preset = !rrule ? '' : !model ? 'custom' : isWorkweek(model) ? 'WEEKDAYS' : model.freq;
  const emit = (m: RepeatModel) => onChange(modelToRrule(m));
  const end: RepeatEnd = model?.end ?? { kind: 'never' };

  const choose = (p: Preset) => {
    if (p === '') return onChange('');
    if (p === 'custom') return;
    const keep = { interval: 1, end };
    if (p === 'WEEKDAYS') return emit({ freq: 'WEEKLY', byday: [...WORKWEEK], ...keep });
    if (p === 'WEEKLY') return emit({ freq: 'WEEKLY', byday: [startWeekday(startDate)], ...keep });
    emit({ freq: p, byday: [], ...keep });
  };

  // Weekly chips: an empty BYDAY means the start's weekday.
  const days = model ? (model.byday.length ? model.byday : [startWeekday(startDate)]) : [];
  const toggleDay = (d: string) => {
    if (!model) return;
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
    if (next.length === 0) return; // a weekly rule needs a day
    emit({ ...model, byday: next });
  };

  return (
    <div>
      <label className="g-flbl" htmlFor="event-repeats">Repeats</label>
      <select id="event-repeats" value={preset} onChange={(e) => choose(e.target.value as Preset)} className="g-field">
        <option value="">Does not repeat</option>
        <option value="DAILY">Every day</option>
        <option value="WEEKDAYS">Every weekday (Mon–Fri)</option>
        <option value="WEEKLY">Every week</option>
        <option value="MONTHLY">Every month</option>
        <option value="YEARLY">Every year</option>
        {preset === 'custom' && <option value="custom">{describeRrule(rrule)} (custom, kept)</option>}
      </select>

      {model && (
        <div className="g-inset mt-2 space-y-3">
          <div className="flex items-center gap-2 text-sm text-text">
            <span>Every</span>
            <CountField
              label={`Repeat every how many ${UNIT[model.freq]}s`}
              value={model.interval}
              max={99}
              onCommit={(n) => emit({ ...model, interval: n })}
            />
            <span>{UNIT[model.freq]}{model.interval === 1 ? '' : 's'}</span>
          </div>

          {model.freq === 'WEEKLY' && (
            <div>
              <span className={`g-flbl ${MUTED}`}>On</span>
              <div className="g-seg" role="group" aria-label="Days of the week">
                {WEEK_ORDER.map((d) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={days.includes(d)}
                    aria-label={CHIP_NAME[d]}
                    title={CHIP_NAME[d]}
                    onClick={() => toggleDay(d)}
                    className="g-chip !px-0 w-8 justify-center"
                  >
                    {CHIP_LABEL[d]}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <span className={`g-flbl ${MUTED}`}>Ends</span>
            <div className="g-seg" role="group" aria-label="Ends">
              {(
                [
                  ['never', 'Never'],
                  ['until', 'On a date'],
                  ['count', 'After'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={end.kind === k}
                  onClick={() =>
                    emit({
                      ...model,
                      end: k === 'never' ? { kind: 'never' } : k === 'until' ? { kind: 'until', date: plusMonth(startDate) } : { kind: 'count', count: 10 },
                    })
                  }
                  className="g-chip"
                >
                  {label}
                </button>
              ))}
            </div>
            {end.kind === 'until' && (
              <input
                type="date"
                aria-label="Last date"
                value={end.date}
                min={startDate || undefined}
                onChange={(e) => e.target.value && emit({ ...model, end: { kind: 'until', date: e.target.value } })}
                className="g-field g-field-sm mt-2"
              />
            )}
            {end.kind === 'count' && (
              <div className="flex items-center gap-2 mt-2 text-sm text-text">
                <CountField label="How many times" value={end.count} onCommit={(n) => emit({ ...model, end: { kind: 'count', count: n } })} />
                <span>time{end.count === 1 ? '' : 's'}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {preset === 'custom' && (
        <p className={`text-xs mt-1.5 ${MUTED}`}>
          This rule came with an imported calendar and is kept as it is. Pick another option to replace it.
        </p>
      )}
      {rrule && <p className={`text-xs mt-1.5 ${MUTED}`}>Repeats apply to the whole series.</p>}
    </div>
  );
}

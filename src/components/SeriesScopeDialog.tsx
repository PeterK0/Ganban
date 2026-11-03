// "This event / This and following / All events": the question a change to one
// day of a repeating event asks, as Google and Apple Calendar do. Awaited like
// confirmDialog: `askSeriesScope(...)` resolves to the choice, or null on cancel.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Modal } from './gilt';
import type { SeriesScope } from '../lib/eventSeries';

export type SeriesAction = 'edit' | 'delete' | 'past' | 'upcoming';

const VERB: Record<SeriesAction, string> = {
  edit: 'Change',
  delete: 'Delete',
  past: 'Mark past',
  upcoming: 'Mark upcoming',
};

const CHOICES: { id: SeriesScope; label: string; hint: Record<SeriesAction, string> }[] = [
  {
    id: 'this',
    label: 'This event',
    hint: {
      edit: 'Only this day; the rest of the series stays as it is.',
      delete: 'Skip this day; the rest of the series stays.',
      past: 'Only this day.',
      upcoming: 'Only this day.',
    },
  },
  {
    id: 'following',
    label: 'This and following events',
    hint: {
      edit: 'Splits the series: the days before keep the old version.',
      delete: 'Ends the series the day before.',
      past: 'Splits the series from this day.',
      upcoming: 'Splits the series from this day.',
    },
  },
  {
    id: 'all',
    label: 'All events',
    hint: {
      edit: 'Every day of the series, past ones too.',
      delete: 'The whole series goes to the Bin.',
      past: 'The whole series.',
      upcoming: 'The whole series.',
    },
  },
];

function ScopeModal({
  action,
  title,
  days,
  onDone,
}: {
  action: SeriesAction;
  title: string;
  days: number;
  onDone: (s: SeriesScope | null) => void;
}) {
  const [pick, setPick] = useState<SeriesScope>('this');
  return (
    <Modal onClose={() => onDone(null)} title={`${VERB[action]} a repeating event`} className="w-[440px]">
      <div className="px-6 pt-1 pb-5 space-y-4">
        <p className="text-[13px] text-center text-[color:var(--g-mut)]">
          {days > 1 ? `${days} days of repeating events are picked` : <>“{title}” repeats</>}. Which days?
        </p>
        <div role="radiogroup" className="space-y-1.5">
          {CHOICES.map((c) => (
            <label
              key={c.id}
              className={`g-row flex items-start gap-2.5 px-3 py-2.5 rounded cursor-pointer ${pick === c.id ? 'g-on' : ''}`}
            >
              <input
                type="radio"
                name="series-scope"
                checked={pick === c.id}
                onChange={() => setPick(c.id)}
                className="mt-0.5 accent-[color:var(--color-primary)]"
              />
              <span className="flex flex-col leading-tight">
                <span className="text-sm text-text">{c.label}</span>
                <span className="text-xs mt-0.5 text-[color:var(--g-mut)]">{c.hint[action]}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => onDone(null)} className="g-btn g-btn-ghost g-btn-sm">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onDone(pick)}
            className={`g-btn g-btn-sm ${action === 'delete' ? 'g-btn-danger' : 'g-btn-pri'}`}
          >
            {VERB[action]}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Ask which days of a series a change covers. `days`: how many picked days it's about. */
export function askSeriesScope(opts: { action: SeriesAction; title: string; days?: number }): Promise<SeriesScope | null> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let answered = false;
    const done = (s: SeriesScope | null) => {
      if (answered) return;
      answered = true;
      // Unmount after the click that answered has finished rendering.
      window.setTimeout(() => {
        root.unmount();
        host.remove();
      });
      resolve(s);
    };
    root.render(<ScopeModal action={opts.action} title={opts.title} days={opts.days ?? 1} onDone={done} />);
  });
}

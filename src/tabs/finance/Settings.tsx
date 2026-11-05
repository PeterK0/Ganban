// Finance settings: the weekly reminder to import bank statements (on or off, the weekday and the
// time, host-local). The host sends it as a notification with no amounts in it.
import { useEffect, useState } from 'react';
import { DecoHeading } from '../../components/gilt';
import * as fin from './api';
import { WEEKDAYS, weekdayName } from './reports.pure';
import { MUTED, errText, useFinance } from './shared';

export default function Settings() {
  const { locale } = useFinance();
  const [s, setS] = useState<fin.FinSettings | null>(null);
  const [time, setTime] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fin.getSettings().then(
      (r) => {
        setS(r);
        setTime(r.reminder.time);
      },
      (e) => setMsg(errText(e)),
    );
  }, []);

  const save = async (patch: Partial<fin.FinSettings['reminder']>) => {
    if (!s) return;
    const before = s;
    setS({ ...s, reminder: { ...s.reminder, ...patch } });
    setSaved(false);
    try {
      const r = await fin.updateSettings(patch);
      setS(r);
      setTime(r.reminder.time);
      setMsg(null);
      setSaved(true);
    } catch (e) {
      setS(before);
      setTime(before.reminder.time);
      setMsg(errText(e));
    }
  };

  const r = s?.reminder;
  return (
    <div className="space-y-4 max-w-[720px]">
      <DecoHeading>Import reminder</DecoHeading>
      {!r ? (
        msg ? <p className="text-sm text-error">{msg}</p> : <p className={`text-sm ${MUTED}`}>Loading…</p>
      ) : (
        <div className="g-card p-5 space-y-4">
          <div className="g-togrow">
            <span id="fin-reminder" className="flex-1 min-w-0">
              <span className="block font-semibold text-text">Remind me to import my bank statements</span>
              <span className="block text-xs text-subtext-0">
                Once a week, a notification says it's time to import. It names no amounts or accounts.
              </span>
            </span>
            <button onClick={() => void save({ enabled: !r.enabled })} role="switch" aria-checked={r.enabled} aria-labelledby="fin-reminder" className="g-tog">
              <span className="g-tog-k" />
            </button>
          </div>
          <div className={`flex flex-wrap items-end gap-4 ${r.enabled ? '' : 'opacity-60'}`}>
            <label className="block">
              <span className="g-flbl">Day</span>
              <select className="g-field !w-[180px]" value={r.weekday} disabled={!r.enabled} onChange={(e) => void save({ weekday: e.target.value as fin.Weekday })}>
                {WEEKDAYS.map((d) => (
                  <option key={d} value={d}>
                    {weekdayName(d, locale)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="g-flbl">Time</span>
              <input
                type="time"
                className="g-field !w-[140px]"
                value={time}
                disabled={!r.enabled}
                onChange={(e) => setTime(e.target.value)}
                onBlur={() => time && time !== r.time && void save({ time })}
              />
            </label>
            <span className={`text-xs ${MUTED} pb-2`}>The host's local time.</span>
          </div>
          {(msg || saved) && <p className={`text-sm ${msg ? 'text-error' : MUTED}`} role="status">{msg ?? 'Saved.'}</p>}
        </div>
      )}
      <p className={`text-sm ${MUTED} g-read`}>
        Bank data comes in by import, so a weekly import keeps the overview, budgets and forecast current.
      </p>
    </div>
  );
}

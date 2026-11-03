import { useEffect, useState } from 'react';
import EventDropdown from './EventDropdown';
import { formatClockDate, formatClockTime, timezoneLabel } from '../lib/clock';

/**
 * The top bar's live clock and its date & events popup.
 *
 * It owns the one-second tick, so only this button re-renders every second.
 * (The tick used to live in App and re-rendered the whole window, Home and
 * Project > Home included, which made scrolling choppy.)
 */
export default function TopBarClock({
  open,
  onToggle,
  onClose,
  onNavigateToCalendar,
  buttonClassName,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onNavigateToCalendar: () => void;
  buttonClassName: string;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="relative shrink-0">
      <button
        onClick={onToggle}
        className={buttonClassName}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`${formatClockDate(now)} ${timezoneLabel(now)} — date & events`}
      >
        {/* Josefin Sans has no tabular figures, so "1" is narrower than "0" and the bar
            shifted every second. Each digit gets a fixed-width cell instead. */}
        <span className="g-deco text-base text-text pt-0.5 inline-flex" aria-label={formatClockTime(now)}>
          {[...formatClockTime(now)].map((ch, i) => (
            <span key={i} aria-hidden="true" className={/\d/.test(ch) ? 'inline-block w-[0.72em] text-center' : 'inline-block px-[0.08em]'}>
              {ch}
            </span>
          ))}
        </span>
      </button>
      <EventDropdown
        isOpen={open}
        onClose={onClose}
        onNavigateToCalendar={onNavigateToCalendar}
        dateLabel={formatClockDate(now)}
        timeLabel={formatClockTime(now)}
        tzLabel={timezoneLabel(now)}
      />
    </div>
  );
}

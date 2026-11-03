import { useEffect } from 'react';
import { getEvents } from '../lib/api';
import { notify, type NotifKind } from '../store/notifications';
import { getTomorrowPolicy, getDayOfEnabled, wasReminded, markReminded } from '../lib/reminderPrefs';

const KIND: Record<'now' | 'soon' | 'upcoming', NotifKind> = { now: 'error', soon: 'info', upcoming: 'info' };

// Day-level reminders keep office hours; only time-proximate ones (1h / 15m)
// may speak outside them.
const QUIET_UNTIL = 7; // no day-level reminders before 07:00…
const QUIET_AFTER = 21; // …or after 21:00
const EVENING_FROM = 17; // 'evening' tomorrow-policy: heads-up from 17:00

/**
 * Watches upcoming events and drops reminders into the notification center
 * (the bell). Renders nothing. The reminder POLICY (all of it born from the
 * "bombarded with next-day notifications" complaint):
 *
 * - "already reminded" memory is PERSISTENT (localStorage) — the old in-memory
 *   set re-fired the whole week's reminders on every app launch.
 * - events ≥2 days out never notify.
 * - "tomorrow" heads-up is a device setting: off (default) / evening before /
 *   all day.
 * - "today at HH:MM" fires once, inside quiet hours (07–21), toggleable.
 * - 1-hour and starting-soon reminders always fire — they're time-proximate.
 */
export default function NotificationSystem() {
  useEffect(() => {
    // One console entry per failure STREAK — a busy host failing a 60s poll
    // for an hour was writing 60 identical errors into every bug report.
    let failing = false;
    const check = async () => {
      try {
        const now = new Date();
        const week = new Date(now);
        week.setDate(now.getDate() + 7);
        const events = await getEvents(
          now.toISOString().split('T')[0],
          week.toISOString().split('T')[0],
          false
        );

        // Read prefs each pass so Settings changes apply without a reload.
        const tomorrowPolicy = getTomorrowPolicy();
        const dayOfEnabled = getDayOfEnabled();
        const hour = now.getHours();
        const officeHours = hour >= QUIET_UNTIL && hour < QUIET_AFTER;

        for (const event of events) {
          if (event.done_at) continue; // marked past by hand: nothing to remind of
          const eventDate = new Date(event.event_date);
          if (event.start_time) {
            const [h, m] = event.start_time.split(':').map(Number);
            eventDate.setHours(h, m, 0, 0);
          }
          const hoursUntil = (eventDate.getTime() - now.getTime()) / 3.6e6;
          // "Today"/"tomorrow" are CALENDAR days, not rolling 24h counts.
          const startOfDay = (d: Date) => {
            const x = new Date(d);
            x.setHours(0, 0, 0, 0);
            return x;
          };
          const dayDiff = Math.round((startOfDay(eventDate).getTime() - startOfDay(now).getTime()) / 8.64e7);

          let id = '';
          let message = '';
          let kind: 'now' | 'soon' | 'upcoming' = 'upcoming';
          if (hoursUntil <= 0.25 && hoursUntil > 0) {
            id = `${event.id}-now`;
            message = `${event.title} is starting soon!`;
            kind = 'now';
          } else if (hoursUntil <= 1 && hoursUntil > 0.25) {
            id = `${event.id}-1hr`;
            message = `${event.title} starts in ${Math.round(hoursUntil * 60)} minutes`;
            kind = 'soon';
          } else if (dayDiff === 0 && hoursUntil > 0 && dayOfEnabled && officeHours) {
            id = `${event.id}-today`;
            message = `${event.title} is today${event.start_time ? ` at ${event.start_time}` : ''}`;
          } else if (
            dayDiff === 1 &&
            tomorrowPolicy !== 'off' &&
            officeHours &&
            (tomorrowPolicy === 'all' || hour >= EVENING_FROM)
          ) {
            id = `${event.id}-tomorrow`;
            message = `${event.title} is tomorrow${event.start_time ? ` at ${event.start_time}` : ''}`;
          }
          // dayDiff ≥ 2: silence, always.

          if (id && !wasReminded(id)) {
            markReminded(id);
            notify({ id, kind: KIND[kind], category: 'event', title: message, body: event.location ? `📍 ${event.location}` : undefined });
          }
        }
        failing = false;
      } catch (error) {
        if (!failing) console.warn('Upcoming-events check failing (will retry quietly):', error);
        failing = true;
      }
    };
    void check();
    const interval = setInterval(check, 60000);
    return () => clearInterval(interval);
  }, []);

  return null;
}

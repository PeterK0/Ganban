// The host's durable notifications (mentions, rules, the weekly bank-import reminder) pulled into the
// bell's store (src/store/notifications.ts). The desktop's notification center and the phone shell
// both use it, so the two show the same feed.
import { getNotifications } from './api';
import { notify, type NotifCategory } from '../store/notifications';

/** Host notifications already surfaced this session, so one the user dismissed doesn't come back. */
const surfaced = new Set<number>();

/** The store id of a host notification. */
export const serverNotifId = (id: number) => `srv-${id}`;

/**
 * Pull the host's notifications and surface each unread one once. Only unread ones are shown, so
 * marking them read (on the host) sticks. A host that can't be reached leaves the bell as it is.
 */
export async function pullServerNotifications(): Promise<void> {
  let list;
  try {
    list = await getNotifications();
  } catch {
    return;
  }
  for (const n of list.slice().reverse()) {
    if (n.read || surfaced.has(n.id)) continue;
    surfaced.add(n.id);
    notify({ id: serverNotifId(n.id), category: (n.category as NotifCategory) || 'comment', title: n.title, body: n.body ?? undefined });
  }
}

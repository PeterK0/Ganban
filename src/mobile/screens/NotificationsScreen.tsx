import { useNotifications, type Notif } from "../../store/notifications";
import { markNotificationsRead } from "../../lib/api";
import { useShownRails } from "../../components/RailViews";
import { RAIL_MODULES } from "../../tabs/modules";
import { useNav } from "../nav";
import { EmptyState, Screen } from "../ui";
import RailScreen from "./RailScreen";

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString();
}

/** The rail module a notification belongs to (a finance reminder opens Finance), if this build has it. */
const moduleFor = (n: Notif) => RAIL_MODULES.find((m) => m.id === n.category) ?? null;

/** The bell's list on the phone: the same feed as the desktop's notification center. */
export default function NotificationsScreen() {
  const nav = useNav();
  const items = useNotifications((s) => s.items);
  const dismiss = useNotifications((s) => s.dismiss);
  const clear = useNotifications((s) => s.clear);
  const update = useNotifications((s) => s.update);
  const rails = useShownRails();
  const unread = items.some((i) => !i.read);

  // Marking read clears them on the host too, so they don't come back on the next pull.
  const markAll = () => {
    useNotifications.getState().markAllRead();
    markNotificationsRead().catch(() => {});
  };
  const open = (n: Notif) => {
    update(n.id, { read: true });
    const m = moduleFor(n);
    if (m) nav.push(<RailScreen module={m} />);
  };

  return (
    <Screen
      title="Notifications"
      onBack={nav.pop}
      right={
        items.length > 0 ? (
          <button onClick={unread ? markAll : clear} className="g-lnk min-h-[44px] px-2 text-sm shrink-0">
            {unread ? "Mark all read" : "Clear"}
          </button>
        ) : undefined
      }
    >
      {items.length === 0 ? (
        <EmptyState text="You're all caught up." />
      ) : (
        <div role="list">
          {items.map((n) => {
            const m = moduleFor(n);
            const opens = !!m && rails.some((r) => r.id === m.id);
            return (
              <div key={n.id} role="listitem" className={`flex items-stretch border-b border-gilt-b ${n.read ? "" : "bg-primary/5"}`}>
                <button
                  onClick={() => open(n)}
                  className="flex-1 min-w-0 flex items-start gap-3 px-4 py-3 min-h-[56px] text-left active:bg-surface-0"
                >
                  <span className={`mt-1.5 shrink-0 w-2 h-2 rotate-45 ${n.read ? "bg-transparent" : "bg-gold"}`} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[15px] ${n.read ? "gm-fg2" : "text-text font-medium"}`}>{n.title}</span>
                    {n.body && <span className="block text-[13px] gm-mut break-words">{n.body}</span>}
                    <span className="block text-xs gm-mut mt-0.5">
                      {ago(n.ts)}
                      {opens ? ` · Opens ${m!.rail!.label}` : ""}
                    </span>
                  </span>
                </button>
                <button onClick={() => dismiss(n.id)} aria-label="Dismiss" className="min-w-[48px] px-3 gm-mut active:bg-surface-0">
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </Screen>
  );
}

/** The bell in a root screen's header: the unread count, and the list one tap away. */
export function Bell() {
  const nav = useNav();
  const unread = useNotifications((s) => s.items.filter((i) => !i.read).length);
  return (
    <button
      onClick={() => nav.push(<NotificationsScreen />)}
      className="g-iconbtn relative w-11 h-11 text-gold active:bg-surface-0"
      aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
    >
      <svg viewBox="0 0 24 24" className="w-6 h-6" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true">
        <path d="M6 16V11a6 6 0 1112 0v5l1.5 2h-15L6 16z" strokeLinejoin="round" />
        <path d="M10 20.5a2 2 0 004 0" strokeLinecap="round" />
      </svg>
      {unread > 0 && (
        <span className="absolute top-1 right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-error text-white text-[10px] font-bold flex items-center justify-center border-2 border-crust pointer-events-none">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}

// Settings → Plug-ins: one switch per tab module with a rail view the host offers (Finance, say).
// The switch is the user's own, saved on the host (src/store/railTabs.ts), and shows or hides the
// module's view in the sidebar.
import { useEffect, useState } from 'react';
import { TabIcon } from './icons/TabIcon';
import { useRailTabs, offeredRails } from '../store/railTabs';

/** `bare`: no title of its own, under a screen's section header (the phone's Settings). */
export default function RailSwitches({ bare = false }: { bare?: boolean }) {
  const hostTabs = useRailTabs((s) => s.hostTabs);
  const on = useRailTabs((s) => s.on);
  const userId = useRailTabs((s) => s.userId);
  const [msg, setMsg] = useState<string | null>(null);
  // Fresh switches each time the section opens (another device may have changed them).
  useEffect(() => {
    const id = useRailTabs.getState().userId;
    if (id != null) void useRailTabs.getState().load(id);
  }, []);
  const rails = offeredRails(hostTabs);
  if (rails.length === 0) return null;

  const toggle = (id: string, value: boolean) => {
    setMsg(null);
    useRailTabs
      .getState()
      .setOn(id, value)
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="g-card p-5 space-y-2">
      {!bare && <div className="font-medium text-text">Sections</div>}
      <p className="text-sm text-subtext-0">Optional parts of Ganban, each with its own place in the sidebar (on a phone, under More). These switches are yours alone and follow you to your other devices.</p>
      {rails.map((m) => {
        const rail = m.rail!;
        const labelId = `rail-switch-${m.id}`;
        return (
          <div key={m.id} className="g-togrow border-t border-gilt-b">
            <TabIcon name={rail.icon} className="w-[18px] h-[18px] text-subtext-1" />
            <span id={labelId} className="flex-1 min-w-0">
              <span className="block font-semibold text-text">{rail.label}</span>
              {rail.description && <span className="block text-xs text-subtext-0">{rail.description}</span>}
            </span>
            <button
              onClick={() => toggle(m.id, !on[m.id])}
              disabled={userId == null}
              role="switch"
              aria-checked={!!on[m.id]}
              aria-labelledby={labelId}
              className="g-tog"
            >
              <span className="g-tog-k" />
            </button>
          </div>
        );
      })}
      {msg && <p className="text-sm text-error">{msg}</p>}
    </div>
  );
}

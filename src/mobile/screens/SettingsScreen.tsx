import { useAppStore } from "../../store/appStore";
import { confirmDialog } from '../../lib/confirm';
import { themes } from "../../themes";
import { currentDaemonUrl, getMe, isWebClient, setDaemonBaseUrl, type MeResponse } from "../../lib/daemon";
import { useNav } from "../nav";
import { Button, Screen, SectionHeader, Spinner, useAsync, Chevron } from "../ui";
import AccountScreen from "./AccountScreen";
import { buildLabel } from "../../lib/build";
import UsersScreen from "./UsersScreen";
import { UpdateSection } from "../AppUpdate";

export default function SettingsScreen({ onDisconnect }: { onDisconnect: () => void }) {
  const nav = useNav();
  const { currentTheme, setTheme } = useAppStore();
  // WHO this device is comes from its pairing (the host's /me), never from a
  // pick-list. This screen used to show the desktop's local-profile marker and
  // let anyone "activate" anyone — a switch that changed labels and nothing
  // else, while hiding the real account and its devices one screen away.
  const { data: me, loading } = useAsync<MeResponse>(() => getMe(), []);

  return (
    <Screen title="Settings" onBack={nav.pop}>
      <SectionHeader>Appearance</SectionHeader>
      <div className="grid grid-cols-2 min-[700px]:grid-cols-4 gap-2 px-4">
        {Object.entries(themes).map(([key, theme]) => (
          <button
            key={key}
            onClick={() => setTheme(key)}
            aria-pressed={currentTheme === key}
            className="gm-chip gm-chip-card"
          >
            {/* The theme in miniature: its crust, accent and gold. */}
            <span
              className="shrink-0 w-7 h-7 rounded flex items-center justify-center gap-0.5"
              style={{ background: theme.colors.crust, boxShadow: `inset 0 0 0 1px ${theme.colors.gold}55` }}
              aria-hidden="true"
            >
              <span className="w-2 h-2 rounded-full" style={{ background: theme.colors.primary }} />
              <span className="w-1.5 h-1.5 rotate-45" style={{ background: theme.colors.gold }} />
            </span>
            <span className="min-w-0">{theme.name}</span>
          </button>
        ))}
      </div>

      <SectionHeader>Account</SectionHeader>
      {loading && !me ? (
        <Spinner />
      ) : (
        <div className="px-4 space-y-2">
          <div className="g-card px-4 py-3 min-h-[60px] flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-medium truncate">{me ? me.user.full_name : "Not signed in"}</div>
              <div className="text-sm gm-mut truncate">
                {me ? `This device is paired as you${me.user.is_owner ? " · owner" : ""}` : "—"}
              </div>
            </div>
            <button onClick={() => nav.push(<AccountScreen onDisconnect={onDisconnect} />)} className="g-lnk min-h-[44px] text-sm shrink-0">
              Profile
            </button>
          </div>
          <button
            onClick={() => nav.push(<AccountScreen onDisconnect={onDisconnect} />)}
            className="w-full g-card px-4 py-3 min-h-[60px] flex items-center justify-between gap-3 text-left active:bg-surface-0"
          >
            <div className="min-w-0">
              <div className="font-medium">Your devices</div>
              <div className="text-sm gm-mut">Sign in on another phone, computer, or a Home Screen app — pair it with a code</div>
            </div>
            <span className="g-lnk text-sm shrink-0">Open <Chevron /></span>
          </button>
          {me?.user.is_owner && (
            <button
              onClick={() => nav.push(<UsersScreen />)}
              className="w-full g-card px-4 py-3 min-h-[60px] flex items-center justify-between gap-3 text-left active:bg-surface-0"
            >
              <div className="min-w-0">
                <div className="font-medium">People on this host</div>
                <div className="text-sm gm-mut">Everyone with an account here — add, edit, deactivate</div>
              </div>
              <span className="g-lnk text-sm shrink-0">Manage <Chevron /></span>
            </button>
          )}
        </div>
      )}

      {/* Android only (renders nothing elsewhere). */}
      <UpdateSection />

      <SectionHeader>Connection</SectionHeader>
      <div className="px-4 space-y-2">
        {/* A web client's host is the page origin (currentDaemonUrl), not the
            native app's remembered URL — reading the latter said "Not
            connected" on a screen you could only reach while connected. */}
        <div className="g-plain px-4 py-3 text-sm break-all tabular-nums">
          {currentDaemonUrl() ?? "Not connected"}
        </div>
        <Button
          full
          variant="danger"
          onClick={async () => {
            if (!(await confirmDialog(isWebClient() ? "Sign this device out of the host?" : "Disconnect from the host?"))) return;
            if (!isWebClient()) setDaemonBaseUrl("");
            onDisconnect();
          }}
        >
          {isWebClient() ? "Sign out" : "Disconnect"}
        </Button>
      </div>
      <p className="px-4 pt-6 text-[11px] gm-mut font-mono">build {buildLabel()}</p>
      <div className="h-8" />
    </Screen>
  );
}

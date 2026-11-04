import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { extractEnrollToken } from "../lib/invite.pure";
import QrScanner from "../components/QrScanner";
import { isStandaloneDisplay } from "../lib/shell";
import { buildLabel } from "../lib/build";
import {
  cancel as cancelScan,
  checkPermissions,
  Format,
  openAppSettings,
  requestPermissions,
  scan,
} from "@tauri-apps/plugin-barcode-scanner";
import ThemeProvider from "../components/ThemeProvider";
import {
  enrollDevice,
  getDaemonBaseUrl,
  getDeviceToken,
  getMe,
  inviteTokenFromUrl,
  subscribeDataPulse,
  isWebClient,
  parseInviteLink,
  setDeviceToken,
  setUnauthorizedHandler,
  isUnauthorized,
} from "../lib/daemon";
import { getGlobalActiveTimeEntry, stopTimeEntry } from "../lib/api";
import { DATA_PULSE_EVENT } from "../lib/livePulse";
import type { Task, TimeEntry } from "../types";
import { HeaderExtraContext, NavContext, TabBar, Torii, type Nav } from "./nav";
import { Bell } from "./screens/NotificationsScreen";
import { pullServerNotifications } from "../lib/notificationFeed";
import { useRailTabs } from "../store/railTabs";
import { Button, Field, Spinner, TextInput, errMsg } from "./ui";
import ProjectsScreen from "./screens/ProjectsScreen";
import CalendarScreen from "./screens/CalendarScreen";
import ContactsScreen from "./screens/ContactsScreen";
import ActivityScreen from "./screens/ActivityScreen";
import MoreScreen from "./screens/MoreScreen";
import UploadTray from "../components/UploadTray";
import { UpdateBanner } from "./AppUpdate";
import { watchApkUpdates } from "../lib/apkUpdate";

type TabKey = "projects" | "calendar" | "contacts" | "activity" | "more";

const TABS: { key: TabKey; label: string; icon: ReactNode }[] = [
  { key: "projects", label: "Projects", icon: <PathIcon d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /> },
  { key: "calendar", label: "Calendar", icon: <PathIcon d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /> },
  { key: "contacts", label: "Contacts", icon: <PathIcon d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /> },
  { key: "activity", label: "Activity", icon: <PathIcon d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" /> },
  { key: "more", label: "More", icon: <PathIcon d="M4 6h16M4 12h16M4 18h16" /> },
];

function PathIcon({ d }: { d: string }) {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d={d} />
    </svg>
  );
}

export default function MobileApp() {
  return (
    <ThemeProvider>
      <Gate />
    </ThemeProvider>
  );
}

/** Enrollment gate: pair this device (scan an enrollment QR) and verify the
 * device token, then render the shell. Re-enrolls on 401. */
function Gate() {
  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permDenied, setPermDenied] = useState(false);
  const [manual, setManual] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState(getDaemonBaseUrl() ?? "");
  const [code, setCode] = useState("");
  const scanCancelled = useRef(false);
  // "Not in" has three causes and they need three screens (see WebGate):
  // unreachable keeps the token and offers Retry — the pairing is intact, the
  // host is just asleep / offline / off-tailnet. Showing the pairing screen
  // here was the bug: the phone LOOKED disconnected, the owner re-paired, and
  // every "re-pair" minted another device token for a device that had one.
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  // Browser join: in-page QR scan (the native path uses the Tauri plugin).
  const [webScan, setWebScan] = useState(false);

  // A browser joiner (served by the daemon) has no camera plugin and no URL to
  // type — the daemon is this page's origin, and an invite link carries the token.
  const webClient = isWebClient();
  const inviteToken = inviteTokenFromUrl();
  const standalone = isStandaloneDisplay();
  // Whatever was pasted — bare code, invite/pairing link, or QR text — as a token.
  const pastedToken = extractEnrollToken(code);
  const originUrl = typeof window !== "undefined" ? window.location.origin : "";

  const probe = async () => {
    setChecking(true);
    setUnreachable(null);
    // A web client always probes (the daemon is its origin; a loopback owner
    // needs no token). The native app probes only once it has an enrolled URL.
    const hadToken = !!getDeviceToken();
    if (isWebClient() || (hadToken && getDaemonBaseUrl())) {
      try {
        await getMe();
        setConnected(true);
      } catch (e) {
        if (isUnauthorized(e)) {
          if (hadToken) setSignedOut(true); // the host rejected it; daemonFetch dropped the token
        } else {
          setUnreachable(errMsg(e)); // couldn't ask — token kept
        }
      }
    }
    setChecking(false);
  };

  useEffect(() => {
    // A 401 during normal use → token cleared → route back here, and say why.
    setUnauthorizedHandler(() => {
      setSignedOut(true);
      setConnected(false);
    });
    void probe();
    return () => setUnauthorizedHandler(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Belt-and-braces: if the gate unmounts mid-scan, drop the transparency class.
  useEffect(() => () => document.documentElement.classList.remove("qr-scanning"), []);

  const doEnroll = async (enrollUrl: string, token: string) => {
    setBusy(true);
    setError(null);
    try {
      const label = webClient ? "Ganban (browser)" : "Ganban mobile";
      await enrollDevice(enrollUrl, token, label, name.trim() || undefined);
      // Drop the consumed one-time token from the URL so it isn't bookmarked/reshared.
      if (webClient && typeof window !== "undefined") {
        window.history.replaceState({}, "", window.location.pathname);
      }
      setConnected(true);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const cleanupScan = () => {
    document.documentElement.classList.remove("qr-scanning");
    setScanning(false);
  };

  const handleScan = async () => {
    setError(null);
    setPermDenied(false);
    scanCancelled.current = false;
    try {
      let perm = await checkPermissions();
      if (perm !== "granted") perm = await requestPermissions();
      if (perm !== "granted") {
        setPermDenied(perm === "denied");
        setError("Camera permission is required to scan a pairing code.");
        return;
      }
      setScanning(true);
      document.documentElement.classList.add("qr-scanning");
      const res = await scan({ windowed: false, formats: [Format.QRCode] });
      cleanupScan();
      // Accept BOTH a JSON pairing payload and a plain invite URL (the QRs now
      // encode the URL so a phone camera can open them in a browser too).
      const payload = parseInviteLink(res?.content?.trim() ?? "");
      if (!payload) {
        setError("That QR isn't a Ganban pairing code — generate one from the desktop's Sync screen.");
        return;
      }
      await doEnroll(payload.u, payload.t);
    } catch (e) {
      cleanupScan();
      if (!scanCancelled.current) setError(errMsg(e));
    }
  };

  const stopScan = async () => {
    scanCancelled.current = true;
    try {
      await cancelScan();
    } catch {
      /* ignore */
    }
    cleanupScan();
  };

  // Transparent overlay shown while the native camera scans behind the webview.
  // The container must NOT be pointer-events-none, or the cancel controls become
  // untappable on some webviews — leaving the camera with no way out but killing
  // the app. Decorative bits are pointer-events-none; the buttons are tappable.
  if (scanning) {
    return (
      <div
        className="fixed inset-0 z-50 flex flex-col items-center justify-end"
        style={{ paddingBottom: "calc(5rem + env(safe-area-inset-bottom))" }}
      >
        <button
          onClick={stopScan}
          aria-label="Close scanner"
          className="absolute right-4 w-11 h-11 rounded-full bg-black/70 text-white text-2xl flex items-center justify-center"
          style={{ top: "calc(0.75rem + env(safe-area-inset-top))" }}
        >
          ✕
        </button>
        <div className="w-64 h-64 rounded-3xl border-4 border-white/80 pointer-events-none" />
        <p className="mt-6 mb-8 text-white/90 text-sm drop-shadow pointer-events-none">
          Point at the pairing code on your computer
        </p>
        <button onClick={stopScan} className="px-8 py-3 bg-black/80 text-white rounded-full text-lg">
          Cancel
        </button>
      </div>
    );
  }

  if (checking && !connected) {
    return (
      <div className="fixed inset-0 bg-mantle text-text flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!connected && unreachable) {
    const host = webClient ? originUrl : getDaemonBaseUrl() ?? "";
    return (
      <div
        className="fixed inset-0 bg-mantle text-text overflow-y-auto"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="max-w-md mx-auto p-6 space-y-4">
          <Torii className="w-12 h-12" />
          <h1 className="g-deco text-[22px] font-light text-gold" style={{ letterSpacing: "0.16em" }}>Can't reach your host</h1>
          <p className="text-xs gm-mut break-all">{host}</p>
          <p className="text-sm text-error break-words">{unreachable}</p>
          <p className="text-sm gm-mut">
            {getDeviceToken() ? "This phone is still paired — nothing to redo. " : ""}
            The host may be asleep or offline, or this phone may be off its network (is Tailscale connected?).
          </p>
          <Button full onClick={() => void probe()}>
            Retry
          </Button>
          {!webClient && (
            <button
              onClick={() => setUnreachable(null)}
              className="w-full text-sm gm-mut underline min-h-[44px]"
            >
              Pair with a different host instead
            </button>
          )}
        </div>
      </div>
    );
  }

  // Browser joiner: no camera/QR, no URL to type. They arrived from an invite
  // link (token in the URL) or paste an invite code, pick a name, and join.
  if (!connected && webClient) {
    return (
      <div
        className="fixed inset-0 bg-mantle text-text overflow-y-auto"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="max-w-md mx-auto p-6 space-y-4">
          <Torii className="w-12 h-12" />
          <h1 className="g-deco text-[22px] font-light text-gold" style={{ letterSpacing: "0.16em" }}>Join Ganban</h1>
          {signedOut && (
            <p className="text-sm text-warning bg-warning/10 border border-warning/30 rounded px-3 py-2">
              This device was signed out by the host — its access was revoked, or the account was removed. Pair again to continue.
            </p>
          )}
          {/* Launched from the Home Screen: a SEPARATE app to iOS with its own
              storage, so the Safari tab's sign-in isn't here and the invite it
              was born from is spent. Lead with that — it's the whole situation. */}
          {standalone && !inviteToken && (
            <div className="text-sm bg-primary/10 border border-primary/30 rounded px-3 py-2.5 space-y-1.5">
              <p className="font-medium text-text">This is Ganban from your Home Screen</p>
              <p className="gm-fg2">
                It's a separate app to your phone, so it signs in on its own — the invite you used in Safari was one-time. Pair it
                with a code:
              </p>
              <ol className="list-decimal pl-5 space-y-0.5 gm-fg2">
                <li>In Safari, open Ganban → <span className="text-text">Account → Your devices → Pair another device</span>.</li>
                <li>Tap <span className="text-text">Copy</span> next to the code.</li>
                <li>Come back here and paste it below.</li>
              </ol>
            </div>
          )}
          <p className="text-sm gm-mut">
            {inviteToken
              ? "You've been invited to a Ganban project. Pick a name and join — nothing to install."
              : "Paste the code or link you were given — an invite from the project owner, or a pairing code from a device where you're already signed in."}
          </p>
          <Field label="Your name (shown to the team)">
            <TextInput value={name} onChange={setName} placeholder="e.g. Sam" />
          </Field>
          {!inviteToken && (
            <Field label="Invite or pairing code (a link works too)">
              <div className="flex gap-2">
                <div className="flex-1 min-w-0">
                  <TextInput value={code} onChange={setCode} placeholder="paste the code or link" />
                </div>
                <button
                  onClick={() => setWebScan(true)}
                  className="g-btn g-btn-ghost shrink-0 min-h-[44px] px-3 text-sm"
                  title="Scan the QR code the owner is showing you"
                >
                  Scan QR
                </button>
              </div>
            </Field>
          )}
          {!inviteToken && code.trim() && !pastedToken && (
            <p className="text-sm text-error">That doesn't look like a code or a Ganban link.</p>
          )}
          {webScan && (
            <QrScanner
              onClose={() => setWebScan(false)}
              onResult={(text) => {
                setWebScan(false);
                const t = extractEnrollToken(text);
                if (!t) {
                  setCode(text);
                  setError("That QR isn't a Ganban invite or pairing code.");
                  return;
                }
                setCode(t);
                void doEnroll(originUrl, t);
              }}
            />
          )}
          <Button
            full
            onClick={() => doEnroll(originUrl, inviteToken ?? pastedToken ?? "")}
            disabled={busy || (!inviteToken && !pastedToken)}
          >
            {busy ? "Joining…" : "Join"}
          </Button>
          {error && <p className="text-sm text-error">{error}</p>}
          {/* The way back in — a device token is per-device, the account is
              on the host. */}
          <div className="pt-4 border-t border-gilt-b space-y-1.5 text-sm gm-mut">
            <p className="gm-fg2 font-medium">Already a member?</p>
            <p>
              On a device where you're still signed in, go to <span className="text-text">Account → Your devices → Pair another device</span> and
              paste that code above. You'll be you — same projects, same history.
            </p>
            {!standalone && <p>Added Ganban to your Home Screen? It has its own sign-in — pair it with a code from your Safari tab.</p>}
            <p>
              No signed-in device left? Ask the host's owner — <span className="text-text">Members → you → Pair a device</span> (or Contacts). It
              signs you in as your existing account.
            </p>
          </div>
          <div className="pt-4 border-t border-gilt-b">
            <a href="/download" className="text-sm text-primary underline">
              On a computer? Get the full desktop app →
            </a>
          </div>
          <p className="text-[10px] font-mono gm-mut opacity-70">build {buildLabel()}</p>
        </div>
      </div>
    );
  }

  if (!connected) {
    return (
      <div
        className="fixed inset-0 bg-mantle text-text overflow-y-auto"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="max-w-md mx-auto p-6 space-y-4">
          <h1 className="g-deco text-[22px] font-light text-gold" style={{ letterSpacing: "0.16em" }}>Join Ganban</h1>
          {signedOut && (
            <p className="text-sm text-warning bg-warning/10 border border-warning/30 rounded px-3 py-2">
              This phone was signed out by the host — its access was revoked, or the account was removed. Pair again to continue.
            </p>
          )}
          <p className="text-sm gm-mut">
            On the desktop, open <span className="gm-fg2">Sync → Host this device</span>, then
            <span className="gm-fg2"> Pair a phone</span> (or an invite), and scan the code.
          </p>
          <Field label="Your name (shown to the team)">
            <TextInput value={name} onChange={setName} placeholder="e.g. Sam" />
          </Field>
          <Button full onClick={handleScan}>
            Scan pairing code
          </Button>
          {permDenied && (
            <Button full variant="surface" onClick={() => openAppSettings()}>
              Open app settings
            </Button>
          )}
          <button onClick={() => setManual((m) => !m)} className="w-full text-center text-sm gm-mut underline min-h-[44px]">
            {manual ? "Hide manual entry" : "Enter a code manually"}
          </button>
          {manual && (
            <div className="space-y-3">
              <Field label="Daemon URL">
                <TextInput value={url} onChange={setUrl} placeholder="http://100.x.y.z:8765" type="url" />
              </Field>
              <Field label="Pairing code (a link works too)">
                <TextInput value={code} onChange={setCode} placeholder="paste the code or link" />
              </Field>
              <Button full variant="surface" onClick={() => doEnroll(url, pastedToken ?? "")} disabled={busy || !url.trim() || !pastedToken}>
                {busy ? "Joining…" : "Join"}
              </Button>
            </div>
          )}
          {error && <p className="text-sm text-error">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <Shell
      onDisconnect={() => {
        setDeviceToken(null);
        setConnected(false);
      }}
    />
  );
}

function Shell({ onDisconnect }: { onDisconnect: () => void }) {
  const [tab, setTab] = useState<TabKey>("projects");
  // Marks the page as the phone shell for mobile.css (shared Modals at touch
  // size). A class on <html>, not body:has(.gm-app): WebKit re-checks :has()
  // on body after DOM changes, on the desktop too.
  useLayoutEffect(() => {
    document.documentElement.classList.add("gm-mobile");
    return () => document.documentElement.classList.remove("gm-mobile");
  }, []);
  // Freshness push (G3): Shell mounts once per successful connect, so this is
  // the lifetime of the session. Debounced host pulses become a window event
  // that every mounted useAsync loader answers with a silent background reload.
  useEffect(() => {
    let t: number | undefined;
    let firstPulseAt = 0;
    // Carry the server's "what changed" kind in the event detail so future
    // mobile subscribers can filter (desktop already does via useDataPulse).
    // Mobile's useAsync currently listens to the bare event and refetches
    // wholesale — backward-compatible.
    let pendingKind: string | undefined;
    const fire = () => {
      firstPulseAt = 0;
      window.dispatchEvent(new CustomEvent(DATA_PULSE_EVENT, { detail: { kind: pendingKind ?? 'lagged' } }));
      pendingKind = undefined;
    };
    const kick = (what?: string) => {
      // Live agent work changes no data, and the phone has no timer dropdown.
      if (what === 'agents') return;
      // Trailing debounce with a max-wait: a sustained write burst must not
      // defer the refetch until it ends.
      const now = Date.now();
      if (!firstPulseAt) firstPulseAt = now;
      if (what) pendingKind = what;
      window.clearTimeout(t);
      if (now - firstPulseAt >= 2500) fire();
      else t = window.setTimeout(fire, 800);
    };
    // Refetch on (re)connect only if pulses may have been missed (not on the
    // host's routine stream renewal — that refetch made the UI flash).
    const unsub = subscribeDataPulse(kick, (info) => {
      if (info.missed) kick();
    });
    return () => {
      window.clearTimeout(t);
      unsub();
    };
  }, []);
  // The phone's self-update (Android only): check at launch and on resume.
  useEffect(() => watchApkUpdates(), []);
  // The bell: the host's notifications (mentions, the weekly bank-import reminder), pulled like the
  // desktop's notification center does, and again when the app comes back to the front. Also the
  // signed-in user's rail switches, so a notification can open Finance from any tab.
  useEffect(() => {
    void pullServerNotifications();
    getMe()
      .then((me) => useRailTabs.getState().load(me.user.id))
      .catch(() => {});
    const t = window.setInterval(() => void pullServerNotifications(), 60000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void pullServerNotifications();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  const [stack, setStack] = useState<{ id: number; node: ReactNode }[]>([]);
  const idRef = useRef(0);
  const stackLenRef = useRef(0);
  stackLenRef.current = stack.length;
  const [exitArmed, setExitArmed] = useState(false);

  // Hardware/browser back: the nav stack mirrors into webview history, so
  // Android's back button pops a screen instead of finishing the activity
  // (the history used to stay empty — back at ANY depth exited the app).
  // History layout: [exit guard] [depth 0 = tabs] [depth 1] … — back at the
  // tabs lands on the guard ("press back again to exit"); a second press
  // within the window leaves genuinely empty history, which Android treats
  // as exit. Browsers get the same screen-popping for free.
  useEffect(() => {
    const st = window.history.state as { depth?: number; exitGuard?: boolean } | null;
    if (st?.depth != null || st?.exitGuard) {
      // Re-mount over our own entries (dev reload): reset to the steady state.
      window.history.replaceState({ depth: 0 }, "");
    } else {
      window.history.replaceState({ exitGuard: true }, "");
      window.history.pushState({ depth: 0 }, "");
    }
    const onPop = (e: PopStateEvent) => {
      const s = e.state as { depth?: number; exitGuard?: boolean } | null;
      if (s?.exitGuard) {
        setStack([]);
        setExitArmed(true);
        window.setTimeout(() => {
          setExitArmed(false);
          // Still parked on the guard → the user stayed; restore steady state.
          const cur = window.history.state as { exitGuard?: boolean } | null;
          if (cur?.exitGuard) window.history.pushState({ depth: 0 }, "");
        }, 2000);
        return;
      }
      const depth = s?.depth ?? 0;
      setStack((cur) => (depth < cur.length ? cur.slice(0, depth) : cur));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const nav: Nav = {
    push: (node) => {
      window.history.pushState({ depth: stackLenRef.current + 1 }, "");
      setStack((s) => [...s, { id: ++idRef.current, node }]);
    },
    // Route pops THROUGH history so hardware back and the ‹ button stay in
    // lockstep — the popstate handler does the actual stack trim.
    pop: () => window.history.back(),
    popToRoot: () => {
      if (stackLenRef.current > 0) window.history.go(-stackLenRef.current);
    },
  };

  const renderTab = (t: TabKey) => {
    switch (t) {
      case "projects":
        return <ProjectsScreen />;
      case "calendar":
        return <CalendarScreen />;
      case "contacts":
        return <ContactsScreen />;
      case "activity":
        return <ActivityScreen />;
      case "more":
        return <MoreScreen onDisconnect={onDisconnect} />;
    }
  };

  return (
    <NavContext.Provider value={nav}>
      <HeaderExtraContext.Provider value={<Bell />}>
      <div className="gm-app fixed inset-0 flex flex-col bg-mantle">
        <div className="flex-1 min-h-0 relative">
          {/* Active tab root stays mounted (just hidden) while a stack is open. */}
          <div key={tab} className={`absolute inset-0 ${stack.length ? "invisible" : ""}`}>
            {renderTab(tab)}
          </div>
          {stack.map((s, i) => (
            <div key={s.id} className={`absolute inset-0 ${i === stack.length - 1 ? "" : "invisible"}`}>
              {s.node}
            </div>
          ))}
          {exitArmed && (
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 bg-crust border border-gilt-a text-text text-sm rounded shadow-lg z-50 whitespace-nowrap">
              Press back again to exit
            </div>
          )}
        </div>

        <UpdateBanner />
        <ActiveTimerBar />
        <UploadTray mobile />

        <TabBar
          tabs={TABS}
          current={tab}
          onSelect={(k) => {
            setStack([]);
            setTab(k);
          }}
        />
      </div>
      </HeaderExtraContext.Provider>
    </NavContext.Provider>
  );
}

/** Global running-timer bar: polls the active time entry and lets you stop it. */
function ActiveTimerBar() {
  const [active, setActive] = useState<{ entry: TimeEntry; task: Task } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = async () => {
    try {
      const res = (await getGlobalActiveTimeEntry()) as unknown;
      // The daemon/Tauri serialize Option<(TimeEntry, Task)> as [entry, task].
      if (Array.isArray(res) && res.length === 2) {
        setActive({ entry: res[0] as TimeEntry, task: res[1] as Task });
      } else if (res && typeof res === "object" && "entry" in (res as any)) {
        setActive(res as { entry: TimeEntry; task: Task });
      } else {
        setActive(null);
      }
    } catch {
      /* ignore polling errors */
    }
  };

  useEffect(() => {
    load();
    const poll = setInterval(load, 5000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  if (!active) return null;

  const started = new Date(active.entry.start_time).getTime();
  const elapsed = Math.max(0, Math.floor((now - started) / 1000));
  const hh = Math.floor(elapsed / 3600);
  const mm = Math.floor((elapsed % 3600) / 60);
  const ss = elapsed % 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  const stop = async () => {
    try {
      await stopTimeEntry(active.entry.id);
    } catch {
      /* ignore */
    }
    setActive(null);
    load();
  };

  return (
    <div className="flex items-center gap-3 pl-4 pr-2 py-1 bg-crust border-t border-success/40 text-text">
      <span className="w-2.5 h-2.5 rounded-full bg-success g-pulse" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{active.task.title}</div>
        <div className="text-xs text-success tabular-nums">
          {pad(hh)}:{pad(mm)}:{pad(ss)}
        </div>
      </div>
      <button onClick={stop} className="g-btn g-btn-danger g-btn-sm min-h-[44px] active:bg-error/10">
        Stop
      </button>
    </div>
  );
}

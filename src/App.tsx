import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { confirmDialog } from './lib/confirm';
import ProjectView from "./components/ProjectView";
import ProjectsOverview from "./components/ProjectsOverview";
import HomeBoard from "./components/HomeBoard";
import BinView from "./components/BinView";
import ReportGenerator from "./components/ReportGenerator";
import CalendarView from "./components/CalendarView";
import ContactsView from "./components/ContactsView";
import ThemeProvider from "./components/ThemeProvider";
import { openAppWindow } from "./lib/windows";
import ProfileGate from "./components/ProfileGate";
import FirstRunScreen from "./components/FirstRunScreen";
import AtlasView from "./components/AtlasView";
import SettingsModal from "./components/SettingsModal";
import { OPEN_SETTINGS, type SettingsSection } from "./lib/settingsNav";
import ActiveTaskWidget from "./components/ActiveTaskWidget";
import { refreshAgentWork } from "./lib/timer";
import ProjectSettingsModal from "./components/ProjectSettingsModal";
import JoinServerModal from "./components/JoinServerModal";
import AreaManager from "./components/AreaManager";
import TopBarClock from "./components/TopBarClock";
import UpdateReadyNotice from "./components/UpdateReadyNotice";
import SearchBar from "./components/SearchBar";
import NotificationSystem from "./components/NotificationSystem";
import AgentPulse from "./components/AgentPulse";
import NotificationCenter from "./components/NotificationCenter";
import ChatView from "./components/ChatView";
import ProfileModal from "./components/ProfileModal";
import DetailPane, { useDetailStack } from "./components/DetailPane";
import PinnedTabs, { PinnedTabsManager } from "./components/PinnedTabs";
import { applySubView, labelOf, usePins, type Pin } from "./store/pins";
import { openPinnedTabWindow } from "./lib/windows";
import { useAppStore, sameProject } from "./store/appStore";
import { listWorkspaces, getWorkspace, getActiveWorkspaceId, setActiveWorkspace, setLocalUrl, workspacesEnabled, removeWorkspace, LOCAL_ID } from "./lib/workspaces";
import { wsGetProjects, wsGetAreas, wsGetTasks, wsGetEvents, wsToggleProjectPin, wsArchiveProject, wsDeleteProject } from "./lib/workspaceData";
import { getActiveUsers, getUser, createProject, getAppSetting } from "./lib/api";
import { syncEnabledProjects } from "./lib/fileSync";
import { getMe, isDesktopOnline, isTauri, isMobilePlatform, hasDaemon, listPendingProposals, subscribeDataPulse, isHostedClient, type PulseOpen } from "./lib/daemon";
import type { PulseKind } from "./lib/livePulse";
import { daemonStatus } from "./lib/host";
import { aiEngineStatus } from "./lib/aiEngine";
import { notify } from "./store/notifications";
import { DATA_PULSE_EVENT } from "./lib/livePulse";
import type { Project, User } from "./types";
import { PaneHandle, ResizablePane, useResizableWidth, usePaneCollapsed } from "./components/gilt";
import ScrollArea from "./components/ScrollArea";
import NavButtons from "./components/NavButtons";
import { useNav } from "./store/navHistory";
import { useGotoTaskMessages } from "./lib/gotoTask";
import { useTitleBarInset } from "./lib/titleBar";
import RailProjectsMenu from "./components/RailProjectsMenu";
import { RailNavButtons, RailViewHost, isRailView, useShownRails } from "./components/RailViews";
import { useRailTabs } from "./store/railTabs";
import { projectColorClass, projectInitial } from "./lib/projectColor";

/** `rail:<id>` is a tab module's own top-level view (src/components/RailViews.tsx). */
type View = 'projects' | 'home' | 'bin' | 'reports' | 'events' | 'contacts' | 'chat' | 'atlas' | `rail:${string}`;

// ── Gilt frame helpers (top bar + sidebar) ──────────────────────────────────

/** A top-bar button (the prototype's `.tb`), and its open state. */
const TB = 'inline-flex items-center gap-[7px] min-h-[38px] px-2.5 rounded text-sm text-subtext-0 hover:bg-surface-0 hover:text-text transition-colors shrink-0';
const TB_OPEN = 'bg-surface-0 text-text';
/** A sidebar section label (the prototype's `.sh`). */
const SECTION_LABEL = 'g-deco flex items-center gap-2 w-full min-h-[30px] px-3 text-[11px] font-semibold text-subtext-0';
/** The top bar's fit: the title keeps about 8 characters before anything else goes. */
const TITLE_MIN_PX = 64;
/** Squeeze steps: 1 counts → Overview, 2 host stats hide, 3 clock hides, 4 wordmark hides. */
const MAX_SQUEEZE = 4;

const NAV: { view: View; label: string; d: string }[] = [
  { view: 'home', label: 'Home', d: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6' },
  { view: 'projects', label: 'Projects', d: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z' },
  { view: 'events', label: 'Events', d: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z' },
  { view: 'atlas', label: 'Atlas', d: 'M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7' },
  { view: 'chat', label: 'Assistant', d: 'M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z' },
  { view: 'contacts', label: 'Contacts', d: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z' },
  { view: 'reports', label: 'Reports', d: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
  { view: 'bin', label: 'Bin', d: 'M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4' },
];

function NavIcon({ d }: { d: string }) {
  return (
    <svg className="w-[18px] h-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** The sidebar's collapse / expand button (also Cmd/Ctrl+B). */
function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = `${collapsed ? 'Expand' : 'Collapse'} the sidebar (${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}B)`;
  return (
    <button onClick={onToggle} className={`g-iconbtn shrink-0 ${collapsed ? '' : 'ml-auto'}`} style={{ width: 32, height: 32 }} title={label} aria-label={label}>
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3.5" y="4.5" width="17" height="15" rx="1.5" />
        <path d="M9 4.5v15" />
        <path d={collapsed ? 'M13 10l2 2-2 2' : 'M15.5 10l-2 2 2 2'} />
      </svg>
    </button>
  );
}


function App() {
  const [currentView, setCurrentView] = useState<View>('home');
  // Global right-hand detail drawer driven by search results (works from any view).
  const searchDetail = useDetailStack({ scope: 'search' });
  // The search drawer shares the side pane's width (docs/dev/GILT.md).
  const sidePane = useResizableWidth('side-pane', { side: 'right', min: 340, max: 900, defaultWidth: 420 });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  // The section an openSettings(section) call asked for; cleared on close.
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentUserId, setCurrentUserId] = useState<number | null>(() => {
    const stored = localStorage.getItem('currentUserId');
    return stored ? parseInt(stored, 10) : null;
  });
  const [totalProjectsCount, setTotalProjectsCount] = useState(0);
  const [totalAreasCount, setTotalAreasCount] = useState(0);
  const [totalTasksCount, setTotalTasksCount] = useState(0);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const overviewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!overviewOpen) return;
    const onDown = (e: MouseEvent) => {
      if (overviewRef.current && !overviewRef.current.contains(e.target as Node)) setOverviewOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [overviewOpen]);
  const [totalEventsCount, setTotalEventsCount] = useState(0);
  const [clickTimer, setClickTimer] = useState<number | null>(null);
  // Composite key string ('workspace:id'), not a bare id — ids collide across workspaces (K2).
  const [sidebarOpenMenuProjectId, setSidebarOpenMenuProjectId] = useState<string | null>(null);
  const [isProjectSettingsOpen, setIsProjectSettingsOpen] = useState(false);
  const [isAreaManagerOpen, setIsAreaManagerOpen] = useState(false);
  const [isEventDropdownOpen, setIsEventDropdownOpen] = useState(false);
  const [menuProject, setMenuProject] = useState<Project | null>(null);
  const [isSidebarCreating, setIsSidebarCreating] = useState(false);
  const [isJoinOpen, setIsJoinOpen] = useState(false);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [wsTick, setWsTick] = useState(0); // bumps when the active workspace changes via the switcher
  const [sidebarNewProjectName, setSidebarNewProjectName] = useState('');
  const sidebarMenuRef = useRef<HTMLDivElement>(null);
  // Global badge: how many agent write proposals await the user's decision.
  const [pendingProposalCount, setPendingProposalCount] = useState(0);
  const { setProjects, selectProject, selectedProject, projects, setHomeBoardProjectFilter, updateProject, removeProject, addProject, activeTask } = useAppStore();

  // Back/forward (store/navHistory): record each view and project switch, and
  // apply a back/forward's landing. The project's tab and the panes report
  // themselves (ProjectView, useDetailStack).
  const navProjectKey = currentView === 'projects' && selectedProject ? `${selectedProject.workspaceId ?? LOCAL_ID}:${selectedProject.id}` : null;
  useEffect(() => {
    useNav.getState().visitView(currentView, navProjectKey);
  }, [currentView, navProjectKey]);
  const restoreSeq = useNav((s) => s.restore?.seq ?? 0);
  useEffect(() => {
    const entry = useNav.getState().restore?.entry;
    if (!restoreSeq || !entry) return;
    if (entry.view === 'projects') {
      const project = entry.projectKey
        ? useAppStore.getState().projects.find((p) => `${p.workspaceId ?? LOCAL_ID}:${p.id}` === entry.projectKey) ?? null
        : null;
      if (project && entry.tab) usePins.getState().setOpenIntent({ projectKey: entry.projectKey!, tab: entry.tab, remount: false });
      selectProject(project);
    }
    setOverviewOpen(false);
    setCurrentView(entry.view as View);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreSeq]);
  // "Open in Project > Tasks" from a task window or a pinned tab's window.
  useGotoTaskMessages();
  // macOS: room for the traffic lights over the top bar's left end.
  const titleInset = useTitleBarInset();

  // Keep the proposal badge fresh: poll lightly, and refresh on view changes so
  // resolving from chat or the Activity view updates the count promptly.
  useEffect(() => {
    if (!hasDaemon()) return;
    const update = () => listPendingProposals().then((p) => setPendingProposalCount(p.length)).catch(() => {});
    update();
    const timer = window.setInterval(update, 60_000);
    // Resolving a proposal from the notification popover announces itself so
    // the badges drop immediately instead of on the next poll.
    window.addEventListener('ganban:proposals-changed', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('ganban:proposals-changed', update);
    };
  }, [currentView]);

  // Load projects on app start
  useEffect(() => {
    loadProjects();
  }, []);

  // Kill the webview's default context menu (Reload / Inspect Element —
  // meaningless to users) EVERYWHERE except editable fields, where the native
  // menu is the copy/paste surface. Surfaces that offer a custom menu
  // (useContextMenu) call preventDefault themselves before this sees it.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', onCtx);
    return () => document.removeEventListener('contextmenu', onCtx);
  }, []);

  // Freshness: data changed elsewhere (a phone, a teammate) used to stay
  // invisible until restart — the app fetched once on mount and never again.
  // Two levers: window focus refetches the project list when it's gone stale
  // (cheap, keeps the sidebar honest), and the notification hub's Refresh
  // button forces a full re-pull by remounting the active view (views refetch
  // on mount).
  const [viewNonce, setViewNonce] = useState(0);
  const lastFocusRefresh = useRef(Date.now());
  useEffect(() => {
    const onFocus = () => {
      if (Date.now() - lastFocusRefresh.current < 45_000) return;
      lastFocusRefresh.current = Date.now();
      void loadProjects();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Launch report: the owner shouldn't run pre-flight checks by hand. Engines
  // take up to ~25s to autostart on a cold boot (ragrat's connection setting
  // is only written once it answers), so poll with a grace window: report
  // success the moment everything expected is up, red-alert only after the
  // window closes. Engines are "expected" only when their autostart flag is
  // on — a host that deliberately runs no engines stays green. Silence for
  // plain non-hosting, engines-off sessions.
  useEffect(() => {
    if (!isTauri() || isMobilePlatform() || isDesktopOnline()) return;
    let cancelled = false;
    let t: number | undefined;
    const start = Date.now();
    const probe = async () => {
      if (cancelled) return;
      const [ds, es, auto, vision, giphy] = await Promise.all([
        daemonStatus().catch(() => null),
        aiEngineStatus().catch(() => null),
        getAppSetting('ai_engines_autostart').catch(() => null),
        getAppSetting('rag_vision').catch(() => null),
        getAppSetting('giphy_api_key').catch(() => null),
      ]);
      if (cancelled) return;
      const hosting = !!ds?.running && !ds.loopback;
      const expectEngines = auto === '1';
      const ollamaUp = !!es?.ollama.running;
      const ragratUp = !!es?.ragrat.running;
      // ragrat is optional: on a machine without it, it isn't "down".
      const expectRagrat = expectEngines && !!es?.ragrat.found;
      const settled = !expectEngines || (ollamaUp && (ragratUp || !expectRagrat));
      if (!settled && Date.now() - start < 60_000) {
        t = window.setTimeout(() => void probe(), 5_000);
        return;
      }
      if (!hosting && !ollamaUp && !ragratUp) return;
      const parts = [
        hosting
          ? `hosting at ${ds?.urls?.[0] ?? `port ${ds?.port}`}`
          : ds?.running
            ? 'serving this machine only'
            : 'daemon down',
        expectEngines || ollamaUp ? (ollamaUp ? 'Ollama ✓' : 'Ollama ✗') : null,
        expectRagrat || ragratUp
          ? ragratUp
            ? `ragrat ✓${es?.ragrat.workers ? ` (${es.ragrat.workers} worker${es.ragrat.workers === 1 ? '' : 's'})` : ''}`
            : 'ragrat ✗'
          : null,
      ].filter(Boolean);
      // Host-side feature settings — shown so "did the rebuild keep them?" is
      // answerable at a glance (they live in the HOST DB, not the binary).
      let visionModel: string | null = null;
      try {
        visionModel = vision ? (JSON.parse(vision).model ?? null) : null;
      } catch {
        /* unparseable = unset */
      }
      parts.push(`vision: ${visionModel || 'off'}`);
      parts.push(`GIF search: ${giphy?.trim() ? 'on' : 'off'}`);
      const engineDown = expectEngines && (!ollamaUp || (expectRagrat && !ragratUp));
      notify({
        kind: engineDown ? 'error' : 'success',
        category: 'system',
        title: hosting ? (engineDown ? 'Host online — an engine is down' : 'Host online') : 'Engines online',
        body: parts.join(' · ') + (engineDown ? ' — Settings → AI Engines → Start engines' : ''),
      });
    };
    t = window.setTimeout(() => void probe(), 5_000);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, []);

  const refreshAll = () => {
    lastFocusRefresh.current = Date.now();
    void loadProjects();
    setViewNonce((n) => n + 1);
  };

  // Freshness ceiling (G3): the host pulses after every write, so a task
  // created on a phone appears here without anyone pressing anything.
  // Debounced (trailing, with a max-wait so a sustained write burst can't
  // defer the refetch forever), then: refetch the project list and ping views
  // that opted in (useDataPulse). Deliberately NOT refreshAll() — the
  // viewNonce remount would destroy unsaved form state mid-edit. Reconnects
  // refetch once, to cover whatever changed while the stream was down. If the
  // embedded daemon isn't up yet at mount (fresh install, or hosting started
  // later from Sync), keep retrying the subscription instead of giving up.
  useEffect(() => {
    let t: number | undefined;
    let retry: number | undefined;
    let firstPulseAt = 0;
    const unsubs: (() => void)[] = [];
    // Carry the server-reported "what changed" kind through to subscribers so a
    // view can skip pulses it doesn't care about (a comment edit no longer
    // refetches the Calendar). The kind is coarse (tasks/events/comments/… —
    // see events::invoke_pulse_kind), never a payload. Coalesce by LATEST kind:
    // a burst that starts with a task write and ends with a comment write fires
    // once with whatever came last; the max-wait floor ensures a sustained
    // burst can't defer the refetch forever. Subscribers without a predicate
    // still refetch on everything (backward-compatible).
    let pendingKind: PulseKind = 'lagged';
    const fire = () => {
      firstPulseAt = 0;
      lastFocusRefresh.current = Date.now();
      void loadProjects();
      window.dispatchEvent(new CustomEvent(DATA_PULSE_EVENT, { detail: { kind: pendingKind } }));
      pendingKind = 'lagged';
    };
    // Live agent work changes no data: it refreshes the timer's "Agents" only, and
    // must not stand in for a data pulse in the debounce below.
    let agentsT: number | undefined;
    // Throttled, not debounced: a run touching tasks quickly still shows them.
    const agentsChanged = () => {
      if (agentsT !== undefined) return;
      agentsT = window.setTimeout(() => {
        agentsT = undefined;
        void refreshAgentWork();
      }, 300);
    };
    const kick = (what?: string) => {
      if (what === 'agents') return agentsChanged();
      const now = Date.now();
      if (!firstPulseAt) firstPulseAt = now;
      // Stash the latest kind for the debounced fire. Unknown/empty kinds fall
      // back to 'lagged' (= "refetch wholesale"), which is the safe default.
      if (what) pendingKind = what as PulseKind;
      window.clearTimeout(t);
      if (now - firstPulseAt >= 2500) fire();
      else t = window.setTimeout(fire, 800);
    };
    // (Re)connects refetch only when pulses may have been missed — not on the
    // host's routine 10-minute stream renewal (that wholesale refetch was the
    // periodic UI flash).
    const onOpen = (info: PulseOpen) => {
      if (info.missed) {
        kick();
        agentsChanged();
      }
    };
    const subscribeAll = async () => {
      if (workspacesEnabled()) {
        // Desktop, K2 Stage C: ONE stream per workspace, each to its own host
        // with its own token. A pulse from any host triggers the same debounced
        // re-merge. Ensure the local loopback URL is known first (daemon
        // discovery), retrying until it is.
        if (!listWorkspaces().find((w) => w.id === LOCAL_ID)?.url) {
          const st = await daemonStatus().catch(() => null);
          if (st?.running && st.port) setLocalUrl(`http://127.0.0.1:${st.port}`);
        }
        const wss = listWorkspaces().filter((w) => w.url);
        if (wss.length === 0) {
          retry = window.setTimeout(() => void subscribeAll(), 15_000);
          return;
        }
        for (const ws of wss) {
          unsubs.push(subscribeDataPulse(kick, onOpen, { url: ws.url, token: ws.token }));
        }
      } else {
        // Mobile/web: single host via the active-transport globals (unchanged).
        if (!hasDaemon()) {
          retry = window.setTimeout(() => void subscribeAll(), 15_000);
          return;
        }
        unsubs.push(subscribeDataPulse(kick, onOpen));
      }
    };
    void subscribeAll();
    return () => {
      window.clearTimeout(t);
      window.clearTimeout(retry);
      window.clearTimeout(agentsT);
      unsubs.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Decide who's at the keyboard before rendering as anyone. The stored id is
  // validated (a deactivated/deleted profile must not be silently resumed) and
  // a PIN-protected profile must be unlocked — previously the app just woke up
  // as whoever used it last.
  const [gate, setGate] = useState<'loading' | 'locked' | 'open'>(isHostedClient() ? 'open' : 'loading');
  const [gateUsers, setGateUsers] = useState<User[]>([]);
  // Fresh install = no remembered identity AND no transport choice ever made.
  const [firstRun, setFirstRun] = useState<boolean>(() => {
    try {
      return (
        !localStorage.getItem('ganban-first-run-done') &&
        !localStorage.getItem('currentUserId') &&
        !localStorage.getItem('ganban-transport-mode')
      );
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (isHostedClient()) return; // identity = the device token; no local gate
    (async () => {
      try {
        const users = await getActiveUsers();
        const stored = users.find((u) => u.id === currentUserId) ?? null;
        if (!stored && currentUserId !== null) {
          // Stale id (deactivated or deleted profile) — drop it.
          localStorage.removeItem('currentUserId');
          setCurrentUserId(null);
        }
        if (stored && !stored.has_pin) {
          setGate('open');
          return;
        }
        if (!stored && users.length === 1 && !users[0].has_pin) {
          setCurrentUserId(users[0].id);
          setGate('open');
          return;
        }
        setGateUsers(users);
        setGate(users.length === 0 ? 'open' : 'locked');
      } catch (error) {
        console.error('Failed to load users for the profile gate:', error);
        setGate('open'); // never brick the app on a read failure
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist current user ID to localStorage
  useEffect(() => {
    if (currentUserId !== null) {
      localStorage.setItem('currentUserId', currentUserId.toString());
    }
  }, [currentUserId]);

  // Load the current user's record (for the top-bar avatar + profile editor).
  // K2: identity is PER-HOST — "me" on a remote host is the device-token user
  // there, while local is the owner. So this must re-run whenever the ACTIVE
  // workspace changes (a project selection on another host, or the switcher),
  // not only when currentUserId changes — otherwise the avatar/profile goes
  // stale showing the previous host's identity.
  const reloadCurrentUser = () => {
    // Hosted client (online desktop, or a browser served by the host): "me" is
    // whoever the device token authenticates as on that host.
    if (isHostedClient()) {
      // The laptop routinely relaunches FASTER than the host (a reboot, a git
      // pull restart) — one failed /me left the avatar broken until a manual
      // refresh. Retry with backoff until the host answers.
      const attempt = (delayIdx: number) => {
        getMe()
          .then((me) => setCurrentUser(me.user as unknown as User))
          .catch((e) => {
            setCurrentUser(null);
            console.error('Profile load (/me) failed on the active host:', e);
            const delays = [3000, 8000, 20000, 45000];
            if (delayIdx < delays.length) setTimeout(() => attempt(delayIdx + 1), delays[delayIdx]);
          });
      };
      attempt(0);
      return;
    }
    if (currentUserId == null) {
      setCurrentUser(null);
      return;
    }
    getUser(currentUserId).then(setCurrentUser).catch(() => {});
  };
  useEffect(() => {
    reloadCurrentUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId, selectedProject?.workspaceId, wsTick]);

  // Tab modules' rail views: the host's tabs and this user's Plug-ins switches.
  const railUserId = isHostedClient() ? currentUser?.id ?? null : currentUserId;
  useEffect(() => {
    void useRailTabs.getState().load(railUserId);
  }, [railUserId]);
  // A rail view that was switched off (or a back step to one) lands on Home.
  const shownRails = useShownRails();
  const railsLoaded = useRailTabs((s) => s.hostTabs !== null);
  useEffect(() => {
    if (!currentView.startsWith('rail:') || !railsLoaded) return;
    if (!isRailView(currentView) || !shownRails.some((m) => `rail:${m.id}` === currentView)) setCurrentView('home');
  }, [currentView, shownRails, railsLoaded]);

  // The sidebar's collapsed (icon rail) state, stored with its width.
  const sidebar = usePaneCollapsed('sidebar');
  // Whether the expanded sidebar's "Projects" section is open: a cosmetic,
  // per-device preference (docs/dev/TAB_SPEC.md allows localStorage for these).
  const [sidebarRestOpen, setSidebarRestOpen] = useState(() => {
    try { return localStorage.getItem('ganban.sidebar.projectsOpen') !== '0'; } catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('ganban.sidebar.projectsOpen', sidebarRestOpen ? '1' : '0'); } catch { /* private mode */ }
  }, [sidebarRestOpen]);
  // Cmd/Ctrl+B toggles the rail (not while typing: there it means bold).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'b') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      sidebar.toggleCollapsed();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebar.toggleCollapsed]);

  // The top bar's fit (docs/dev/GILT.md: it never overflows). `squeeze` is how many
  // things it has given up (MAX_SQUEEZE). Whenever the bar's width or what it
  // holds changes, it starts from nothing given up; then, before each paint,
  // one more step while the content overflows or the active task's title is
  // cut below about 8 characters. Layout effects run before paint, so the
  // steps never flash. Content that changes on its own (the Bridge rings and
  // vitals arriving, fonts loading, the clock) is caught by a ResizeObserver
  // on the bar's items when it grows; while something is given up, a
  // 30-second tick re-fits from scratch, so room it frees comes back too.
  // Nothing here runs per render or per second: the fit check forces a
  // layout, and running it after every App render made scrolling choppy.
  const topBarRef = useRef<HTMLElement | null>(null);
  const topBarEndRef = useRef<HTMLSpanElement | null>(null);
  const [topBarWidth, setTopBarWidth] = useState(0);
  const [squeeze, setSqueeze] = useState(0);
  const squeezeSig = useRef('');
  const topBarShown = gate === 'open' && !(firstRun && !isHostedClient());
  useLayoutEffect(() => {
    const el = topBarRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setTopBarWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [topBarShown]);
  const wsSwitcherShown = workspacesEnabled() && listWorkspaces().some((w) => w.id !== LOCAL_ID);
  const [fitEpoch, setFitEpoch] = useState(0);
  const squeezeNow = useRef(0);
  squeezeNow.current = squeeze;
  const barSig = [
    topBarWidth, activeTask?.id, activeTask?.title, wsSwitcherShown, getActiveWorkspaceId(),
    totalProjectsCount, totalAreasCount, totalTasksCount, totalEventsCount, fitEpoch,
  ].join('|');
  // One step when the content overflows (or cuts the title) at the current squeeze.
  const fitCheck = useRef(() => {});
  fitCheck.current = () => {
    const bar = topBarRef.current;
    const end = topBarEndRef.current;
    const s = squeezeNow.current;
    if (!bar || !end || s >= MAX_SQUEEZE) return;
    const right = bar.getBoundingClientRect().right - parseFloat(getComputedStyle(bar).paddingRight);
    const title = bar.querySelector<HTMLElement>('[data-topbar-title]');
    const titleCut = !!title && title.clientWidth + 1 < Math.min(title.scrollWidth, TITLE_MIN_PX);
    if (end.getBoundingClientRect().left > right + 0.5 || titleCut) setSqueeze((v) => (v === s ? s + 1 : v));
  };
  useLayoutEffect(() => {
    if (squeezeSig.current !== barSig) {
      squeezeSig.current = barSig;
      if (squeeze !== 0) {
        setSqueeze(0);
        return;
      }
    }
    fitCheck.current();
  }, [barSig, squeeze]);
  // Growth from inside the bar's own components: watch its items (three levels
  // down, which covers the toolbar's widgets and the title) and re-watch when
  // items come or go.
  useEffect(() => {
    const bar = topBarRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(() => fitCheck.current());
    const watch = () => {
      ro.disconnect();
      bar.querySelectorAll(':scope > *, :scope > * > *, :scope > * > * > *, [data-topbar-title]').forEach((el) => ro.observe(el));
    };
    watch();
    // Batched to one re-watch per frame (re-observing fires the RO, which checks).
    let frame = 0;
    const mo = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; watch(); });
    });
    mo.observe(bar, { childList: true, subtree: true });
    return () => { ro.disconnect(); mo.disconnect(); cancelAnimationFrame(frame); };
  }, [topBarShown]);
  // Room freed on its own comes back: while something is given up, re-fit
  // from scratch every 30 s (no work at all while nothing is).
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (squeezeNow.current > 0) setFitEpoch((e) => e + 1);
    }, 30_000);
    return () => window.clearInterval(iv);
  }, []);
  // The events dropdown hangs off the clock: close it when the clock goes.
  useEffect(() => {
    if (squeeze >= 3) setIsEventDropdownOpen(false);
  }, [squeeze]);

  // Stable, so the memoised HomeBoard skips App's re-renders.
  const openProjectFromHome = useCallback((project: Project) => {
    selectProject(project);
    setCurrentView('projects');
  }, [selectProject]);

  // Load resource counts
  useEffect(() => {
    loadResourceCounts();
  }, [projects]);

  // openSettings(section) from any screen (lib/settingsNav.ts).
  useEffect(() => {
    const open = (e: Event) => {
      setSettingsSection((e as CustomEvent<SettingsSection | undefined>).detail);
      setIsSettingsOpen(true);
    };
    window.addEventListener(OPEN_SETTINGS, open);
    return () => window.removeEventListener(OPEN_SETTINGS, open);
  }, []);

  // Keyboard shortcut for settings (cmd+, or ctrl+,)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Check for cmd+, (Mac) or ctrl+, (Windows/Linux)
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setIsSettingsOpen(true);
      }
      // ⌘⇧N: a whole second Ganban window — board in one, quizzes in another.
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        void openAppWindow();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (sidebarMenuRef.current && !sidebarMenuRef.current.contains(event.target as Node)) {
        setSidebarOpenMenuProjectId(null);
      }
    };

    if (sidebarOpenMenuProjectId !== null) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [sidebarOpenMenuProjectId]);

  // Serialize loadProjects: it fans out across workspaces and merges the
  // results into one list, so two overlapping runs (mount + focus + pulse)
  // must not interleave. Coalesce a concurrent request into one trailing re-run.
  const loadingProjects = useRef(false);
  const loadProjectsAgain = useRef(false);
  const loadProjects = async () => {
    if (loadingProjects.current) {
      loadProjectsAgain.current = true;
      return;
    }
    loadingProjects.current = true;
    try {
      // K2 merge via EXPLICIT per-workspace handles (wsGetProjects tags each
      // project with its workspaceId and touches no active-transport globals,
      // so this is concurrency-safe — no divert race). Local FIRST so the
      // sidebar fills instantly; a slow/dead remote only delays its own rows.
      const workspaces = listWorkspaces();
      const localWs = workspaces.find((w) => w.id === LOCAL_ID);
      // REFRESHES must not flash: the old loader set the list twice (local
      // first, then local + remotes), so a remote host's projects vanished
      // and came back on every pulse/focus — and every [projects] effect
      // re-ran twice. Now: the quick local-first fill only on the very first
      // load; a host that fails transiently keeps its previous projects; and
      // an unchanged result doesn't touch the store at all.
      const previous = useAppStore.getState().projects;
      const firstLoad = previous.length === 0;
      const prevOf = (wsId: string) => previous.filter((p) => (p.workspaceId ?? LOCAL_ID) === wsId);
      let merged: Project[] = [];
      if (localWs) {
        merged = await wsGetProjects(localWs).catch(() => prevOf(LOCAL_ID));
        if (firstLoad) setProjects(merged); // sidebar fills instantly on launch
      }
      // No auto-select: the Projects view lands on the overview (pick a project
      // there or in the sidebar to drill in). Auto-selecting would bypass it and
      // fight the pulse-driven reloads that re-run this loader.
      void syncEnabledProjects(merged); // local file mirror (Tauri fs)

      // Remotes concurrently — explicit handles, so no global divert to
      // serialize against. A dead host never blocks; a FAILED fetch keeps what
      // we last had from it (a blip shouldn't empty the sidebar).
      const remotes = workspaces.filter((w) => w.id !== LOCAL_ID && w.url);
      const remoteLists = await Promise.all(
        remotes.map((ws) =>
          wsGetProjects(ws).catch((e) => {
            console.warn(`Workspace "${ws.label}" projects load failed:`, e);
            return prevOf(ws.id);
          })
        )
      );
      merged = [...merged, ...remoteLists.flat()];
      if (JSON.stringify(merged) !== JSON.stringify(useAppStore.getState().projects)) setProjects(merged);
      // Pinned tabs live with their projects: refresh them on the same beats.
      void usePins.getState().load();
    } catch (error) {
      console.error('Failed to load projects:', error);
    } finally {
      loadingProjects.current = false;
      if (loadProjectsAgain.current) {
        loadProjectsAgain.current = false;
        void loadProjects();
      }
    }
  };

  const loadResourceCounts = async () => {
    try {
      // K2 Stage C: top-bar totals span ALL workspaces. Each workspace's
      // areas/tasks/events are fetched via its explicit handle (no global
      // divert), concurrently within a workspace and across workspaces.
      setTotalProjectsCount(projects.filter((p) => !p.archived).length);
      const wss = listWorkspaces().filter((w) => w.id === LOCAL_ID || w.url);
      let areasCount = 0;
      let tasksCount = 0;
      let eventsCount = 0;
      // The Events tally is "what's still relevant", not the full history — count
      // only events from yesterday onward (a long-finished calendar import
      // shouldn't inflate the number).
      const eventCutoff = new Date();
      eventCutoff.setHours(0, 0, 0, 0);
      eventCutoff.setDate(eventCutoff.getDate() - 1);
      await Promise.all(
        wss.map(async (ws) => {
          const wsProjects = projects.filter((p) => !p.archived && (p.workspaceId ?? LOCAL_ID) === ws.id);
          const [areaArrs, taskArrs, events] = await Promise.all([
            Promise.all(wsProjects.map((p) => wsGetAreas(ws, p.id).catch(() => []))),
            Promise.all(wsProjects.map((p) => wsGetTasks(ws, p.id).catch(() => []))),
            wsGetEvents(ws).catch(() => []),
          ]);
          areasCount += areaArrs.flat().length;
          tasksCount += taskArrs.flat().length;
          eventsCount += events.filter((e) => !e.done_at && new Date(e.event_date).getTime() >= eventCutoff.getTime()).length;
        })
      );
      setTotalAreasCount(areasCount);
      setTotalTasksCount(tasksCount);
      setTotalEventsCount(eventsCount);
    } catch (error) {
      console.error('Failed to load resource counts:', error);
    }
  };

  // K2 helpers: a project's stable composite key, and the badge label for a
  // remote workspace (null = local, no badge).
  const pkey = (p: Project) => `${p.workspaceId ?? LOCAL_ID}:${p.id}`;
  const wsLabel = (id?: string): string | null =>
    !id || id === LOCAL_ID ? null : listWorkspaces().find((w) => w.id === id)?.label ?? 'remote';
  // A stable color per remote workspace, so the merged sidebar can mark which
  // host a project lives on with a small dot (the full host is in the tooltip)
  // instead of a wide IP badge that crowds the project name off the row.
  const wsColor = (id?: string): string => {
    if (!id || id === LOCAL_ID) return 'transparent';
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
    return `hsl(${h}, 65%, 60%)`;
  };

  const handlePinnedProjectClick = (project: Project) => {
    // Clear any existing timer
    if (clickTimer) {
      clearTimeout(clickTimer);
    }

    // Set timer for single click action
    const timer = setTimeout(() => {
      // Single click behavior depends on current view
      if (currentView === 'projects') {
        // If on projects view, just select the project (stay on projects page)
        selectProject(project);
      } else {
        // Otherwise, filter home board and navigate to home
        setHomeBoardProjectFilter(`${project.workspaceId ?? LOCAL_ID}:${project.id}`);
        setCurrentView('home');
      }
      setClickTimer(null);
    }, 300);

    setClickTimer(timer);
  };

  const handlePinnedProjectDoubleClick = (project: Project) => {
    // Clear the single click timer
    if (clickTimer) {
      clearTimeout(clickTimer);
      setClickTimer(null);
    }

    // Double click: navigate to project view
    selectProject(project);
    setCurrentView('projects');
  };

  // K2: mutations go through the project's OWN host via an explicit handle
  // (no global-transport divert), then re-tag the server response (no
  // workspaceId) so the store's composite match finds the right row.
  const wsOfProject = (project: Project) => getWorkspace(project.workspaceId ?? LOCAL_ID);
  const handleTogglePin = async (project: Project) => {
    const ws = wsOfProject(project);
    if (!ws) return;
    try {
      const updated = await wsToggleProjectPin(ws, project.id, !project.pinned);
      updateProject({ ...updated, workspaceId: ws.id });
    } catch (error) {
      console.error('Failed to toggle project pin:', error);
      alert(`Failed to toggle project pin: ${error}`);
    }
  };

  const handleArchiveProject = async (project: Project) => {
    const ws = wsOfProject(project);
    if (!ws) return;
    const nowArchived = !project.archived;
    try {
      const updated = await wsArchiveProject(ws, project.id, nowArchived);
      updateProject({ ...updated, workspaceId: ws.id });
      if (nowArchived && sameProject(selectedProject, project)) {
        selectProject(null);
      }
    } catch (error) {
      console.error('Failed to archive project:', error);
      alert(`Failed to archive project: ${error}`);
    }
  };

  const handleDeleteProject = async (project: Project) => {
    const ws = wsOfProject(project);
    if (!ws) return;
    try {
      await wsDeleteProject(ws, project.id);
      removeProject(project);
      usePins.getState().drop(ws.id, project.id); // the host dropped them with the project
      if (sameProject(selectedProject, project)) {
        selectProject(null);
      }
    } catch (error) {
      console.error('Failed to delete project:', error);
      alert(`Failed to delete project: ${error}`);
    }
  };

  // Pinned tabs (top bar): go to the project's tab from anywhere, or open it in a window.
  const projectOfPin = (pin: Pin) => projects.find((p) => p.id === pin.project && (p.workspaceId ?? LOCAL_ID) === pin.ws) ?? null;
  const openPin = (pin: Pin) => {
    const project = projectOfPin(pin);
    if (!project) return;
    setOverviewOpen(false);
    const remount = applySubView(pin.tab, pin.sub);
    usePins.getState().setOpenIntent({ projectKey: pkey(project), tab: pin.tab, remount });
    selectProject(project);
    setCurrentView('projects');
  };
  const openPinWindow = async (pin: Pin) => {
    const project = projectOfPin(pin);
    if (!project) return;
    setOverviewOpen(false);
    // Extra windows share this one's transport: point it at the pin's host first.
    if ((project.workspaceId ?? LOCAL_ID) !== getActiveWorkspaceId()) {
      selectProject(project);
      notify({ kind: 'info', title: `Switched to ${project.name}`, body: 'Extra windows share this one\'s connection, so it now points at that project\'s host.' });
    }
    const title = `${labelOf(pin, usePins.getState().catalog)} \u2014 ${project.name}`;
    if (!(await openPinnedTabWindow(pin, title))) notify({ kind: 'info', title: 'This client cannot open windows' });
  };
  // Load the tab names once, and the pins again when the acting user changes.
  useEffect(() => {
    void usePins.getState().loadCatalog();
  }, []);
  useEffect(() => {
    if (currentUserId != null) void usePins.getState().load();
  }, [currentUserId]);

  // Shared create path (sidebar + Projects overview): create on the active
  // workspace, add to the store, and drill into it. Throws on failure so each
  // caller can surface it in its own UI.
  const createNamedProject = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const project = await createProject({ name: trimmed });
    addProject(project);
    selectProject(project);
    setCurrentView('projects');
  };

  const handleSidebarCreateProject = async () => {
    if (!sidebarNewProjectName.trim()) return;
    try {
      await createNamedProject(sidebarNewProjectName);
      setSidebarNewProjectName('');
      setIsSidebarCreating(false);
    } catch (error) {
      console.error('Failed to create project:', error);
      alert(`Failed to create project: ${error}`);
    }
  };

  // Sidebar lists: pinned first, then the rest (each alphabetical).
  const pinnedProjects = projects.filter((p) => p.pinned && !p.archived).sort((a, b) => a.name.localeCompare(b.name));
  const otherProjects = projects.filter((p) => !p.pinned && !p.archived).sort((a, b) => a.name.localeCompare(b.name));

  const goNav = (view: View) => {
    if (view === 'home') {
      // Explicit Home navigation shows the full dashboard; a project
      // single-click is what scopes it (sets homeBoardProjectFilter).
      setHomeBoardProjectFilter(null);
    } else if (view === 'projects') {
      selectProject(null);
    }
    setCurrentView(view);
  };

  /** A project's right-click / "⋯" menu in the sidebar. */
  const renderProjectMenu = (project: Project) => {
    const item = 'w-full px-2 min-h-[34px] rounded text-left text-sm hover:bg-surface-0 transition-colors flex items-center gap-2';
    return (
      <div ref={sidebarMenuRef} className="g-card absolute right-0 top-full mt-1 w-52 shadow-2xl z-50 p-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsProjectSettingsOpen(true);
            setSidebarOpenMenuProjectId(null);
          }}
          className={`${item} text-text`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Project Settings
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsAreaManagerOpen(true);
            setSidebarOpenMenuProjectId(null);
          }}
          className={`${item} text-text`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          Manage Areas
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleTogglePin(project);
            setSidebarOpenMenuProjectId(null);
          }}
          className={`${item} text-text`}
        >
          <svg className="w-4 h-4" fill={project.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={project.pinned ? 0 : 2} viewBox="0 0 24 24">
            <path d="M16 12V4H17V2H7V4H8V12L6 14V16H11.2V22H12.8V16H18V14L16 12Z" />
          </svg>
          {project.pinned ? 'Unpin Project' : 'Pin Project'}
        </button>
        <div className="border-t border-gilt-b my-1.5" />
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleArchiveProject(project);
            setSidebarOpenMenuProjectId(null);
          }}
          className={`${item} text-warning`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
          </svg>
          Archive Project
        </button>
        <button
          onClick={async (e) => {
            e.stopPropagation();
            if (await confirmDialog(`Are you sure you want to delete "${project.name}"? This action cannot be undone.`)) {
              handleDeleteProject(project);
            }
            setSidebarOpenMenuProjectId(null);
          }}
          className={`${item} text-error`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          Delete Project
        </button>
      </div>
    );
  };

  /** One project in the expanded sidebar: a gem in its tone, the name, and a
   * "⋯" menu on hover. */
  const renderProjectRow = (project: Project) => {
    const on = sameProject(selectedProject, project) && currentView === 'projects';
    return (
      <div key={pkey(project)} className="relative group">
        <div
          role="button"
          tabIndex={0}
          onClick={() => handlePinnedProjectClick(project)}
          onDoubleClick={() => handlePinnedProjectDoubleClick(project)}
          onContextMenu={(e) => { e.preventDefault(); setSidebarOpenMenuProjectId(pkey(project)); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePinnedProjectClick(project); } }}
          aria-current={on ? 'page' : undefined}
          className={`w-full flex items-center gap-2.5 pl-3 pr-1 min-h-[34px] rounded text-sm text-left cursor-pointer select-none transition-colors ${
            on ? 'bg-base ring-1 ring-inset ring-gilt-a text-text font-semibold' : 'text-subtext-1 hover:bg-surface-0 hover:text-text'
          }`}
        >
          <span className={`g-gem ${projectColorClass(project)}`} aria-hidden="true" />
          <span className="flex-1 min-w-0 truncate">{project.name}</span>
          {wsLabel(project.workspaceId) && (
            <span
              className="shrink-0 w-2 h-2 rounded-full"
              style={{ backgroundColor: wsColor(project.workspaceId) }}
              title={`Remote workspace · ${wsLabel(project.workspaceId)}`}
            />
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuProject(project);
              setActiveWorkspace(project.workspaceId ?? LOCAL_ID); // route Settings/Areas modals to this project's host
              setSidebarOpenMenuProjectId(sidebarOpenMenuProjectId === pkey(project) ? null : pkey(project));
            }}
            title="Project menu"
            aria-label={`${project.name} menu`}
            className="shrink-0 w-8 h-8 grid place-items-center rounded text-subtext-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-surface-1 hover:text-text transition-all"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
            </svg>
          </button>
        </div>
        {sidebarOpenMenuProjectId === pkey(project) && renderProjectMenu(project)}
      </div>
    );
  };

  // First run on a genuinely fresh install (no prior identity, no transport
  // choice): offer "use this machine" vs "join a server" before anything
  // local-flavored renders. Existing installs never see this — any prior
  // session left currentUserId or a transport mode behind.
  if (firstRun && !isHostedClient()) {
    return (
      <ThemeProvider>
        <FirstRunScreen
          onUseLocal={() => {
            localStorage.setItem('ganban-first-run-done', '1');
            setFirstRun(false);
          }}
        />
      </ThemeProvider>
    );
  }

  // Profile gate: nothing renders as a user until one is picked and (when a
  // PIN is set) unlocked. `loading` stays blank for the split second the
  // active-users read takes.
  if (gate !== 'open') {
    return (
      <ThemeProvider>
        {gate === 'locked' ? (
          <ProfileGate
            users={gateUsers}
            initialUserId={currentUserId}
            onUnlock={(id) => {
              setCurrentUserId(id);
              setGate('open');
            }}
          />
        ) : (
          <div className="fixed inset-0 bg-base" />
        )}
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      <div className="flex flex-col h-screen overflow-hidden bg-mantle text-text">
        {/* The top bar (Gilt). It never overflows: as it narrows it gives up, in
            order, the pinned tabs (into "+N"), the active task's title (down to
            about 8 characters), the counts (one Overview button), the host
            stats, the clock and the wordmark. `squeeze` counts those steps. */}
        <header
          ref={topBarRef}
          className="relative z-30 flex-none flex items-center gap-3 px-4 h-[60px] bg-crust border-b border-gilt-a whitespace-nowrap"
          style={titleInset ? { paddingLeft: titleInset } : undefined}
          // The bar's empty areas move the window (double-click zooms, as on
          // macOS); its buttons stay buttons. Ignored outside the desktop app.
          data-tauri-drag-region
        >
          <NavButtons />
          {/* Logo + wordmark: opens Settings */}
          <button
            onClick={() => setIsSettingsOpen(true)}
            className="flex items-center gap-3 pr-1.5 min-h-[38px] rounded hover:opacity-80 transition-opacity shrink-0"
            title="Settings (Cmd+,)"
          >
            <img src="/logo.svg" alt="Ganban Logo" className="w-7 h-7" />
            {squeeze < 4 && (
              <span className="g-deco text-base font-semibold text-gold tracking-[.3em]">Ganban</span>
            )}
          </button>

          {/* K2: workspace switcher — only when ≥1 remote host is attached.
              Sets the default workspace (where a new project lands) and lets
              you join/forget hosts. Per-project routing follows selection, so
              the merged sidebar already spans every workspace regardless. */}
          {wsSwitcherShown && (
            <div className="relative shrink-0">
              <button
                onClick={() => setWsMenuOpen((o) => !o)}
                className={`${TB} ${wsMenuOpen ? TB_OPEN : ''}`}
                title="Workspaces"
                aria-expanded={wsMenuOpen}
              >
                <svg className="w-4 h-4 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M4 7l8-4 8 4-8 4-8-4zm0 5l8 4 8-4M4 17l8 4 8-4" />
                </svg>
                <span className="max-w-[120px] truncate text-[13px]">
                  {listWorkspaces().find((w) => w.id === getActiveWorkspaceId())?.label ?? 'This machine'}
                </span>
                <svg className={`w-2.5 h-2.5 transition-transform ${wsMenuOpen ? 'rotate-180' : ''}`} viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
              {wsMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setWsMenuOpen(false)} />
                  <div className="g-card absolute left-0 top-full mt-2 z-50 w-64 shadow-2xl p-2 whitespace-normal">
                    <div className="g-deco px-2 pt-1 pb-1.5 text-[11px] font-semibold text-subtext-0">Default workspace</div>
                    {listWorkspaces().map((ws) => {
                      const count = projects.filter((p) => (p.workspaceId ?? LOCAL_ID) === ws.id && !p.archived).length;
                      const active = ws.id === getActiveWorkspaceId();
                      return (
                        <div key={ws.id} className="flex items-center group rounded hover:bg-surface-0">
                          <button
                            onClick={() => { setActiveWorkspace(ws.id); setWsTick((n) => n + 1); setWsMenuOpen(false); }}
                            className={`flex-1 min-w-0 text-left px-2 min-h-[34px] text-sm flex items-center gap-2 ${active ? 'text-gold' : 'text-subtext-1 hover:text-text'}`}
                          >
                            <span className="w-4 shrink-0 grid place-items-center" aria-hidden="true">
                              {active && <span className="g-gem" style={{ width: 6, height: 6 }} />}
                            </span>
                            <span className="flex-1 truncate">{ws.id === LOCAL_ID ? 'This machine' : ws.label}</span>
                            <span className="text-xs text-subtext-0 shrink-0 tabular-nums">{count}</span>
                          </button>
                          {ws.id !== LOCAL_ID && (
                            <button
                              onClick={async () => {
                                if (await confirmDialog(`Forget workspace "${ws.label}"? Its projects leave your sidebar (your own data is untouched).`)) {
                                  removeWorkspace(ws.id);
                                  setWsMenuOpen(false);
                                  window.location.reload(); // tear down that host's SSE stream cleanly
                                }
                              }}
                              title="Forget this workspace"
                              className="px-2 min-h-[34px] text-xs text-subtext-0 hover:text-error opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      );
                    })}
                    <div className="border-t border-gilt-b my-1.5" />
                    <button
                      onClick={() => { setWsMenuOpen(false); setIsJoinOpen(true); }}
                      className="w-full text-left px-2 min-h-[34px] rounded text-sm text-gold hover:bg-gilt-b flex items-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M12 4v16m8-8H4" />
                      </svg>
                      Join a project…
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Resource counts — click for the full overview popover. Squeezed,
              they fold into one "Overview" button that opens the same popover. */}
          <div ref={overviewRef} className="relative shrink-0">
            <button
              onClick={() => setOverviewOpen((v) => !v)}
              title="Open the overview"
              aria-expanded={overviewOpen}
              aria-haspopup="dialog"
              className={`${TB} ${overviewOpen ? TB_OPEN : ''} ${squeeze >= 1 ? '' : 'gap-4'}`}
            >
              {squeeze >= 1 ? (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z" />
                  </svg>
                  <span>Overview</span>
                </>
              ) : (
                <>
                  <span><b className="font-semibold text-text tabular-nums">{totalProjectsCount}</b> Projects</span>
                  <span><b className="font-semibold text-text tabular-nums">{totalAreasCount}</b> Areas</span>
                  <span><b className="font-semibold text-text tabular-nums">{totalTasksCount}</b> Tasks</span>
                  <span><b className="font-semibold text-text tabular-nums">{totalEventsCount}</b> Events</span>
                </>
              )}
            </button>
            {overviewOpen && (
              <div className="g-card g-corners absolute left-0 top-full mt-2 z-50 w-80 shadow-2xl p-4 space-y-3 whitespace-normal">
                {/* Micro-header + tile grid, like the Bridge dropdown. Hints
                    live in tooltips. */}
                <div className="g-deco text-[11px] font-semibold text-subtext-0">Overview — all workspaces</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {([
                    ['Projects', totalProjectsCount, 'projects', 'Every active project across your connected hosts', 'text-primary', 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z'],
                    ['Areas', totalAreasCount, 'projects', 'Areas inside those projects', 'text-info', 'M4 6h16M4 12h16M4 18h16'],
                    ['Tasks', totalTasksCount, 'home', 'Live tasks (see Home for yours)', 'text-success', 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2'],
                    ['Events', totalEventsCount, 'events', 'Upcoming events on all calendars', 'text-warning', 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z'],
                  ] as [string, number, View, string, string, string][]).map(([label, count, view, hint, color, path]) => (
                    <button
                      key={label}
                      onClick={() => { setOverviewOpen(false); setCurrentView(view); }}
                      title={hint}
                      className="h-16 rounded bg-mantle ring-1 ring-inset ring-gilt-b hover:ring-gilt-a hover:bg-surface-0 transition-colors flex flex-col items-center justify-center gap-0.5 min-w-0"
                    >
                      <span className="flex items-center gap-1.5">
                        <svg className={`w-3.5 h-3.5 ${color}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.7} d={path} />
                        </svg>
                        <span className="text-lg font-semibold text-text leading-none tabular-nums">{count}</span>
                      </span>
                      <span className="text-[11px] text-subtext-0">{label}</span>
                    </button>
                  ))}
                </div>
                <div className="border-t border-gilt-b pt-3">
                  <PinnedTabsManager onOpen={openPin} onOpenWindow={(p) => void openPinWindow(p)} />
                </div>
              </div>
            )}
          </div>

          {/* The Bridge dropdown: automation rings + host vitals, one popover.
              Squeezed, the vitals' numbers hide (the status diamond stays). */}
          <AgentPulse
            compact={squeeze >= 2}
            onOpenBridge={() => {
              // Land on Assistant > BRIDGE, not whatever tab was last open.
              sessionStorage.setItem('ganban:assistant-tab', 'bridge');
              window.dispatchEvent(new CustomEvent('ganban:assistant-tab', { detail: 'bridge' }));
              setCurrentView('chat');
            }}
          />

          {/* Pinned tabs fill the bar's free space; what doesn't fit goes under "+N". */}
          <PinnedTabs onOpen={openPin} onOpenWindow={(p) => void openPinWindow(p)} projectsView={currentView === 'projects'} />

          {/* Right toolbar: search, active task, date/clock popup, notifications.
              min-w-0: the active task's title is what shrinks first. */}
          <div className="flex items-center gap-3 justify-end min-w-0" data-tauri-drag-region>
            {/* "Update ready: Restart" once a new desktop build has downloaded. */}
            <UpdateReadyNotice />
            <SearchBar onSelectResult={(t) => searchDetail.open(t)} />
            <ActiveTaskWidget onOpenTask={(task) => searchDetail.open({ kind: 'task', task })} />
            {/* Compact clock: shows the live time (no date/tz — those live in
                the popup) and opens the events calendar. The last thing the
                bar gives up before the wordmark. */}
            {squeeze < 3 && (
              <TopBarClock
                open={isEventDropdownOpen}
                onToggle={() => setIsEventDropdownOpen(!isEventDropdownOpen)}
                onClose={() => setIsEventDropdownOpen(false)}
                onNavigateToCalendar={() => setCurrentView('events')}
                buttonClassName={`${TB} ${isEventDropdownOpen ? TB_OPEN : ''}`}
              />
            )}
            {/* Notification hub (the avatar opens the notification center). */}
            <NotificationCenter
              currentUser={currentUser}
              onOpenProfile={() => setIsProfileOpen(true)}
              onOpenSettings={() => setIsSettingsOpen(true)}
              onRefresh={refreshAll}
              pendingApprovals={pendingProposalCount}
            />
            {/* The fit check measures the content's right edge here (-ml-3
                cancels this row's gap-3). */}
            <span ref={topBarEndRef} className="w-0 shrink-0 -ml-3" aria-hidden="true" />
          </div>
        </header>

        {/* Main layout */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* The sidebar: resizable, and collapsible to an icon rail (Cmd/Ctrl+B). */}
          <ResizablePane
            id="sidebar"
            side="left"
            min={200}
            max={420}
            defaultWidth={250}
            collapsible
            collapsedWidth={64}
            className="bg-crust border-r border-gilt-b"
          >
            {sidebar.collapsed ? (
              <nav className="h-full flex flex-col" aria-label="Main">
                <div className="flex-none flex flex-col items-center gap-1 pt-3.5 pb-2.5">
                  {NAV.map((n) => {
                    const on = currentView === n.view;
                    return (
                      <button
                        key={n.view}
                        onClick={() => goNav(n.view)}
                        title={n.label}
                        aria-label={n.label}
                        aria-current={on ? 'page' : undefined}
                        className={`relative w-10 h-10 grid place-items-center rounded transition-colors ${
                          on ? 'bg-base text-gold ring-1 ring-inset ring-gilt-a' : 'text-subtext-1 hover:bg-surface-0 hover:text-text'
                        }`}
                      >
                        <NavIcon d={n.d} />
                        {n.view === 'chat' && pendingProposalCount > 0 && (
                          <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-primary" aria-hidden="true" />
                        )}
                      </button>
                    );
                  })}
                  <RailNavButtons collapsed current={currentView} onGo={goNav} />
                </div>
                <ScrollArea className="flex-1 min-h-0 border-t border-gilt-b" contentClassName="flex flex-col items-center gap-1.5 py-3">
                  {pinnedProjects.map((project) => {
                    const on = sameProject(selectedProject, project) && currentView === 'projects';
                    return (
                      <button
                        key={pkey(project)}
                        onClick={() => handlePinnedProjectClick(project)}
                        onDoubleClick={() => handlePinnedProjectDoubleClick(project)}
                        title={project.name + (wsLabel(project.workspaceId) ? ` · ${wsLabel(project.workspaceId)}` : '')}
                        aria-label={project.name}
                        aria-current={on ? 'page' : undefined}
                        className={`relative w-10 h-10 grid place-items-center rounded transition-colors ${on ? 'bg-base ring-1 ring-inset ring-gilt-a' : 'hover:bg-surface-0'}`}
                      >
                        <span className={`g-tile ${projectColorClass(project)}`}>{projectInitial(project.name)}</span>
                        {wsLabel(project.workspaceId) && (
                          <span
                            className="absolute top-0.5 right-0.5 w-2 h-2 rounded-full ring-2 ring-crust"
                            style={{ backgroundColor: wsColor(project.workspaceId) }}
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    );
                  })}
                  {/* The unpinned projects, in a popover beside the rail. */}
                  <RailProjectsMenu
                    projects={otherProjects}
                    keyOf={pkey}
                    isCurrent={(p) => sameProject(selectedProject, p) && currentView === 'projects'}
                    onClick={handlePinnedProjectClick}
                    onDoubleClick={handlePinnedProjectDoubleClick}
                  />
                </ScrollArea>
                <div className="flex-none flex flex-col items-center gap-1 py-3 border-t border-gilt-b">
                  <button
                    onClick={() => { sidebar.setCollapsed(false); setIsSidebarCreating(true); }}
                    className="g-iconbtn text-gold"
                    title="New Project"
                    aria-label="New Project"
                  >
                    <svg className="w-[18px] h-[18px]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path strokeLinecap="round" strokeWidth={1.7} d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                  <SidebarToggle collapsed onToggle={sidebar.toggleCollapsed} />
                </div>
              </nav>
            ) : (
              <nav className="h-full flex flex-col" aria-label="Main">
                <div className="flex-none flex flex-col gap-0.5 px-3 pt-3.5 pb-2.5">
                  {NAV.map((n) => {
                    const on = currentView === n.view;
                    return (
                      <button
                        key={n.view}
                        onClick={() => goNav(n.view)}
                        aria-current={on ? 'page' : undefined}
                        className={`w-full flex items-center gap-3 min-h-[38px] px-3 rounded font-medium text-left transition-colors ${
                          on ? 'bg-base text-gold ring-1 ring-inset ring-gilt-a' : 'text-subtext-1 hover:bg-surface-0 hover:text-text'
                        }`}
                      >
                        <NavIcon d={n.d} />
                        <span className="flex-1 min-w-0 truncate">{n.label}</span>
                        {/* Pending-approval count (Activity now lives inside the Assistant). */}
                        {n.view === 'chat' && pendingProposalCount > 0 && (
                          <span className="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-primary text-primary-text text-xs flex items-center justify-center">
                            {pendingProposalCount}
                          </span>
                        )}
                        <span
                          className={`shrink-0 w-1.5 h-1.5 bg-gold rotate-45 ${on ? 'opacity-100' : 'opacity-0'}`}
                          aria-hidden="true"
                        />
                      </button>
                    );
                  })}
                  <RailNavButtons collapsed={false} current={currentView} onGo={goNav} />
                </div>

                {/* Pinned, then the other projects (collapsible) */}
                <ScrollArea className="flex-1 min-h-0 border-t border-gilt-b" contentClassName="px-3 py-2.5">
                  <div className={SECTION_LABEL}>
                    <span className="g-gem" style={{ width: 6, height: 6 }} aria-hidden="true" />
                    Pinned
                    <span className="ml-auto tracking-[.1em] tabular-nums">{pinnedProjects.length}</span>
                  </div>
                  {pinnedProjects.length > 0 ? (
                    <div className="space-y-0.5">{pinnedProjects.map(renderProjectRow)}</div>
                  ) : (
                    <p className="px-3 py-2 text-xs text-subtext-0 italic">No pinned projects</p>
                  )}

                  <button
                    onClick={() => setSidebarRestOpen((o) => !o)}
                    aria-expanded={sidebarRestOpen}
                    className={`${SECTION_LABEL} mt-3 hover:text-subtext-1`}
                  >
                    <span className="g-gem c-none" style={{ width: 6, height: 6 }} aria-hidden="true" />
                    Projects
                    <span className="ml-auto tracking-[.1em] tabular-nums">
                      {otherProjects.length}
                    </span>
                    <svg className={`w-2.5 h-2.5 shrink-0 transition-transform ${sidebarRestOpen ? '' : '-rotate-90'}`} viewBox="0 0 10 10" aria-hidden="true">
                      <path d="M1 3l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  </button>
                  {sidebarRestOpen &&
                    (otherProjects.length > 0 ? (
                      <div className="space-y-0.5">{otherProjects.map(renderProjectRow)}</div>
                    ) : (
                      <p className="px-3 py-2 text-xs text-subtext-0 italic">
                        {pinnedProjects.length > 0 ? 'Every project is pinned' : 'No projects yet'}
                      </p>
                    ))}
                </ScrollArea>

                {/* Create / join, and the collapse toggle */}
                <div className="flex-none p-3 border-t border-gilt-b space-y-1.5">
                  {isSidebarCreating ? (
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={sidebarNewProjectName}
                        onChange={(e) => setSidebarNewProjectName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSidebarCreateProject();
                          if (e.key === 'Escape') {
                            setIsSidebarCreating(false);
                            setSidebarNewProjectName('');
                          }
                        }}
                        placeholder="Project name..."
                        className="w-full px-3 min-h-[38px] bg-base border border-gilt-a rounded focus:outline-none focus:border-gold text-text placeholder:text-subtext-0 text-sm"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <button onClick={handleSidebarCreateProject} className="g-btn g-btn-pri g-btn-sm flex-1">
                          Create
                        </button>
                        <button
                          onClick={() => {
                            setIsSidebarCreating(false);
                            setSidebarNewProjectName('');
                          }}
                          className="g-btn g-btn-ghost g-btn-sm flex-1"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setIsSidebarCreating(true)} className="g-btn g-btn-pri g-glint w-full">
                      + New Project
                    </button>
                  )}
                  <div className="flex items-center gap-1">
                    {!isSidebarCreating && (
                      <button
                        onClick={() => setIsJoinOpen(true)}
                        className="g-lnk flex-1 justify-center"
                        title="Connect to a teammate's host with an invite link"
                      >
                        Join a project →
                      </button>
                    )}
                    <SidebarToggle collapsed={false} onToggle={sidebar.toggleCollapsed} />
                  </div>
                </div>
              </nav>
            )}
          </ResizablePane>

        {/* Main content area (keyed: the Refresh button remounts the active
            view, which refetches everything it shows) */}
        <div className="flex-1 min-w-0 overflow-hidden" key={viewNonce}>
          {currentView === 'home' ? (
            <HomeBoard
              onOpenProject={openProjectFromHome}
              // Desktop local always talks to its own daemon over loopback (=owner);
              // online/web/mobile clients learn ownership from `/me`.
              isOwner={
                (isTauri() && !isMobilePlatform() && !isDesktopOnline()) || !!currentUser?.is_owner
              }
            />
          ) : currentView === 'atlas' ? (
            <AtlasView manage={isTauri() && !isDesktopOnline()} />
          ) : currentView === 'bin' ? (
            <BinView />
          ) : currentView === 'reports' ? (
            <ReportGenerator />
          ) : currentView === 'events' ? (
            <CalendarView />
          ) : currentView === 'contacts' ? (
            <ContactsView />
          ) : currentView === 'chat' ? (
            <ChatView />
          ) : currentView.startsWith('rail:') ? (
            <RailViewHost view={currentView} />
          ) : selectedProject ? (
            <ProjectView />
          ) : (
            <ProjectsOverview
              onCreateProject={createNamedProject}
              onJoin={() => setIsJoinOpen(true)}
            />
          )}
        </div>
        </div>

        {/* Global detail drawer — opened from search; slides in on the right */}
        {searchDetail.current && (
          <>
            <div className="fixed inset-0 z-40 bg-black/30" onClick={() => searchDetail.close()} />
            <div
              className="fixed right-0 top-0 h-full max-w-[100vw] z-50 bg-surface-0 border-l border-surface-2 shadow-2xl"
              style={{ width: sidePane.width }}
            >
              <PaneHandle side="right" dragging={sidePane.dragging} handleProps={sidePane.handleProps} />
              <DetailPane
                controller={searchDetail}
                onChanged={() => loadResourceCounts()}
                onOpenProject={(project) => {
                  selectProject(project);
                  setCurrentView('projects');
                  searchDetail.close();
                }}
              />
            </div>
          </>
        )}

        {/* Join-a-project modal (discoverable from the sidebar) */}
        <JoinServerModal open={isJoinOpen} onClose={() => setIsJoinOpen(false)} />

        {/* Settings Modal */}
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => {
            setIsSettingsOpen(false);
            setSettingsSection(undefined);
          }}
          initialSection={settingsSection}
          currentUserId={currentUserId}
          onUserChange={setCurrentUserId}
        />

        {/* My-profile editor */}
        <ProfileModal
          isOpen={isProfileOpen}
          onClose={() => setIsProfileOpen(false)}
          userId={currentUserId}
          onSaved={reloadCurrentUser}
        />

        {/* Project Settings Modal */}
        {menuProject && (
          <ProjectSettingsModal
            project={menuProject}
            isOpen={isProjectSettingsOpen}
            onClose={() => {
              setIsProjectSettingsOpen(false);
              setMenuProject(null);
            }}
            onUpdate={(updatedProject) => {
              // Re-tag the server DTO (no workspaceId) with the edited
              // project's workspace, or the store's composite match misses the
              // remote row and the rename is silently lost (K2).
              updateProject({ ...updatedProject, workspaceId: menuProject.workspaceId });
              setIsProjectSettingsOpen(false);
              setMenuProject(null);
            }}
          />
        )}

        {/* Area Manager Modal */}
        {menuProject && (
          <AreaManager
            projectId={menuProject.id}
            isOpen={isAreaManagerOpen}
            onClose={() => {
              setIsAreaManagerOpen(false);
              setMenuProject(null);
            }}
          />
        )}

        {/* Event Notification System */}
        <NotificationSystem />
      </div>
    </ThemeProvider>
  );
}

export default App;

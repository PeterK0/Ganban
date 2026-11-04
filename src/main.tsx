import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import MobileApp from "./mobile/MobileApp";
import { isMobilePlatform, isWebClient, isTauri, isDesktopOnline, getDaemonBaseUrl } from "./lib/daemon";
import { preferredShell } from "./lib/shell";
import WebGate from "./components/WebGate";
import StaleBuildBanner from "./components/StaleBuildBanner";
import { daemonStatus } from "./lib/host";
import { migrateWorkspaces, setLocalUrl } from "./lib/workspaces";
import { installErrorCapture } from "./lib/errorLog";
import { installRestartFlushListener, installUnloadFlush } from "./lib/restartFlush";
import { tabPane } from "./tabs/modules";
// Gilt's faces, bundled (the app runs offline): Figtree for text, Josefin Sans
// for deco headings. Only the weights the design uses.
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import "@fontsource/josefin-sans/300.css";
import "@fontsource/josefin-sans/400.css";
import "@fontsource/josefin-sans/600.css";
import "@fontsource/josefin-sans/700.css";
import "./index.css";

// Capture client-side errors into a ring buffer for the bug reporter (no upload).
installErrorCapture();

// K2: fold the legacy single-connection globals into the workspace registry
// before anything reads them (idempotent, desktop-only). A prior online
// enrollment becomes one registered remote, still active.
migrateWorkspaces();

// Every window saves its open editors when the app restarts into an update,
// and when the window reloads or closes.
void installRestartFlushListener();
void installUnloadFlush();

// WHICH SHELL is a question about the input device and the viewport, NOT the
// runtime (lib/shell.ts): the native mobile app, a phone browser, or a narrow
// window get the touch UI; a mouse and a wide window get the full App — even
// in a plain browser, because every command already routes over HTTP for web
// clients (api.ts::useHttpTransport). So a member opens the real Ganban in a
// tab, no install required.
// Extra desktop windows boot the SAME app with a ?pane= query — a standalone
// shell (one task, say) instead of the full App. localStorage is shared, so
// the transport and theme are inherited without any handshake.
const paneParams = new URLSearchParams(window.location.search);
const pane = paneParams.get('pane');

const shell = preferredShell();
const Root = shell === 'touch' ? MobileApp : App;

/** Desktop, local mode: the Rust side autostarts the embedded daemon
 * (loopback-only) at launch — wait briefly for it to bind and point the app at
 * it BEFORE first render, so everything gated on hasDaemon() (assistant, tabs,
 * secretary, activity) is simply there, every session, with no manual step. */
async function ensureLocalDaemonUrl(): Promise<void> {
  if (!isTauri() || isMobilePlatform() || isWebClient() || isDesktopOnline()) return;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const st = await daemonStatus().catch(() => null);
      if (st?.running && st.port) {
        const url = `http://127.0.0.1:${st.port}`;
        // Remember the loopback as the 'local' workspace's URL (and, since
        // local is the active workspace in this branch, point the live globals
        // at it). Survives a remote-active session repointing the globals.
        if (getDaemonBaseUrl() !== url) setLocalUrl(url);
        return;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  } catch {
    /* render anyway — Sync → "Host this device" can still start it manually */
  }
}

void ensureLocalDaemonUrl().finally(() => {
  // A page a tab module owns (src/tabs/modules.ts): alone, or in place of the app.
  const modPane = tabPane(pane);
  if (modPane?.bare) {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <React.Suspense fallback={null}>{modPane.render(paneParams)}</React.Suspense>
      </React.StrictMode>,
    );
    return;
  }
  let node: React.ReactNode = <Root />;
  const modNode = modPane?.render(paneParams);
  if (modNode) node = <React.Suspense fallback={null}>{modNode}</React.Suspense>;
  // A pinned tab, opened from the top bar into its own window.
  if (pane === 'tab' && shell === 'desktop') {
    const ws = paneParams.get('ws');
    const projectId = Number(paneParams.get('project'));
    const tab = paneParams.get('tab');
    if (ws && tab && projectId > 0) {
      const PinnedTabWindow = React.lazy(() => import('./windows/PinnedTabWindow'));
      node = (
        <React.Suspense fallback={null}>
          <PinnedTabWindow ws={ws} projectId={projectId} tab={tab} sub={paneParams.get('sub')} />
        </React.Suspense>
      );
    }
  }
  if (pane === 'task' && shell === 'desktop') {
    const projectId = Number(paneParams.get('project'));
    const taskId = Number(paneParams.get('task'));
    if (projectId > 0 && taskId > 0) {
      const TaskWindow = React.lazy(() => import('./windows/TaskWindow'));
      node = (
        <React.Suspense fallback={null}>
          <TaskWindow projectId={projectId} taskId={taskId} />
        </React.Suspense>
      );
    }
  }
  // MobileApp carries its own gate; the desktop shell in a browser needs one.
  if (isWebClient() && shell === 'desktop') node = <WebGate>{node}</WebGate>;
  // A web client's bundle comes from the host: tell it when the host has moved on.
  if (isWebClient()) node = <><StaleBuildBanner />{node}</>;
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>{node}</React.StrictMode>,
  );
});

import { Suspense } from "react";
import type { TabDescriptor } from "../../lib/daemon";
import { TAB_PANELS } from "../../tabs/registry";
import TabErrorBoundary from "../../components/TabErrorBoundary";
import { useNav } from "../nav";
import { Screen, Spinner } from "../ui";

/** A stash tab (NATO / PDF Studio / Email…) as a pushed full-screen. These are
 * the same lazy panels the desktop tab bar mounts — they speak only daemon
 * HTTP, so they work identically from a phone or a tailnet browser. */
export default function StashTabScreen({ tab, projectId }: { tab: TabDescriptor; projectId: number }) {
  const nav = useNav();
  const Panel = TAB_PANELS[tab.id];
  return (
    <Screen title={tab.name} onBack={nav.pop}>
      {/* Height-bound column: panels own their scrolling (Screen's body would
          otherwise let a flex panel grow unbounded). */}
      <div className="h-full flex flex-col">
        <TabErrorBoundary>
          <Suspense fallback={<Spinner />}>{Panel ? <Panel projectId={projectId} /> : null}</Suspense>
        </TabErrorBoundary>
      </div>
    </Screen>
  );
}

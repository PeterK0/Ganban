import { useNav } from "../nav";
import { EmptyState, Screen, Spinner } from "../ui";
import { useRailTabs } from "../../store/railTabs";
import { RailShellContext, RailViewHost, railView, useShownRails } from "../../components/RailViews";
import type { TabModule } from "../../tabs/modules";

/** A tab module's rail view (Finance), full screen. Same gate as the desktop sidebar: the host has
 * the tab and the user turned it on (Settings → Sections, here or on the desktop). The view gets
 * touch-size controls (`gm-touch`) and knows it's in the phone shell, so it drops its own title. */
export default function RailScreen({ module }: { module: TabModule }) {
  const nav = useNav();
  const shown = useShownRails().some((m) => m.id === module.id);
  const known = useRailTabs((s) => s.hostTabs !== null);
  return (
    <Screen title={module.rail!.label} onBack={nav.pop}>
      {shown ? (
        <div className="h-full gm-touch">
          <RailShellContext.Provider value="touch">
            <RailViewHost view={railView(module.id)} />
          </RailShellContext.Provider>
        </div>
      ) : !known ? (
        <Spinner />
      ) : (
        <EmptyState text={`${module.rail!.label} is turned off. Turn it on in More → Settings → Sections.`} />
      )}
    </Screen>
  );
}

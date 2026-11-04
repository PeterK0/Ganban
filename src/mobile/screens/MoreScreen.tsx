import { useEffect, type ReactNode } from "react";
import { useNav } from "../nav";
import { ListRow, Screen } from "../ui";
import AccountScreen from "./AccountScreen";
import AssistantScreen from "./AssistantScreen";
import SearchScreen from "./SearchScreen";
import UsersScreen from "./UsersScreen";
import ReportsScreen from "./ReportsScreen";
import BinScreen from "./BinScreen";
import SettingsScreen from "./SettingsScreen";
import { getMe } from "../../lib/daemon";
import { useRailTabs } from "../../store/railTabs";
import { useShownRails } from "../../components/RailViews";
import RailScreen from "./RailScreen";

export default function MoreScreen({ onDisconnect }: { onDisconnect: () => void }) {
  const nav = useNav();
  // Who's signed in decides whose switches count.
  useEffect(() => {
    getMe()
      .then((me) => useRailTabs.getState().load(me.user.id))
      .catch(() => {});
  }, []);
  const rails = useShownRails();
  const items: { label: string; sub: string; screen: ReactNode }[] = [
    { label: "Account", sub: "Your profile, your devices, projects & sign out", screen: <AccountScreen onDisconnect={onDisconnect} /> },
    { label: "Assistant", sub: "Chat with an AI grounded in your projects", screen: <AssistantScreen /> },
    { label: "Search", sub: "Find projects & tasks", screen: <SearchScreen /> },
    { label: "Reports", sub: "Per-project stats", screen: <ReportsScreen /> },
    { label: "Users", sub: "Manage & switch users", screen: <UsersScreen /> },
    { label: "Bin", sub: "Restore or delete archived items", screen: <BinScreen /> },
    { label: "Settings", sub: "Theme, account, connection", screen: <SettingsScreen onDisconnect={onDisconnect} /> },
  ];
  items.splice(3, 0, ...rails.map((m) => ({ label: m.rail!.label, sub: m.rail!.description ?? "", screen: <RailScreen module={m} /> })));
  return (
    <Screen title="More">
      <div>
        {items.map((it) => (
          <ListRow key={it.label} title={it.label} subtitle={it.sub} onClick={() => nav.push(it.screen)} />
        ))}
      </div>
    </Screen>
  );
}

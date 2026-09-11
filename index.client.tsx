import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SessionsSurface } from "./client/sessions";

export default function contribute(client: PluginClientContext) {
  client.addSurface("sessions", SessionsSurface);
  client.addSidebarItem({ id: "sessionforge", title: "SessionForge", icon: "Blocks", surface: "sessions" });
  client.addCommandCenterItem({
    id: "sessionforge-open",
    title: "Open SessionForge",
    icon: "Blocks",
    context: "global",
    onSelect({ openSurface }) {
      openSurface("sessions");
    },
  });

  return () => {};
}

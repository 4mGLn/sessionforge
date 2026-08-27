import type { PluginContext } from "@getpaseo/plugin";
import { SessionsSurface } from "./main.client";
import {
  archiveSessionRpc,
  cleanupSessionsRpc,
  deleteSessionsRpc,
  discoverSessionsRpc,
  listSessionsRpc,
  restoreSessionRpc,
  searchSessionsRpc,
  showSessionRpc,
} from "./src/server/session-contracts.shared";
import {
  archiveSessionHandler,
  cleanupSessions,
  deleteSessionsHandler,
  discoverSessions,
  listSessions,
  restoreSessionHandler,
  searchSessions,
  showSession,
  stopBackgroundDiscovery,
} from "./src/server/session-handlers.server";

export default function contribute(plugin: PluginContext) {
  plugin.handle(listSessionsRpc, listSessions);
  plugin.handle(showSessionRpc, showSession);
  plugin.handle(searchSessionsRpc, searchSessions);
  plugin.handle(discoverSessionsRpc, discoverSessions);
  plugin.handle(cleanupSessionsRpc, cleanupSessions);
  plugin.handle(archiveSessionRpc, archiveSessionHandler);
  plugin.handle(restoreSessionRpc, restoreSessionHandler);
  plugin.handle(deleteSessionsRpc, deleteSessionsHandler);

  plugin.addSurface("sessions", SessionsSurface);
  plugin.addSidebarItem({ id: "sessionforge", title: "SessionForge", icon: "Blocks", surface: "sessions" });
  plugin.addCommandCenterItem({
    id: "sessionforge-open",
    title: "Open SessionForge",
    icon: "Blocks",
    context: "global",
    onSelect({ openSurface }) {
      openSurface("sessions");
    },
  });

  return () => {
    try {
      stopBackgroundDiscovery();
    } catch {
      // The plugin-introspection pass in Paseo's main process also invokes this cleanup,
      // in a context where server-only bindings aren't callable — safe to ignore there.
    }
  };
}

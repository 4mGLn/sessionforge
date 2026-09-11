import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  archiveSessionRpc,
  cleanupSessionsRpc,
  deleteSessionsRpc,
  discoverSessionsRpc,
  listSessionsRpc,
  restoreSessionRpc,
  searchSessionsRpc,
  showSessionRpc,
} from "./shared/session-contracts";
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
} from "./server/session-handlers";

export default function contribute(server: PluginServerContext) {
  server.handle(listSessionsRpc, listSessions);
  server.handle(showSessionRpc, showSession);
  server.handle(searchSessionsRpc, searchSessions);
  server.handle(discoverSessionsRpc, discoverSessions);
  server.handle(cleanupSessionsRpc, cleanupSessions);
  server.handle(archiveSessionRpc, archiveSessionHandler);
  server.handle(restoreSessionRpc, restoreSessionHandler);
  server.handle(deleteSessionsRpc, deleteSessionsHandler);

  return () => {
    try {
      stopBackgroundDiscovery();
    } catch {
      // Left over from the pre-0.8 single-entry-point architecture, where Paseo's main-process
      // introspection pass could invoke this same cleanup in a context without real server bindings. Now
      // that server code only ever runs in the daemon subprocess bundle, that specific scenario likely
      // can't happen anymore — kept as a zero-cost safety net rather than removed on an assumption that
      // hasn't been directly verified against the new architecture.
    }
  };
}

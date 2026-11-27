import {
  AiderAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  GeminiCliAdapter,
  OpenCodeAdapter,
  SessionStore,
  archiveSession,
  deleteSessions,
  restoreSession,
  runCleanup,
  runDiscovery,
} from "@aadaa88/sessionforge";
import type { DiscoverResult, SessionFilter } from "@aadaa88/sessionforge";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { setImmediate } from "node:timers/promises";

const ACTOR = "paseo-plugin";
const ADAPTERS = [new ClaudeCodeAdapter(), new CodexAdapter(), new GeminiCliAdapter(), new OpenCodeAdapter(), new AiderAdapter()];
const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;

let storeSingleton: SessionStore | null = null;
let backgroundInterval: ReturnType<typeof setInterval> | null = null;
let discoveryInFlight: Promise<DiscoverResult> | null = null;

function store(): SessionStore {
  if (!storeSingleton) storeSingleton = new SessionStore();
  ensureBackgroundDiscovery();
  return storeSingleton;
}

function ensureBackgroundDiscovery(): void {
  if (backgroundInterval || !storeSingleton) return;
  discoverSessions().catch((error: unknown) => {
    console.error("SessionForge: initial discovery failed", error);
  });
  backgroundInterval = setInterval(() => {
    discoverSessions().catch((error: unknown) => {
      console.error("SessionForge: periodic discovery failed", error);
    });
  }, DISCOVERY_INTERVAL_MS);
}

/** Called from the plugin's cleanup hook so the interval doesn't outlive a reload/disable. */
export function stopBackgroundDiscovery(): void {
  if (backgroundInterval) {
    clearInterval(backgroundInterval);
    backgroundInterval = null;
  }
}

export async function listSessions(input: SessionFilter) {
  const inventory = store();
  return {
    sessions: inventory.listSessions(input),
    relationships: inventory.listAllRelationships(),
    discovering: discoveryInFlight !== null,
  };
}

export async function showSession(input: { id: string }) {
  return { session: store().getSession(input.id), relationships: store().listRelationships(input.id) };
}

export async function searchSessions(input: { query: string }) {
  return { sessions: store().listSessions({ query: input.query }) };
}

export function discoverSessions(): Promise<DiscoverResult> {
  if (!discoveryInFlight) {
    // Let the cached list reply go out before discovery starts touching session files and SQLite.
    discoveryInFlight = setImmediate()
      .then(() => runDiscovery(store(), ADAPTERS))
      .finally(() => {
        discoveryInFlight = null;
      });
  }
  return discoveryInFlight;
}

export async function cleanupSessions(input: { dryRun: boolean; reviewedIds?: string[] }) {
  if (!input.dryRun && !input.reviewedIds) throw new Error("Preview cleanup before marking sessions as JUNK");
  const reviewedIds = input.reviewedIds && new Set(input.reviewedIds);
  const result = runCleanup(store(), ACTOR, input.dryRun, reviewedIds);
  if (!result.dryRun) return { candidates: [], appliedCount: result.applied.length };
  return {
    candidates: result.candidates.map((session) => ({
      id: session.id,
      agent: session.agent,
      project: session.project,
      createdAt: session.createdAt,
      label: session.title ?? session.firstUserMessage ?? "(untitled session)",
      reason: session.classification?.reason ?? null,
    })),
    appliedCount: 0,
  };
}

export async function archiveSessionHandler(input: { id: string; reason?: string }) {
  return { session: archiveSession(store(), input.id, ACTOR, input.reason ?? null) };
}

export async function restoreSessionHandler(input: { id: string; reason?: string }) {
  return { session: restoreSession(store(), input.id, ACTOR, input.reason ?? null) };
}

export async function deleteSessionsHandler(
  input: { ids: string[]; confirmedProtectedIds?: string[]; reason?: string },
  { paseo }: PluginHandlerContext,
) {
  const linkedNativeSessionIds = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const { entries, pageInfo } = await paseo.agents.list({
      filter: { includeArchived: true },
      page: { limit: 200, cursor },
    });
    for (const { agent } of entries) {
      for (const id of [agent.persistence?.sessionId, agent.persistence?.nativeHandle, agent.runtimeInfo?.sessionId]) {
        if (id) linkedNativeSessionIds.add(id);
      }
    }
    if (!pageInfo.hasMore) break;
    if (!pageInfo.nextCursor || pageInfo.nextCursor === cursor) {
      throw new Error("Could not finish checking Paseo agent histories. Try again.");
    }
    cursor = pageInfo.nextCursor;
  }

  return deleteSessions(store(), ADAPTERS, input.ids, ACTOR, input.reason ?? null, {
    confirmedProtectedIds: new Set(input.confirmedProtectedIds),
    linkedNativeSessionIds,
  });
}

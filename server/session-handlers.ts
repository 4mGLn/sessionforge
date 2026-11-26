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
    // Defer opening the store until discoveryInFlight is set, so the first manual and background
    // requests share the same scan.
    discoveryInFlight = Promise.resolve()
      .then(() => runDiscovery(store(), ADAPTERS))
      .finally(() => {
        discoveryInFlight = null;
      });
  }
  return discoveryInFlight;
}

export async function cleanupSessions(input: { dryRun: boolean }) {
  const result = runCleanup(store(), ACTOR, input.dryRun);
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

export async function deleteSessionsHandler(input: { ids: string[]; reason?: string }) {
  return deleteSessions(store(), ADAPTERS, input.ids, ACTOR, input.reason ?? null);
}

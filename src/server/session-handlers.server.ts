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
} from "sessionforge-cli";
import type { SessionFilter } from "sessionforge-cli";

const ACTOR = "paseo-plugin";
const ADAPTERS = [new ClaudeCodeAdapter(), new CodexAdapter(), new GeminiCliAdapter(), new OpenCodeAdapter(), new AiderAdapter()];
const DISCOVERY_INTERVAL_MS = 5 * 60 * 1000;

let storeSingleton: SessionStore | null = null;
let backgroundInterval: ReturnType<typeof setInterval> | null = null;

function store(): SessionStore {
  if (!storeSingleton) storeSingleton = new SessionStore();
  ensureBackgroundDiscovery();
  return storeSingleton;
}

function ensureBackgroundDiscovery(): void {
  if (backgroundInterval || !storeSingleton) return;
  runDiscovery(storeSingleton, ADAPTERS).catch((error: unknown) => {
    console.error("SessionForge: initial discovery failed", error);
  });
  backgroundInterval = setInterval(() => {
    runDiscovery(store(), ADAPTERS).catch((error: unknown) => {
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
  return { sessions: store().listSessions(input), relationships: store().listAllRelationships() };
}

export async function showSession(input: { id: string }) {
  return { session: store().getSession(input.id), relationships: store().listRelationships(input.id) };
}

export async function searchSessions(input: { query: string }) {
  return { sessions: store().listSessions({ query: input.query }) };
}

export async function discoverSessions() {
  return runDiscovery(store(), ADAPTERS);
}

export async function cleanupSessions(input: { dryRun: boolean }) {
  return runCleanup(store(), ACTOR, input.dryRun);
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

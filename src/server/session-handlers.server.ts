import { ClaudeCodeAdapter } from "../core/claude-adapter.server.js";
import { CodexAdapter } from "../core/codex-adapter.server.js";
import { runDiscovery } from "../core/discover.server.js";
import { GeminiCliAdapter } from "../core/gemini-adapter.server.js";
import { archiveSession, deleteSessions, restoreSession, runCleanup } from "../core/lifecycle-actions.server.js";
import { SessionStore } from "../core/store.server.js";
import type { SessionFilter } from "../core/types.server.js";

const ACTOR = "paseo-plugin";
const ADAPTERS = [new ClaudeCodeAdapter(), new CodexAdapter(), new GeminiCliAdapter()];
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
  return { sessions: store().listSessions(input) };
}

export async function showSession(input: { id: string }) {
  return { session: store().getSession(input.id) };
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

import { setImmediate } from "node:timers/promises";
import type { AgentAdapter, ClassificationCategory, DiscoveredSession, Session, SessionActivity, SessionLifecycle } from "./types.server.js";
import { detectActivity } from "./activity.server.js";
import { classifySession } from "./classify.server.js";
import { detectRelationships } from "./relationships.server.js";
import { summarizeSession } from "./summarize.server.js";
import { SessionStore } from "./store.server.js";

/** Lifecycle values the user (or a cleanup action) has explicitly set. Discovery scans must not silently overwrite these. */
const STICKY_LIFECYCLES: ReadonlySet<SessionLifecycle> = new Set(["ARCHIVED", "JUNK", "DUPLICATE", "SUPERSEDED"]);
const DISCOVERY_BATCH_SIZE = 128;

export function defaultLifecycle(status: Session["status"], category: ClassificationCategory): SessionLifecycle {
  if (status === "ACTIVE" || status === "RECENT") return "ONGOING";
  if (category === "JUNK") return "ABANDONED";
  return "COMPLETED";
}

function sessionId(discovered: DiscoveredSession): string {
  return `${discovered.agent}:${discovered.nativeSessionId}`;
}

function toSession(discovered: DiscoveredSession, activity: SessionActivity, existing: Session | null): Session {
  const classification = classifySession({
    status: activity.status,
    lastActivityAt: discovered.lastActivityAt,
    messageCount: discovered.messageCount,
    userMessageCount: discovered.userMessageCount,
    assistantMessageCount: discovered.assistantMessageCount,
    firstUserMessage: discovered.firstUserMessage,
  });

  const preserveLifecycle = existing !== null && STICKY_LIFECYCLES.has(existing.lifecycle);
  const lifecycle = preserveLifecycle ? existing!.lifecycle : defaultLifecycle(activity.status, classification.category);
  const archivedAt = preserveLifecycle ? existing!.archivedAt : null;
  const summary = summarizeSession({
    title: discovered.title,
    firstUserMessage: discovered.firstUserMessage,
    userMessageCount: discovered.userMessageCount,
    classification,
  });

  return {
    id: sessionId(discovered),
    agent: discovered.agent,
    provider: discovered.provider,
    nativeSessionId: discovered.nativeSessionId,
    project: discovered.project,
    workspace: discovered.workspace,
    repository: discovered.repository,
    branch: discovered.branch,
    createdAt: discovered.createdAt,
    updatedAt: new Date().toISOString(),
    lastActivityAt: discovered.lastActivityAt,
    status: activity.status,
    activityConfidence: activity.confidence,
    lifecycle,
    title: discovered.title,
    summary,
    firstUserMessage: discovered.firstUserMessage,
    messageCount: discovered.messageCount,
    userMessageCount: discovered.userMessageCount,
    assistantMessageCount: discovered.assistantMessageCount,
    storagePath: discovered.storagePath,
    sizeBytes: discovered.sizeBytes,
    metadata: discovered.metadata,
    classification,
    archivedAt,
  };
}

export interface DiscoverResult {
  scanned: number;
  created: number;
  updated: number;
}

/** Runs every adapter's discover(), reconciles against the store, and persists. Safe to call repeatedly (idempotent upsert). */
export async function runDiscovery(store: SessionStore, adapters: readonly AgentAdapter[]): Promise<DiscoverResult> {
  let scanned = 0;
  let created = 0;
  let updated = 0;

  for (const adapter of adapters) {
    const discovered = await adapter.discover();
    for (let offset = 0; offset < discovered.length; offset += DISCOVERY_BATCH_SIZE) {
      const batch: { item: DiscoveredSession; activity: SessionActivity }[] = [];
      for (const item of discovered.slice(offset, offset + DISCOVERY_BATCH_SIZE)) {
        const activity = await detectActivity({
          agentId: item.agent,
          workspace: item.workspace,
          lastActivityAt: item.lastActivityAt,
        });
        batch.push({ item, activity });
      }
      // Read each lifecycle just before writing it, since the user can take action while probes run.
      store.runInTransaction(() => {
        for (const { item, activity } of batch) {
          const existing = store.getSession(sessionId(item));
          store.upsertSession(toSession(item, activity, existing));
          if (existing) updated += 1;
          else created += 1;
        }
      });
      scanned += batch.length;
      await setImmediate();
    }
  }

  // Relationships are cross-session (GOAL.md §8), so they can only be computed after every adapter's
  // sessions are upserted — recomputed wholesale each pass, same as classification is.
  store.replaceRelationships(detectRelationships(store.listSessions({})));

  return { scanned, created, updated };
}

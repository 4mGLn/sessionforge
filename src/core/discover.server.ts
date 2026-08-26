import type { AgentAdapter, ClassificationCategory, DiscoveredSession, Session, SessionLifecycle } from "./types.server.js";
import { detectActivity } from "./activity.server.js";
import { classifySession } from "./classify.server.js";
import { SessionStore } from "./store.server.js";

/** Lifecycle values the user (or a cleanup action) has explicitly set. Discovery scans must not silently overwrite these. */
const STICKY_LIFECYCLES: ReadonlySet<SessionLifecycle> = new Set(["ARCHIVED", "JUNK", "DUPLICATE", "SUPERSEDED"]);

export function defaultLifecycle(status: Session["status"], category: ClassificationCategory): SessionLifecycle {
  if (status === "ACTIVE" || status === "RECENT") return "ONGOING";
  if (category === "JUNK") return "ABANDONED";
  return "COMPLETED";
}

function sessionId(discovered: DiscoveredSession): string {
  return `${discovered.agent}:${discovered.nativeSessionId}`;
}

async function toSession(discovered: DiscoveredSession, existing: Session | null): Promise<Session> {
  const activity = await detectActivity({ workspace: discovered.workspace, lastActivityAt: discovered.lastActivityAt });
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
    summary: existing?.summary ?? null,
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
    for (const item of discovered) {
      scanned += 1;
      const id = sessionId(item);
      const existing = store.getSession(id);
      const session = await toSession(item, existing);
      store.upsertSession(session);
      if (existing) updated += 1;
      else created += 1;
    }
  }

  return { scanned, created, updated };
}

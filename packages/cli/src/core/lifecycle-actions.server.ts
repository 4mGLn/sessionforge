import type { AgentAdapter, Session } from "./types.server.js";
import { defaultLifecycle } from "./discover.server.js";
import type { SessionStore } from "./store.server.js";

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Sessions whose current classification recommends JUNK but that haven't already been acted on. */
export function junkCandidates(store: SessionStore): Session[] {
  return store
    .listSessions({ category: "JUNK" })
    .filter((session) => session.lifecycle !== "JUNK" && session.lifecycle !== "ARCHIVED");
}

export function archiveSession(store: SessionStore, id: string, actor: string, reason: string | null = null): Session {
  const session = store.getSession(id);
  if (!session) throw new SessionNotFoundError(id);

  const updated: Session = { ...session, lifecycle: "ARCHIVED", archivedAt: nowIso(), updatedAt: nowIso() };
  store.upsertSession(updated);
  store.recordAudit({
    sessionId: id,
    action: "ARCHIVE",
    previousLifecycle: session.lifecycle,
    newLifecycle: "ARCHIVED",
    actor,
    reason,
    at: nowIso(),
  });
  return updated;
}

/** Soft-trashes a session (lifecycle=JUNK). Never touches the agent-owned transcript on disk. */
export function trashSession(store: SessionStore, id: string, actor: string, reason: string | null = null): Session {
  const session = store.getSession(id);
  if (!session) throw new SessionNotFoundError(id);

  const updated: Session = { ...session, lifecycle: "JUNK", archivedAt: nowIso(), updatedAt: nowIso() };
  store.upsertSession(updated);
  store.recordAudit({
    sessionId: id,
    action: "TRASH",
    previousLifecycle: session.lifecycle,
    newLifecycle: "JUNK",
    actor,
    reason,
    at: nowIso(),
  });
  return updated;
}

export function restoreSession(store: SessionStore, id: string, actor: string, reason: string | null = null): Session {
  const session = store.getSession(id);
  if (!session) throw new SessionNotFoundError(id);

  const restoredLifecycle = defaultLifecycle(session.status, session.classification?.category ?? "KEEP");
  const updated: Session = { ...session, lifecycle: restoredLifecycle, archivedAt: null, updatedAt: nowIso() };
  store.upsertSession(updated);
  store.recordAudit({
    sessionId: id,
    action: "RESTORE",
    previousLifecycle: session.lifecycle,
    newLifecycle: restoredLifecycle,
    actor,
    reason,
    at: nowIso(),
  });
  return updated;
}

export interface DeleteResult {
  deleted: Session[];
  failed: Array<{ id: string; error: string }>;
}

/**
 * Moves a session's on-disk file to the OS trash via its agent adapter (see trash.server.ts), then drops
 * SessionForge's own record of it. The file itself is recoverable from the system trash, but SessionForge
 * offers no restore path once this runs — unlike archive/trash-in-app, which only ever change SessionForge's
 * `lifecycle` field. The audit entry is written before the row is dropped so the deletion stays visible in
 * `sessionforge audit` even though the session itself is gone.
 */
export async function deleteSession(
  store: SessionStore,
  adapters: readonly AgentAdapter[],
  id: string,
  actor: string,
  reason: string | null = null,
): Promise<Session> {
  const session = store.getSession(id);
  if (!session) throw new SessionNotFoundError(id);

  const adapter = adapters.find((candidate) => candidate.agent === session.agent);
  if (!adapter?.delete) throw new Error(`No delete capability registered for agent "${session.agent}"`);

  await adapter.delete(session.storagePath);

  store.recordAudit({
    sessionId: id,
    action: "DELETE",
    previousLifecycle: session.lifecycle,
    newLifecycle: null,
    actor,
    reason,
    at: nowIso(),
  });
  store.deleteSession(id);

  return session;
}

/** Bulk variant: best-effort per id, one failure doesn't block the rest. */
export async function deleteSessions(
  store: SessionStore,
  adapters: readonly AgentAdapter[],
  ids: readonly string[],
  actor: string,
  reason: string | null = null,
): Promise<DeleteResult> {
  const deleted: Session[] = [];
  const failed: Array<{ id: string; error: string }> = [];

  for (const id of ids) {
    try {
      deleted.push(await deleteSession(store, adapters, id, actor, reason));
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { deleted, failed };
}

export interface CleanupResult {
  dryRun: boolean;
  candidates: Session[];
  applied: Session[];
}

/** GOAL §11/§12: dry-run by default. Only trashes sessions when `dryRun` is explicitly false. */
export function runCleanup(store: SessionStore, actor: string, dryRun: boolean): CleanupResult {
  const candidates = junkCandidates(store);
  if (dryRun) {
    return { dryRun: true, candidates, applied: [] };
  }

  const applied = candidates.map((session) =>
    trashSession(store, session.id, actor, session.classification?.reason ?? null),
  );
  return { dryRun: false, candidates, applied };
}

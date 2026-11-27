import { stat } from "node:fs/promises";
import { detectActivity } from "./activity.server.js";
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
    .filter((session) =>
      session.lifecycle !== "JUNK" && session.lifecycle !== "ARCHIVED" && !hasProtectedActivity(session),
    );
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
  failed: Array<{ id: string; error: string; confirmation?: { label: string; project: string } }>;
}

export interface DeleteOptions {
  confirmedProtectedIds?: ReadonlySet<string>;
  linkedNativeSessionIds?: ReadonlySet<string>;
}

function hasProtectedActivity(session: Session): boolean {
  return session.lifecycle === "ONGOING" ||
    session.status === "ACTIVE" || session.status === "RECENT" || session.status === "UNKNOWN";
}

class DeleteConfirmationRequiredError extends Error {
  constructor(readonly session: Session, reason: string) {
    super(reason);
  }
}

async function protectedDeleteReason(session: Session, options: DeleteOptions): Promise<string | null> {
  if (options.linkedNativeSessionIds?.has(session.nativeSessionId)) return "Linked to a saved Paseo agent";
  if (hasProtectedActivity(session)) return "Active, recent, ongoing, or unverified session";
  if (session.classification?.category !== "JUNK") return "Classified outside JUNK";
  if (process.platform === "win32") return "Running session cannot be ruled out on Windows";

  const file = await stat(session.storagePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const storedTime = Date.parse(session.lastActivityAt);
  if (!Number.isFinite(storedTime)) return "Session activity could not be verified";
  const lastActivityAt = new Date(Math.max(storedTime, file?.mtimeMs ?? 0)).toISOString();
  const { status } = await detectActivity({ agentId: session.agent, workspace: session.workspace, lastActivityAt });
  return status === "ACTIVE" || status === "RECENT" || status === "UNKNOWN"
    ? "Live process or recent transcript activity detected"
    : null;
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
  options: DeleteOptions = {},
): Promise<Session> {
  const session = store.getSession(id);
  if (!session) throw new SessionNotFoundError(id);

  const adapter = adapters.find((candidate) => candidate.agent === session.agent);
  if (!adapter?.delete) throw new Error(`No delete capability registered for agent "${session.agent}"`);

  const confirmed = options.confirmedProtectedIds?.has(id) === true;
  if (!confirmed) {
    const protection = await protectedDeleteReason(session, options);
    if (protection) throw new DeleteConfirmationRequiredError(session, protection);
    // Discovery can update the row while filesystem and process checks are pending.
    const current = store.getSession(id);
    if (!current) throw new SessionNotFoundError(id);
    if (current.storagePath !== session.storagePath || current.nativeSessionId !== session.nativeSessionId) {
      throw new Error("Session file changed. Review the selection again.");
    }
    if (hasProtectedActivity(current) || current.classification?.category !== "JUNK") {
      throw new DeleteConfirmationRequiredError(current, "Session activity or classification changed");
    }
  }

  await adapter.delete(session.storagePath);

  store.recordAudit({
    sessionId: id,
    action: "DELETE",
    previousLifecycle: session.lifecycle,
    newLifecycle: null,
    actor,
    reason: reason ?? (confirmed ? "Explicitly approved protected history move" : null),
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
  options: DeleteOptions = {},
): Promise<DeleteResult> {
  const deleted: Session[] = [];
  const failed: DeleteResult["failed"] = [];

  for (const id of new Set(ids)) {
    try {
      deleted.push(await deleteSession(store, adapters, id, actor, reason, options));
    } catch (error) {
      if (error instanceof DeleteConfirmationRequiredError) {
        failed.push({
          id,
          error: error.message,
          confirmation: {
            label: error.session.title ?? error.session.firstUserMessage ?? id,
            project: error.session.project,
          },
        });
        continue;
      }
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
export function runCleanup(
  store: SessionStore, actor: string, dryRun: boolean, reviewedIds?: ReadonlySet<string>,
): CleanupResult {
  if (dryRun) {
    return { dryRun: true, candidates: junkCandidates(store), applied: [] };
  }

  return store.runInTransaction(() => {
    const candidates = junkCandidates(store).filter((session) => !reviewedIds || reviewedIds.has(session.id));
    const applied = candidates.map((session) =>
      trashSession(store, session.id, actor, session.classification?.reason ?? null),
    );
    return { dryRun: false, candidates, applied };
  });
}

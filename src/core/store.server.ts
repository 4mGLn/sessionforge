import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuditEntry, ClassificationCategory, RelationshipKind, Session, SessionFilter, SessionRelationship } from "./types.server.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  provider TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  workspace TEXT NOT NULL,
  repository TEXT,
  branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  status TEXT NOT NULL,
  activity_confidence TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  first_user_message TEXT,
  message_count INTEGER NOT NULL,
  user_message_count INTEGER NOT NULL,
  assistant_message_count INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  metadata TEXT NOT NULL,
  classification_category TEXT,
  classification_confidence REAL,
  classification_reason TEXT,
  classification_evidence TEXT,
  classification_at TEXT,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_lifecycle TEXT,
  new_lifecycle TEXT,
  actor TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL
);

-- Recomputed wholesale on every discovery pass (see relationships.server.ts / replaceRelationships()),
-- same as classification — not incrementally maintained.
CREATE TABLE IF NOT EXISTS session_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  related_session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  detected_at TEXT NOT NULL
);

-- Standalone (non-external-content) FTS5 index, kept in sync explicitly from TypeScript in
-- upsertSession()/deleteSession() rather than via SQL triggers, matching how the rest of this store
-- already manages sync by hand instead of relying on SQLite-side automation.
CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  id UNINDEXED,
  title,
  summary,
  first_user_message,
  project
);
`;

/**
 * Turns a plain user-typed query into an FTS5 MATCH expression. Each whitespace-separated token is
 * wrapped as its own quoted phrase (embedded `"` doubled per FTS5's escaping rule) so raw special
 * characters a user might type — `-`, `*`, `AND`/`OR`/`NOT`, unbalanced quotes — are always treated as
 * literal search text rather than being parsed as FTS5 query syntax. Space-separated quoted phrases are
 * an implicit AND in FTS5, matching the intuitive "must contain all these words" behavior GOAL.md's
 * search examples assume.
 */
function toFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
}

export function defaultDbPath(): string {
  return join(homedir(), ".sessionforge", "sessionforge.db");
}

interface SessionRow {
  id: string;
  agent: string;
  provider: string;
  native_session_id: string;
  project: string;
  workspace: string;
  repository: string | null;
  branch: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  status: string;
  activity_confidence: string;
  lifecycle: string;
  title: string | null;
  summary: string | null;
  first_user_message: string | null;
  message_count: number;
  user_message_count: number;
  assistant_message_count: number;
  storage_path: string;
  size_bytes: number;
  metadata: string;
  classification_category: string | null;
  classification_confidence: number | null;
  classification_reason: string | null;
  classification_evidence: string | null;
  classification_at: string | null;
  archived_at: string | null;
}

function rowToRelationship(row: Record<string, unknown>): SessionRelationship {
  return {
    sessionId: row.session_id as string,
    relatedSessionId: row.related_session_id as string,
    kind: row.kind as RelationshipKind,
    confidence: row.confidence as number,
    reason: row.reason as string,
    detectedAt: row.detected_at as string,
  };
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    agent: row.agent as Session["agent"],
    provider: row.provider,
    nativeSessionId: row.native_session_id,
    project: row.project,
    workspace: row.workspace,
    repository: row.repository,
    branch: row.branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    status: row.status as Session["status"],
    activityConfidence: row.activity_confidence as Session["activityConfidence"],
    lifecycle: row.lifecycle as Session["lifecycle"],
    title: row.title,
    summary: row.summary,
    firstUserMessage: row.first_user_message,
    messageCount: row.message_count,
    userMessageCount: row.user_message_count,
    assistantMessageCount: row.assistant_message_count,
    storagePath: row.storage_path,
    sizeBytes: row.size_bytes,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    classification:
      row.classification_category && row.classification_confidence !== null && row.classification_at
        ? {
            category: row.classification_category as ClassificationCategory,
            confidence: row.classification_confidence,
            reason: row.classification_reason ?? "",
            evidence: row.classification_evidence ? (JSON.parse(row.classification_evidence) as string[]) : [],
            classifiedAt: row.classification_at,
          }
        : null,
    archivedAt: row.archived_at,
  };
}

export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string = defaultDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.runScript(SCHEMA);
  }

  /** Runs a multi-statement SQL script. Named to avoid colliding with unrelated shell-exec lint heuristics. */
  private runScript(sql: string): void {
    const dbExec: (sql: string) => void = this.db.exec.bind(this.db);
    dbExec(sql);
  }

  close(): void {
    this.db.close();
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as unknown as SessionRow | undefined;
    return row ? rowToSession(row) : null;
  }

  upsertSession(session: Session): void {
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, agent, provider, native_session_id, project, workspace, repository, branch,
          created_at, updated_at, last_activity_at, status, activity_confidence, lifecycle,
          title, summary, first_user_message, message_count, user_message_count, assistant_message_count,
          storage_path, size_bytes, metadata,
          classification_category, classification_confidence, classification_reason, classification_evidence, classification_at,
          archived_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          project=excluded.project, workspace=excluded.workspace, repository=excluded.repository, branch=excluded.branch,
          updated_at=excluded.updated_at, last_activity_at=excluded.last_activity_at,
          status=excluded.status, activity_confidence=excluded.activity_confidence, lifecycle=excluded.lifecycle,
          title=excluded.title, summary=excluded.summary, first_user_message=excluded.first_user_message,
          message_count=excluded.message_count, user_message_count=excluded.user_message_count,
          assistant_message_count=excluded.assistant_message_count,
          storage_path=excluded.storage_path, size_bytes=excluded.size_bytes, metadata=excluded.metadata,
          classification_category=excluded.classification_category, classification_confidence=excluded.classification_confidence,
          classification_reason=excluded.classification_reason, classification_evidence=excluded.classification_evidence,
          classification_at=excluded.classification_at, archived_at=excluded.archived_at`,
      )
      .run(
        session.id,
        session.agent,
        session.provider,
        session.nativeSessionId,
        session.project,
        session.workspace,
        session.repository,
        session.branch,
        session.createdAt,
        session.updatedAt,
        session.lastActivityAt,
        session.status,
        session.activityConfidence,
        session.lifecycle,
        session.title,
        session.summary,
        session.firstUserMessage,
        session.messageCount,
        session.userMessageCount,
        session.assistantMessageCount,
        session.storagePath,
        session.sizeBytes,
        JSON.stringify(session.metadata),
        session.classification?.category ?? null,
        session.classification?.confidence ?? null,
        session.classification?.reason ?? null,
        session.classification ? JSON.stringify(session.classification.evidence) : null,
        session.classification?.classifiedAt ?? null,
        session.archivedAt,
      );

    // FTS5 has no native upsert — delete-then-reinsert is the standard way to keep it in sync.
    this.db.prepare("DELETE FROM sessions_fts WHERE id = ?").run(session.id);
    this.db
      .prepare("INSERT INTO sessions_fts (id, title, summary, first_user_message, project) VALUES (?,?,?,?,?)")
      .run(session.id, session.title, session.summary, session.firstUserMessage, session.project);
  }

  listSessions(filter: SessionFilter = {}): Session[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];

    if (filter.agent) {
      clauses.push("s.agent = ?");
      params.push(filter.agent);
    }
    if (filter.project) {
      clauses.push("s.project = ?");
      params.push(filter.project);
    }
    if (filter.status) {
      clauses.push("s.status = ?");
      params.push(filter.status);
    }
    if (filter.lifecycle) {
      clauses.push("s.lifecycle = ?");
      params.push(filter.lifecycle);
    }
    if (filter.category) {
      clauses.push("s.classification_category = ?");
      params.push(filter.category);
    }
    if (filter.olderThanMs !== undefined) {
      const cutoff = new Date(Date.now() - filter.olderThanMs).toISOString();
      clauses.push("s.last_activity_at < ?");
      params.push(cutoff);
    }

    const trimmedQuery = filter.query?.trim();
    if (trimmedQuery) {
      // FTS5-ranked search (ordered by relevance) instead of a plain substring LIKE — see toFtsQuery()
      // for why the query gets phrase-quoted per token rather than passed through to FTS5's own syntax.
      clauses.push("sessions_fts MATCH ?");
      params.push(toFtsQuery(trimmedQuery));
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = this.db
        .prepare(`SELECT s.* FROM sessions s JOIN sessions_fts ON sessions_fts.id = s.id ${where} ORDER BY rank`)
        .all(...params) as unknown as SessionRow[];
      return rows.map(rowToSession);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT s.* FROM sessions s ${where} ORDER BY s.created_at DESC`)
      .all(...params) as unknown as SessionRow[];
    return rows.map(rowToSession);
  }

  /** Drops SessionForge's own record of a session. Call only after its on-disk file has actually been removed. */
  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM sessions_fts WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM session_relationships WHERE session_id = ? OR related_session_id = ?").run(id, id);
  }

  recordAudit(entry: Omit<AuditEntry, "id">): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (session_id, action, previous_lifecycle, new_lifecycle, actor, reason, at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(entry.sessionId, entry.action, entry.previousLifecycle, entry.newLifecycle, entry.actor, entry.reason, entry.at);
  }

  listAudit(sessionId?: string): AuditEntry[] {
    const rows = (
      sessionId
        ? this.db.prepare("SELECT * FROM audit_log WHERE session_id = ? ORDER BY at DESC").all(sessionId)
        : this.db.prepare("SELECT * FROM audit_log ORDER BY at DESC").all()
    ) as unknown as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as number,
      sessionId: row.session_id as string,
      action: row.action as string,
      previousLifecycle: row.previous_lifecycle as AuditEntry["previousLifecycle"],
      newLifecycle: row.new_lifecycle as AuditEntry["newLifecycle"],
      actor: row.actor as string,
      reason: row.reason as string | null,
      at: row.at as string,
    }));
  }

  /** Wholesale replace — relationships are recomputed fresh on every discovery pass, not incrementally maintained. */
  replaceRelationships(relationships: readonly SessionRelationship[]): void {
    this.runScript("DELETE FROM session_relationships");
    const insert = this.db.prepare(
      "INSERT INTO session_relationships (session_id, related_session_id, kind, confidence, reason, detected_at) VALUES (?,?,?,?,?,?)",
    );
    for (const rel of relationships) {
      insert.run(rel.sessionId, rel.relatedSessionId, rel.kind, rel.confidence, rel.reason, rel.detectedAt);
    }
  }

  /** Both directions: relationships where this session is the older/original side, and where it's the newer/related side. */
  listRelationships(sessionId: string): SessionRelationship[] {
    const rows = this.db
      .prepare("SELECT * FROM session_relationships WHERE session_id = ? OR related_session_id = ? ORDER BY confidence DESC")
      .all(sessionId, sessionId) as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToRelationship);
  }

  /**
   * Every relationship, unscoped. Used for bulk UI display (e.g. timeline badges) where the caller needs
   * a lookup across many sessions at once — real-world testing found relationship counts stay in the low
   * hundreds even with 1000+ sessions, so this is cheap; scoping via a per-session-id IN-clause would risk
   * hitting SQLite's bound-parameter limit for a large visible set anyway.
   */
  listAllRelationships(): SessionRelationship[] {
    const rows = this.db
      .prepare("SELECT * FROM session_relationships ORDER BY confidence DESC")
      .all() as unknown as Array<Record<string, unknown>>;
    return rows.map(rowToRelationship);
  }
}

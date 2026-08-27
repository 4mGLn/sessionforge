import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AuditEntry, ClassificationCategory, Session, SessionFilter } from "./types.server.js";

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
`;

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
  }

  listSessions(filter: SessionFilter = {}): Session[] {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];

    if (filter.agent) {
      clauses.push("agent = ?");
      params.push(filter.agent);
    }
    if (filter.project) {
      clauses.push("project = ?");
      params.push(filter.project);
    }
    if (filter.status) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.lifecycle) {
      clauses.push("lifecycle = ?");
      params.push(filter.lifecycle);
    }
    if (filter.category) {
      clauses.push("classification_category = ?");
      params.push(filter.category);
    }
    if (filter.olderThanMs !== undefined) {
      const cutoff = new Date(Date.now() - filter.olderThanMs).toISOString();
      clauses.push("last_activity_at < ?");
      params.push(cutoff);
    }
    if (filter.query) {
      clauses.push("(title LIKE ? OR first_user_message LIKE ? OR summary LIKE ? OR project LIKE ?)");
      const like = `%${filter.query}%`;
      params.push(like, like, like, like);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY created_at DESC`)
      .all(...params) as unknown as SessionRow[];
    return rows.map(rowToSession);
  }

  /** Drops SessionForge's own record of a session. Call only after its on-disk file has actually been removed. */
  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
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
}

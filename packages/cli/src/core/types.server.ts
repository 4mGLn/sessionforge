export type AgentId = "claude-code" | "codex" | "gemini-cli" | "aider" | "opencode" | "custom";

export type SessionStatus = "ACTIVE" | "RECENT" | "IDLE" | "STALE" | "UNKNOWN";

export type ActivityConfidence = "HIGH" | "MEDIUM" | "LOW";

export type SessionLifecycle =
  | "ONGOING"
  | "COMPLETED"
  | "ABANDONED"
  | "ARCHIVED"
  | "JUNK"
  | "DUPLICATE"
  | "SUPERSEDED"
  | "UNKNOWN";

export type ClassificationCategory = "KEEP" | "ARCHIVE" | "JUNK";

export interface SessionActivity {
  status: SessionStatus;
  confidence: ActivityConfidence;
  signals: readonly string[];
}

export interface SessionClassification {
  category: ClassificationCategory;
  confidence: number;
  reason: string;
  evidence: string[];
  classifiedAt: string;
}

/** What an agent adapter produces by reading agent-owned session storage. Read-only — adapters never mutate agent files. */
export interface DiscoveredSession {
  agent: AgentId;
  provider: string;
  nativeSessionId: string;
  project: string;
  workspace: string;
  repository: string | null;
  branch: string | null;
  createdAt: string;
  lastActivityAt: string;
  title: string | null;
  firstUserMessage: string | null;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  storagePath: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
}

/** Full normalized session as stored/served by SessionForge: discovery output plus SessionForge-owned derived state. */
export interface Session {
  id: string;
  agent: AgentId;
  provider: string;
  nativeSessionId: string;
  project: string;
  workspace: string;
  repository: string | null;
  branch: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  status: SessionStatus;
  activityConfidence: ActivityConfidence;
  lifecycle: SessionLifecycle;
  title: string | null;
  summary: string | null;
  firstUserMessage: string | null;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  storagePath: string;
  sizeBytes: number;
  metadata: Record<string, unknown>;
  classification: SessionClassification | null;
  archivedAt: string | null;
}

export interface AgentAdapter {
  readonly agent: AgentId;
  discover(): Promise<DiscoveredSession[]>;
  /** Explicit, user-confirmed deletion of a single session's on-disk file. Never called during discover(). */
  delete?(storagePath: string): Promise<void>;
}

export type RelationshipKind = "DUPLICATE" | "SUPERSEDED";

/**
 * A detected cross-session relationship (GOAL.md §7/§8). Informational only — detecting a relationship
 * never mutates either session's own `lifecycle` on its own; recomputed fresh on every discovery pass,
 * same as classification.
 */
export interface SessionRelationship {
  sessionId: string;
  relatedSessionId: string;
  kind: RelationshipKind;
  confidence: number;
  reason: string;
  detectedAt: string;
}

export interface AuditEntry {
  id: number;
  sessionId: string;
  action: string;
  previousLifecycle: SessionLifecycle | null;
  newLifecycle: SessionLifecycle | null;
  actor: string;
  reason: string | null;
  at: string;
}

export interface SessionFilter {
  agent?: AgentId;
  project?: string;
  status?: SessionStatus;
  lifecycle?: SessionLifecycle;
  category?: ClassificationCategory;
  olderThanMs?: number;
  query?: string;
}

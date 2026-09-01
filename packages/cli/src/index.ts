// Public library surface of sessionforge. This is what a consumer (the SessionForge Paseo plugin
// itself, or any other Node project) gets from `import { ... } from "sessionforge"` — everything here
// is agent-agnostic domain logic with zero Paseo/RPC/React dependency; see the CLI (src/cli/bin.ts) and
// the Paseo plugin (../../../index.ts) for the two current consumers of this same engine.

export type {
  AgentAdapter,
  AgentId,
  ActivityConfidence,
  AuditEntry,
  ClassificationCategory,
  DiscoveredSession,
  RelationshipKind,
  Session,
  SessionActivity,
  SessionClassification,
  SessionFilter,
  SessionLifecycle,
  SessionRelationship,
  SessionStatus,
} from "./core/types.server.js";

export { AiderAdapter } from "./core/aider-adapter.server.js";
export { ClaudeCodeAdapter } from "./core/claude-adapter.server.js";
export { CodexAdapter } from "./core/codex-adapter.server.js";
export { GeminiCliAdapter } from "./core/gemini-adapter.server.js";
export { OpenCodeAdapter } from "./core/opencode-adapter.server.js";

export type { ParsedTranscript } from "./core/claude-transcript.server.js";
export { parseClaudeTranscript } from "./core/claude-transcript.server.js";

export type { ActivityInput } from "./core/activity.server.js";
export { detectActivity } from "./core/activity.server.js";

export type { ClassifyInput } from "./core/classify.server.js";
export { classifySession } from "./core/classify.server.js";

export type { SummarizeInput } from "./core/summarize.server.js";
export { summarizeSession } from "./core/summarize.server.js";

export { detectRelationships } from "./core/relationships.server.js";

export type { DiscoverResult } from "./core/discover.server.js";
export { defaultLifecycle, runDiscovery } from "./core/discover.server.js";

export type { CleanupResult, DeleteResult } from "./core/lifecycle-actions.server.js";
export {
  SessionNotFoundError,
  archiveSession,
  deleteSession,
  deleteSessions,
  junkCandidates,
  restoreSession,
  runCleanup,
  trashSession,
} from "./core/lifecycle-actions.server.js";

export { defaultDbPath, SessionStore } from "./core/store.server.js";

export { moveToTrash } from "./core/trash.server.js";

export { capFirstMessage } from "./core/text-utils.server.js";

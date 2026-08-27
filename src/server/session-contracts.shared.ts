import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const AgentIdSchema = z.enum(["claude-code", "codex", "gemini-cli", "aider", "opencode", "custom"]);
export const SessionStatusSchema = z.enum(["ACTIVE", "RECENT", "IDLE", "STALE", "UNKNOWN"]);
export const ActivityConfidenceSchema = z.enum(["HIGH", "MEDIUM", "LOW"]);
export const SessionLifecycleSchema = z.enum([
  "ONGOING",
  "COMPLETED",
  "ABANDONED",
  "ARCHIVED",
  "JUNK",
  "DUPLICATE",
  "SUPERSEDED",
  "UNKNOWN",
]);
export const ClassificationCategorySchema = z.enum(["KEEP", "ARCHIVE", "JUNK"]);

export const SessionClassificationSchema = z.object({
  category: ClassificationCategorySchema,
  confidence: z.number(),
  reason: z.string(),
  evidence: z.array(z.string()),
  classifiedAt: z.string(),
});

export const SessionSchema = z.object({
  id: z.string(),
  agent: AgentIdSchema,
  provider: z.string(),
  nativeSessionId: z.string(),
  project: z.string(),
  workspace: z.string(),
  repository: z.string().nullable(),
  branch: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActivityAt: z.string(),
  status: SessionStatusSchema,
  activityConfidence: ActivityConfidenceSchema,
  lifecycle: SessionLifecycleSchema,
  title: z.string().nullable(),
  summary: z.string().nullable(),
  firstUserMessage: z.string().nullable(),
  messageCount: z.number(),
  userMessageCount: z.number(),
  assistantMessageCount: z.number(),
  storagePath: z.string(),
  sizeBytes: z.number(),
  metadata: z.record(z.string(), z.unknown()),
  classification: SessionClassificationSchema.nullable(),
  archivedAt: z.string().nullable(),
});

export const SessionFilterSchema = z.object({
  agent: AgentIdSchema.optional(),
  project: z.string().optional(),
  status: SessionStatusSchema.optional(),
  lifecycle: SessionLifecycleSchema.optional(),
  category: ClassificationCategorySchema.optional(),
  olderThanMs: z.number().optional(),
  query: z.string().optional(),
});

export const listSessionsRpc = defineRpc({
  name: "session.list",
  input: SessionFilterSchema,
  output: z.object({ sessions: z.array(SessionSchema) }),
});

export const showSessionRpc = defineRpc({
  name: "session.show",
  input: z.object({ id: z.string() }),
  output: z.object({ session: SessionSchema.nullable() }),
});

export const searchSessionsRpc = defineRpc({
  name: "session.search",
  input: z.object({ query: z.string() }),
  output: z.object({ sessions: z.array(SessionSchema) }),
});

export const discoverSessionsRpc = defineRpc({
  name: "session.discover",
  input: z.object({}),
  output: z.object({ scanned: z.number(), created: z.number(), updated: z.number() }),
});

export const cleanupSessionsRpc = defineRpc({
  name: "session.cleanup",
  input: z.object({ dryRun: z.boolean().default(true) }),
  output: z.object({ dryRun: z.boolean(), candidates: z.array(SessionSchema), applied: z.array(SessionSchema) }),
});

export const archiveSessionRpc = defineRpc({
  name: "session.archive",
  input: z.object({ id: z.string(), reason: z.string().optional() }),
  output: z.object({ session: SessionSchema }),
});

export const restoreSessionRpc = defineRpc({
  name: "session.restore",
  input: z.object({ id: z.string(), reason: z.string().optional() }),
  output: z.object({ session: SessionSchema }),
});

export const deleteSessionsRpc = defineRpc({
  name: "session.delete",
  input: z.object({ ids: z.array(z.string()), reason: z.string().optional() }),
  output: z.object({
    deleted: z.array(SessionSchema),
    failed: z.array(z.object({ id: z.string(), error: z.string() })),
  }),
});

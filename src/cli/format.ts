import type { Session, SessionRelationship } from "../core/types.server.js";

function pad(value: string, width: number): string {
  return value.length >= width ? `${value.slice(0, width - 1)}…` : value.padEnd(width);
}

function formatDate(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

export function formatSessionTable(sessions: readonly Session[]): string {
  if (sessions.length === 0) return "No sessions found.";

  const columns: Array<{ header: string; width: number; get: (s: Session) => string }> = [
    { header: "DATE", width: 18, get: (s) => formatDate(s.createdAt) },
    { header: "STATUS", width: 9, get: (s) => s.status },
    { header: "LIFECYCLE", width: 11, get: (s) => s.lifecycle },
    { header: "RECOMMEND", width: 10, get: (s) => s.classification?.category ?? "-" },
    { header: "AGENT", width: 13, get: (s) => s.agent },
    { header: "PROJECT", width: 20, get: (s) => s.project },
    { header: "TITLE", width: 40, get: (s) => s.title ?? s.firstUserMessage ?? "" },
  ];

  const headerLine = columns.map((c) => pad(c.header, c.width)).join(" ");
  const separator = "-".repeat(headerLine.length);
  const rows = sessions.map((session) => columns.map((c) => pad(c.get(session), c.width)).join(" "));

  return [headerLine, separator, ...rows].join("\n");
}

export function formatSessionDetail(session: Session, relationships: readonly SessionRelationship[] = []): string {
  const lines = [
    "Session",
    "-".repeat(42),
    "",
    `ID:            ${session.id}`,
    `Agent:         ${session.agent}`,
    `Project:       ${session.project}`,
    `Workspace:     ${session.workspace}`,
    `Branch:        ${session.branch ?? "-"}`,
    `Created:       ${formatDate(session.createdAt)}`,
    `Last Activity: ${formatDate(session.lastActivityAt)}`,
    "",
    `Status:        ${session.status} (confidence: ${session.activityConfidence})`,
    `Lifecycle:     ${session.lifecycle}`,
    "",
    `Title:         ${session.title ?? "-"}`,
    "",
    `Summary:       ${session.summary ?? "-"}`,
    "",
    "Activity:",
    `  ${session.messageCount} messages`,
    `  ${session.userMessageCount} user messages`,
    `  ${session.assistantMessageCount} assistant messages`,
    `  ${session.sizeBytes} bytes on disk`,
    `  storage: ${session.storagePath}`,
  ];

  if (session.classification) {
    lines.push(
      "",
      `Recommendation: ${session.classification.category} (confidence: ${session.classification.confidence.toFixed(2)})`,
      `Reason: ${session.classification.reason}`,
      "Evidence:",
      ...session.classification.evidence.map((e) => `  - ${e}`),
    );
  }

  if (session.archivedAt) {
    lines.push("", `Archived at: ${formatDate(session.archivedAt)}`);
  }

  if (relationships.length > 0) {
    lines.push("", "Related sessions:");
    for (const rel of relationships) {
      const otherId = rel.sessionId === session.id ? rel.relatedSessionId : rel.sessionId;
      const direction =
        rel.kind === "SUPERSEDED" ? (rel.sessionId === session.id ? "superseded by" : "supersedes") : "possible duplicate of";
      lines.push(`  ${direction} ${otherId} (${Math.round(rel.confidence * 100)}% confidence)`, `    ${rel.reason}`);
    }
  }

  return lines.join("\n");
}

const OLDER_THAN_PATTERN = /^(\d+)([smhd])$/;
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseOlderThan(spec: string): number {
  const match = spec.trim().match(OLDER_THAN_PATTERN);
  if (!match) throw new Error(`Invalid --older-than value: ${spec} (expected e.g. 30d, 12h, 45m)`);
  const amount = Number(match[1]);
  return amount * UNIT_MS[match[2] as string];
}

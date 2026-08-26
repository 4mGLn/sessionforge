import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentAdapter, DiscoveredSession } from "./types.server.js";
import { capFirstMessage } from "./text-utils.server.js";

function codexHomeDir(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

/** Codex's title/first_user_message columns can hold raw multi-line pasted terminal output verbatim. */
function collapseWhitespace(text: string): string | null {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed || null;
}

function truncateTitle(text: string): string | null {
  const collapsed = collapseWhitespace(text);
  if (!collapsed) return null;
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}...` : collapsed;
}

interface ThreadRow {
  id: string;
  cwd: string;
  title: string;
  created_at_ms: number;
  updated_at_ms: number;
  git_branch: string | null;
  first_user_message: string;
  rollout_path: string;
  archived: number;
}

/** Reads Codex's own state DB directly. Read-only: never opens the DB for writes. */
export class CodexAdapter implements AgentAdapter {
  readonly agent = "codex" as const;

  async discover(): Promise<DiscoveredSession[]> {
    const statePath = join(codexHomeDir(), "state_5.sqlite");
    if (!existsSync(statePath)) return [];

    let db: DatabaseSync;
    try {
      db = new DatabaseSync(statePath, { readOnly: true });
    } catch {
      return [];
    }

    try {
      const threads = db.prepare("SELECT * FROM threads").all() as unknown as ThreadRow[];
      const counts = this.readMessageCounts();

      return threads.map((thread) => {
        const messageCounts = counts.get(thread.id);
        const userMessageCount = messageCounts?.user ?? 0;
        const assistantMessageCount = messageCounts?.agent ?? 0;

        return {
          agent: "codex",
          provider: "codex",
          nativeSessionId: thread.id,
          project: basename(thread.cwd) || thread.cwd,
          workspace: thread.cwd,
          repository: null,
          branch: thread.git_branch && thread.git_branch !== "HEAD" ? thread.git_branch : null,
          createdAt: new Date(thread.created_at_ms).toISOString(),
          lastActivityAt: new Date(thread.updated_at_ms).toISOString(),
          title: thread.title ? truncateTitle(thread.title) : null,
          firstUserMessage: thread.first_user_message.trim() ? capFirstMessage(thread.first_user_message) : null,
          messageCount: userMessageCount + assistantMessageCount,
          userMessageCount,
          assistantMessageCount,
          storagePath: thread.rollout_path,
          sizeBytes: this.statSizeSafe(thread.rollout_path),
          metadata: { codexArchived: thread.archived === 1 },
        };
      });
    } finally {
      db.close();
    }
  }

  private statSizeSafe(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  /** Best-effort: only threads Codex has locally cached turn history for get real counts; the rest report 0. */
  private readMessageCounts(): Map<string, { user: number; agent: number }> {
    const counts = new Map<string, { user: number; agent: number }>();
    const historyPath = join(codexHomeDir(), "thread_history_1.sqlite");
    if (!existsSync(historyPath)) return counts;

    let db: DatabaseSync;
    try {
      db = new DatabaseSync(historyPath, { readOnly: true });
    } catch {
      return counts;
    }

    try {
      const rows = db
        .prepare(
          "SELECT thread_id, item_type, COUNT(*) as n FROM thread_items WHERE item_type IN ('userMessage','agentMessage') GROUP BY thread_id, item_type",
        )
        .all() as unknown as Array<{ thread_id: string; item_type: string; n: number }>;

      for (const row of rows) {
        const entry = counts.get(row.thread_id) ?? { user: 0, agent: 0 };
        if (row.item_type === "userMessage") entry.user = row.n;
        else if (row.item_type === "agentMessage") entry.agent = row.n;
        counts.set(row.thread_id, entry);
      }
      return counts;
    } catch {
      return counts;
    } finally {
      db.close();
    }
  }
}

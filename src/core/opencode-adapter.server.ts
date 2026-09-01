import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentAdapter, DiscoveredSession } from "./types.server.js";
import { capFirstMessage } from "./text-utils.server.js";

function opencodeDataDir(): string {
  return process.env.OPENCODE_DATA_DIR ?? join(homedir(), ".local", "share", "opencode");
}

function collapseWhitespace(text: string): string | null {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed || null;
}

function truncateTitle(text: string): string | null {
  const collapsed = collapseWhitespace(text);
  if (!collapsed) return null;
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}...` : collapsed;
}

interface SessionRow {
  id: string;
  directory: string;
  title: string | null;
  time_created: number;
  time_updated: number;
}

/**
 * Reads OpenCode's own SQLite database directly (`~/.local/share/opencode/opencode.db`). Read-only: never
 * opens the DB for writes. Unlike the other three adapters, there's no `delete()` here — OpenCode has no
 * discrete per-session file; every session lives as rows across a handful of tables in one SQLite database
 * that OpenCode itself actively writes to (confirmed via its WAL journal being present), so SessionForge
 * never opens it for anything but a read-only connection, matching the same "never write to another tool's
 * live database" principle the Codex adapter follows for its own state DB.
 *
 * Note: at least one observed OpenCode version/config on this machine has a real upstream data-quality
 * quirk where `session.title` sometimes holds the model's own title-generation meta-commentary (e.g. "Let
 * me analyze the conversation to create an appropriate title.") instead of the actual generated title.
 * This adapter passes titles through as-is, same as every other adapter — `firstUserMessage` remains the
 * reliable fallback regardless.
 */
export class OpenCodeAdapter implements AgentAdapter {
  readonly agent = "opencode" as const;

  async discover(): Promise<DiscoveredSession[]> {
    const dbPath = join(opencodeDataDir(), "opencode.db");
    if (!existsSync(dbPath)) return [];

    let db: DatabaseSync;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      return [];
    }

    try {
      const sessions = db
        .prepare("SELECT id, directory, title, time_created, time_updated FROM session")
        .all() as unknown as SessionRow[];

      return sessions.map((session) => {
        const counts = this.readMessageCounts(db, session.id);
        const firstUserMessageText = this.readFirstUserMessage(db, session.id);

        return {
          agent: "opencode",
          provider: "opencode",
          nativeSessionId: session.id,
          project: basename(session.directory) || session.directory,
          workspace: session.directory,
          repository: null,
          branch: null,
          createdAt: new Date(session.time_created).toISOString(),
          lastActivityAt: new Date(session.time_updated).toISOString(),
          title: session.title ? truncateTitle(session.title) : null,
          firstUserMessage: firstUserMessageText ? capFirstMessage(firstUserMessageText) : null,
          messageCount: counts.user + counts.assistant,
          userMessageCount: counts.user,
          assistantMessageCount: counts.assistant,
          storagePath: dbPath,
          sizeBytes: this.readApproxSizeBytes(db, session.id),
          metadata: {},
        };
      });
    } finally {
      db.close();
    }
  }

  private readMessageCounts(db: DatabaseSync, sessionId: string): { user: number; assistant: number } {
    try {
      const rows = db
        .prepare(`SELECT json_extract(data,'$.role') as role, COUNT(*) as n FROM message WHERE session_id = ? GROUP BY role`)
        .all(sessionId) as unknown as Array<{ role: string; n: number }>;
      let user = 0;
      let assistant = 0;
      for (const row of rows) {
        if (row.role === "user") user = row.n;
        else if (row.role === "assistant") assistant = row.n;
      }
      return { user, assistant };
    } catch {
      return { user: 0, assistant: 0 };
    }
  }

  private readFirstUserMessage(db: DatabaseSync, sessionId: string): string | null {
    try {
      const firstUserMessageRow = db
        .prepare(`SELECT id FROM message WHERE session_id = ? AND json_extract(data,'$.role') = 'user' ORDER BY time_created ASC LIMIT 1`)
        .get(sessionId) as unknown as { id: string } | undefined;
      if (!firstUserMessageRow) return null;

      const textParts = db
        .prepare(
          `SELECT json_extract(data,'$.text') as text FROM part WHERE message_id = ? AND json_extract(data,'$.type') = 'text' ORDER BY time_created ASC`,
        )
        .all(firstUserMessageRow.id) as unknown as Array<{ text: string | null }>;

      const combined = textParts
        .map((p) => p.text ?? "")
        .join(" ")
        .trim();
      return combined || null;
    } catch {
      return null;
    }
  }

  /**
   * There's no discrete per-session file to stat() — every session shares one database file with every
   * other session. Summing the byte length of that session's own message + part JSON payloads is a
   * reasonable proxy for "how much data does this session hold", much more meaningful than reporting the
   * whole shared database's size for every single session.
   */
  private readApproxSizeBytes(db: DatabaseSync, sessionId: string): number {
    try {
      const row = db
        .prepare(
          `SELECT
            (SELECT COALESCE(SUM(LENGTH(data)),0) FROM message WHERE session_id = ?) +
            (SELECT COALESCE(SUM(LENGTH(data)),0) FROM part WHERE session_id = ?) as bytes`,
        )
        .get(sessionId, sessionId) as unknown as { bytes: number };
      return row.bytes;
    } catch {
      return 0;
    }
  }
}

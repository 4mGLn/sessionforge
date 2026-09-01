import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexAdapter } from "./codex-adapter.server.js";

function runScript(db: DatabaseSync, sql: string): void {
  const run: (sql: string) => void = db.exec.bind(db);
  run(sql);
}

describe("CodexAdapter", () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sessionforge-codex-"));
    previousHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = root;
  });

  afterEach(async () => {
    process.env.CODEX_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  it("returns nothing when state_5.sqlite does not exist", async () => {
    const adapter = new CodexAdapter();
    expect(await adapter.discover()).toEqual([]);
  });

  it("reads threads from state_5.sqlite and message counts from thread_history_1.sqlite", async () => {
    const stateDb = new DatabaseSync(join(root, "state_5.sqlite"));
    runScript(
      stateDb,
      `CREATE TABLE threads (
        id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL,
        created_at_ms INTEGER, updated_at_ms INTEGER, git_branch TEXT,
        first_user_message TEXT NOT NULL DEFAULT '', rollout_path TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      );`,
    );
    stateDb
      .prepare(
        "INSERT INTO threads (id, cwd, title, created_at_ms, updated_at_ms, git_branch, first_user_message, rollout_path, archived) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "thread-1",
        "/home/amgln/demo",
        "  fix   the\nvacuum   timeout  ",
        1700000000000,
        1700000600000,
        "feature/adapter",
        "please fix the vacuum timeout",
        join(root, "rollout-thread-1.jsonl"),
        0,
      );
    stateDb.close();

    const historyDb = new DatabaseSync(join(root, "thread_history_1.sqlite"));
    runScript(historyDb, "CREATE TABLE thread_items (thread_id TEXT, item_type TEXT);");
    const insert = historyDb.prepare("INSERT INTO thread_items (thread_id, item_type) VALUES (?, ?)");
    insert.run("thread-1", "userMessage");
    insert.run("thread-1", "agentMessage");
    insert.run("thread-1", "agentMessage");
    insert.run("thread-1", "reasoning");
    historyDb.close();

    const adapter = new CodexAdapter();
    const sessions = await adapter.discover();

    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session.nativeSessionId).toBe("thread-1");
    expect(session.workspace).toBe("/home/amgln/demo");
    expect(session.branch).toBe("feature/adapter");
    expect(session.title).toBe("fix the vacuum timeout");
    expect(session.firstUserMessage).toBe("please fix the vacuum timeout");
    expect(session.userMessageCount).toBe(1);
    expect(session.assistantMessageCount).toBe(2);
    expect(session.createdAt).toBe(new Date(1700000000000).toISOString());
  });

  it("still returns threads with zero counts when thread_history_1.sqlite is missing", async () => {
    const stateDb = new DatabaseSync(join(root, "state_5.sqlite"));
    runScript(
      stateDb,
      `CREATE TABLE threads (
        id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL,
        created_at_ms INTEGER, updated_at_ms INTEGER, git_branch TEXT,
        first_user_message TEXT NOT NULL DEFAULT '', rollout_path TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      );`,
    );
    stateDb
      .prepare(
        "INSERT INTO threads (id, cwd, title, created_at_ms, updated_at_ms, git_branch, first_user_message, rollout_path, archived) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run("thread-2", "/home/amgln/demo2", "old thread", 1700000000000, 1700000600000, null, "", "/tmp/does-not-exist.jsonl", 1);
    stateDb.close();

    const adapter = new CodexAdapter();
    const sessions = await adapter.discover();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].userMessageCount).toBe(0);
    expect(sessions[0].assistantMessageCount).toBe(0);
    expect(sessions[0].sizeBytes).toBe(0);
    expect(sessions[0].metadata.codexArchived).toBe(true);
  });
});

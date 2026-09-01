import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenCodeAdapter } from "./opencode-adapter.server.js";
import type { AgentAdapter } from "./types.server.js";

describe("OpenCodeAdapter", () => {
  let root: string;
  let previousDataDir: string | undefined;
  let dbPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sessionforge-opencode-"));
    previousDataDir = process.env.OPENCODE_DATA_DIR;
    process.env.OPENCODE_DATA_DIR = root;
    dbPath = join(root, "opencode.db");
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.OPENCODE_DATA_DIR;
    else process.env.OPENCODE_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  });

  function makeFixtureDb(): DatabaseSync {
    const db = new DatabaseSync(dbPath);
    const runScript: (sql: string) => void = db.exec.bind(db);
    runScript(`
      CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    return db;
  }

  it("discovers sessions with title, workspace, and timestamps", async () => {
    const db = makeFixtureDb();
    db.prepare("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)").run(
      "ses_1",
      "/home/dev/demo",
      "Fix the login bug",
      1700000000000,
      1700003600000,
    );
    db.close();

    const sessions = await new OpenCodeAdapter().discover();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agent: "opencode",
      nativeSessionId: "ses_1",
      project: "demo",
      workspace: "/home/dev/demo",
      title: "Fix the login bug",
      createdAt: new Date(1700000000000).toISOString(),
      lastActivityAt: new Date(1700003600000).toISOString(),
      storagePath: dbPath,
    });
  });

  it("counts user/assistant messages via the message table's JSON role field", async () => {
    const db = makeFixtureDb();
    db.prepare("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)").run(
      "ses_1",
      "/home/dev/demo",
      null,
      1700000000000,
      1700000000000,
    );
    const insertMsg = db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)");
    insertMsg.run("m1", "ses_1", 1, JSON.stringify({ role: "user" }));
    insertMsg.run("m2", "ses_1", 2, JSON.stringify({ role: "assistant" }));
    insertMsg.run("m3", "ses_1", 3, JSON.stringify({ role: "user" }));
    insertMsg.run("m4", "ses_1", 4, JSON.stringify({ role: "assistant" }));
    insertMsg.run("m5", "ses_1", 5, JSON.stringify({ role: "assistant" }));
    db.close();

    const sessions = await new OpenCodeAdapter().discover();

    expect(sessions[0].userMessageCount).toBe(2);
    expect(sessions[0].assistantMessageCount).toBe(3);
    expect(sessions[0].messageCount).toBe(5);
  });

  it("extracts the first user message's text from its parts, in order, joined together", async () => {
    const db = makeFixtureDb();
    db.prepare("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)").run(
      "ses_1",
      "/home/dev/demo",
      null,
      1700000000000,
      1700000000000,
    );
    const insertMsg = db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)");
    insertMsg.run("m1", "ses_1", 1, JSON.stringify({ role: "user" }));
    insertMsg.run("m2", "ses_1", 2, JSON.stringify({ role: "assistant" }));
    insertMsg.run("m3", "ses_1", 3, JSON.stringify({ role: "user" }));

    const insertPart = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)");
    insertPart.run("p1", "m1", "ses_1", 1, JSON.stringify({ type: "text", text: "please fix the login bug" }));
    insertPart.run("p2", "m3", "ses_1", 3, JSON.stringify({ type: "text", text: "this is a later message, not the first" }));
    db.close();

    const sessions = await new OpenCodeAdapter().discover();

    expect(sessions[0].firstUserMessage).toBe("please fix the login bug");
  });

  it("joins multiple text parts of the first user message together", async () => {
    const db = makeFixtureDb();
    db.prepare("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)").run(
      "ses_1",
      "/home/dev/demo",
      null,
      1700000000000,
      1700000000000,
    );
    db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)").run(
      "m1",
      "ses_1",
      1,
      JSON.stringify({ role: "user" }),
    );
    const insertPart = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)");
    insertPart.run("p1", "m1", "ses_1", 1, JSON.stringify({ type: "text", text: "part one" }));
    insertPart.run("p2", "m1", "ses_1", 2, JSON.stringify({ type: "tool-call", name: "read_file" }));
    insertPart.run("p3", "m1", "ses_1", 3, JSON.stringify({ type: "text", text: "part two" }));
    db.close();

    const sessions = await new OpenCodeAdapter().discover();

    expect(sessions[0].firstUserMessage).toBe("part one part two");
  });

  it("returns an approximate size based on the session's own message+part payload sizes, not the whole shared db", async () => {
    const db = makeFixtureDb();
    db.prepare("INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?)").run(
      "ses_1",
      "/home/dev/demo",
      null,
      1700000000000,
      1700000000000,
    );
    db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)").run("m1", "ses_1", 1, "x".repeat(100));
    db.prepare("INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)").run(
      "p1",
      "m1",
      "ses_1",
      1,
      "y".repeat(50),
    );
    db.close();

    const sessions = await new OpenCodeAdapter().discover();

    expect(sessions[0].sizeBytes).toBe(150);
  });

  it("returns an empty list when the database file does not exist", async () => {
    expect(await new OpenCodeAdapter().discover()).toEqual([]);
  });

  it("has no delete() capability — there is no discrete per-session file to move", () => {
    const adapter: AgentAdapter = new OpenCodeAdapter();
    expect(adapter.delete).toBeUndefined();
  });
});

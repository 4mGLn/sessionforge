import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "./store.server.js";
import type { Session, SessionRelationship } from "./types.server.js";

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    agent: "claude-code",
    provider: "claude-code",
    nativeSessionId: overrides.id,
    project: "demo",
    workspace: "/home/dev/demo",
    repository: null,
    branch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    status: "STALE",
    activityConfidence: "MEDIUM",
    lifecycle: "COMPLETED",
    title: null,
    summary: null,
    firstUserMessage: null,
    messageCount: 2,
    userMessageCount: 1,
    assistantMessageCount: 1,
    storagePath: "/home/dev/demo/session.jsonl",
    sizeBytes: 100,
    metadata: {},
    classification: null,
    archivedAt: null,
    ...overrides,
  };
}

describe("SessionStore search (FTS5)", () => {
  let dbPath: string;
  let root: string;
  let store: SessionStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sessionforge-store-"));
    dbPath = join(root, "test.db");
    store = new SessionStore(dbPath);
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("finds a session by a word in its title", () => {
    store.upsertSession(makeSession({ id: "a", title: "Fix PostgreSQL VACUUM issue" }));
    store.upsertSession(makeSession({ id: "b", title: "Unrelated work on the frontend" }));

    const results = store.listSessions({ query: "postgresql" });

    expect(results.map((s) => s.id)).toEqual(["a"]);
  });

  it("requires ALL words in a multi-word query (implicit AND)", () => {
    store.upsertSession(makeSession({ id: "a", title: "Xconverter GUI migration wizard" }));
    store.upsertSession(makeSession({ id: "b", title: "Xconverter backend refactor" }));
    store.upsertSession(makeSession({ id: "c", title: "Some other GUI work" }));

    const results = store.listSessions({ query: "Xconverter GUI" });

    expect(results.map((s) => s.id)).toEqual(["a"]);
  });

  it("matches across title, summary, first_user_message, and project", () => {
    store.upsertSession(makeSession({ id: "a", title: null, summary: "implemented the vacuum fix" }));
    store.upsertSession(makeSession({ id: "b", title: null, firstUserMessage: "please vacuum the table" }));
    store.upsertSession(makeSession({ id: "c", project: "vacuum-cleaner-app" }));
    store.upsertSession(makeSession({ id: "d", title: "totally unrelated" }));

    const results = store.listSessions({ query: "vacuum" });

    expect(new Set(results.map((s) => s.id))).toEqual(new Set(["a", "b", "c"]));
  });

  it("ranks a session matching in the title above one only matching in a less prominent field", () => {
    store.upsertSession(makeSession({ id: "weak", title: null, firstUserMessage: "some long message that happens to mention vacuum once" }));
    store.upsertSession(makeSession({ id: "strong", title: "vacuum vacuum vacuum" }));

    const results = store.listSessions({ query: "vacuum" });

    expect(results.map((s) => s.id)).toEqual(["strong", "weak"]);
  });

  it("combines a search query with other filters", () => {
    store.upsertSession(makeSession({ id: "a", agent: "claude-code", title: "fix vacuum bug" }));
    store.upsertSession(makeSession({ id: "b", agent: "codex", title: "fix vacuum bug" }));

    const results = store.listSessions({ query: "vacuum", agent: "codex" });

    expect(results.map((s) => s.id)).toEqual(["b"]);
  });

  it("does not throw on FTS5-special characters in the query and treats them as literal text", () => {
    store.upsertSession(makeSession({ id: "a", title: "weird query" }));

    expect(() => store.listSessions({ query: `"unbalanced AND OR NOT - * quote` })).not.toThrow();
    expect(store.listSessions({ query: `"unbalanced AND OR NOT - * quote` })).toEqual([]);
  });

  it("keeps the FTS index in sync when a session is re-upserted with new content", () => {
    store.upsertSession(makeSession({ id: "a", title: "original topic" }));
    expect(store.listSessions({ query: "original" }).map((s) => s.id)).toEqual(["a"]);

    store.upsertSession(makeSession({ id: "a", title: "updated topic" }));

    expect(store.listSessions({ query: "original" })).toEqual([]);
    expect(store.listSessions({ query: "updated" }).map((s) => s.id)).toEqual(["a"]);
  });

  it("removes a session from search results once deleted", () => {
    store.upsertSession(makeSession({ id: "a", title: "deletable session" }));
    expect(store.listSessions({ query: "deletable" }).map((s) => s.id)).toEqual(["a"]);

    store.deleteSession("a");

    expect(store.listSessions({ query: "deletable" })).toEqual([]);
  });

  it("falls back to the plain non-search listing (created_at order) when no query is given", () => {
    store.upsertSession(makeSession({ id: "a", createdAt: "2026-01-01T00:00:00.000Z" }));
    store.upsertSession(makeSession({ id: "b", createdAt: "2026-01-02T00:00:00.000Z" }));

    const results = store.listSessions({});

    expect(results.map((s) => s.id)).toEqual(["b", "a"]);
  });
});

describe("SessionStore relationships", () => {
  let dbPath: string;
  let root: string;
  let store: SessionStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sessionforge-store-rel-"));
    dbPath = join(root, "test.db");
    store = new SessionStore(dbPath);
  });

  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  function rel(overrides: Partial<SessionRelationship> = {}): SessionRelationship {
    return {
      sessionId: "a",
      relatedSessionId: "b",
      kind: "SUPERSEDED",
      confidence: 0.8,
      reason: "test reason",
      detectedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("returns relationships for a session on either side (original or related)", () => {
    store.replaceRelationships([rel({ sessionId: "a", relatedSessionId: "b" })]);

    expect(store.listRelationships("a")).toHaveLength(1);
    expect(store.listRelationships("b")).toHaveLength(1);
    expect(store.listRelationships("c")).toHaveLength(0);
  });

  it("wholesale-replaces on the next call instead of accumulating", () => {
    store.replaceRelationships([rel({ sessionId: "a", relatedSessionId: "b" })]);
    store.replaceRelationships([rel({ sessionId: "x", relatedSessionId: "y" })]);

    expect(store.listRelationships("a")).toHaveLength(0);
    expect(store.listRelationships("x")).toHaveLength(1);
  });

  it("orders results by confidence descending", () => {
    store.replaceRelationships([
      rel({ sessionId: "a", relatedSessionId: "b", confidence: 0.4 }),
      rel({ sessionId: "a", relatedSessionId: "c", confidence: 0.9 }),
    ]);

    const results = store.listRelationships("a");
    expect(results.map((r) => r.relatedSessionId)).toEqual(["c", "b"]);
  });

  it("removes relationships referencing a session once that session is deleted", () => {
    store.upsertSession(makeSession({ id: "a" }));
    store.replaceRelationships([rel({ sessionId: "a", relatedSessionId: "b" })]);

    store.deleteSession("a");

    expect(store.listRelationships("a")).toHaveLength(0);
    expect(store.listRelationships("b")).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import { detectRelationships } from "./relationships.server.js";
import type { Session } from "./types.server.js";

function makeSession(overrides: Partial<Session> & { id: string; createdAt: string }): Session {
  return {
    agent: "claude-code",
    provider: "claude-code",
    nativeSessionId: overrides.id,
    project: "demo",
    workspace: "/home/dev/demo",
    repository: null,
    branch: null,
    updatedAt: overrides.createdAt,
    lastActivityAt: overrides.createdAt,
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

describe("detectRelationships", () => {
  it("flags a clean sequential handoff in the same workspace as SUPERSEDED", () => {
    const older = makeSession({
      id: "a",
      title: "Fix PostgreSQL VACUUM autoscheduler bug",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T01:00:00.000Z",
    });
    const newer = makeSession({
      id: "b",
      title: "Continue fixing PostgreSQL VACUUM autoscheduler bug",
      createdAt: "2026-01-05T00:00:00.000Z",
      lastActivityAt: "2026-01-05T01:00:00.000Z",
    });

    const relationships = detectRelationships([older, newer]);

    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({ sessionId: "a", relatedSessionId: "b", kind: "SUPERSEDED" });
  });

  it("flags overlapping/close-together similar sessions in the same workspace as DUPLICATE", () => {
    const a = makeSession({
      id: "a",
      title: "Implement GUI migration wizard",
      createdAt: "2026-01-01T09:00:00.000Z",
      lastActivityAt: "2026-01-01T10:00:00.000Z",
    });
    const b = makeSession({
      id: "b",
      title: "Implement GUI migration wizard for Xconverter",
      createdAt: "2026-01-01T09:30:00.000Z",
      lastActivityAt: "2026-01-01T10:30:00.000Z",
    });

    const relationships = detectRelationships([a, b]);

    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({ sessionId: "a", relatedSessionId: "b", kind: "DUPLICATE" });
  });

  it("does not relate similar-topic sessions in different workspaces", () => {
    const a = makeSession({ id: "a", title: "Fix PostgreSQL VACUUM bug", workspace: "/home/dev/repo-one", createdAt: "2026-01-01T00:00:00.000Z" });
    const b = makeSession({ id: "b", title: "Fix PostgreSQL VACUUM bug", workspace: "/home/dev/repo-two", createdAt: "2026-01-05T00:00:00.000Z" });

    expect(detectRelationships([a, b])).toEqual([]);
  });

  it("does not relate dissimilar-topic sessions even in the same workspace", () => {
    const a = makeSession({ id: "a", title: "Fix PostgreSQL VACUUM bug", createdAt: "2026-01-01T00:00:00.000Z" });
    const b = makeSession({ id: "b", title: "Redesign the onboarding email templates", createdAt: "2026-01-05T00:00:00.000Z" });

    expect(detectRelationships([a, b])).toEqual([]);
  });

  it("skips sessions with no title and no first user message without crashing", () => {
    const a = makeSession({ id: "a", title: null, firstUserMessage: null, createdAt: "2026-01-01T00:00:00.000Z" });
    const b = makeSession({ id: "b", title: "Fix PostgreSQL VACUUM bug", createdAt: "2026-01-05T00:00:00.000Z" });

    expect(() => detectRelationships([a, b])).not.toThrow();
    expect(detectRelationships([a, b])).toEqual([]);
  });

  it("produces no relationships for a lone session in its workspace", () => {
    const a = makeSession({ id: "a", title: "Solo work", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(detectRelationships([a])).toEqual([]);
  });

  it("falls back to the first user message as the topic when there is no title", () => {
    const a = makeSession({
      id: "a",
      title: null,
      firstUserMessage: "please fix the PostgreSQL VACUUM autoscheduler bug",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const b = makeSession({
      id: "b",
      title: null,
      firstUserMessage: "continue fixing the PostgreSQL VACUUM autoscheduler bug",
      createdAt: "2026-01-05T00:00:00.000Z",
    });

    expect(detectRelationships([a, b])).toHaveLength(1);
  });

  it("does not treat two different non-Latin-script topics as related just because they share an ASCII project name", () => {
    // Regression: an ASCII-only tokenizer treats every non-Latin character as a delimiter, so both of
    // these completely different Korean topics used to collapse to the same single-word set (just the
    // ASCII "cctrace" that survived) and scored a false near-perfect match against real bilingual data.
    const a = makeSession({ id: "a", title: "cctrace 주간 사용 리포트", project: "cctrace", createdAt: "2026-01-01T00:00:00.000Z" });
    const b = makeSession({ id: "b", title: "cctrace 원격 서버 동기화 확인", project: "cctrace", createdAt: "2026-01-05T00:00:00.000Z" });

    expect(detectRelationships([a, b])).toEqual([]);
  });

  it("relates two genuinely-similar non-Latin-script topics once real overlapping words exist", () => {
    const a = makeSession({ id: "a", title: "PostgreSQL 백업 스크립트 오류 수정", project: "demo", createdAt: "2026-01-01T00:00:00.000Z" });
    const b = makeSession({ id: "b", title: "PostgreSQL 백업 스크립트 오류 재수정", project: "demo", createdAt: "2026-01-05T00:00:00.000Z" });

    expect(detectRelationships([a, b])).toHaveLength(1);
  });

  it("does not relate short generic titles that only share one common word", () => {
    // Regression: "start goal" vs "goal" scored 0.5 similarity from a single shared word out of a
    // 1-2-word set — nowhere near enough signal to call these "the same task".
    const a = makeSession({ id: "a", title: "ok now start goal", createdAt: "2026-01-01T00:00:00.000Z" });
    const b = makeSession({ id: "b", title: "start goal", createdAt: "2026-01-01T00:10:00.000Z" });
    const c = makeSession({ id: "c", title: "goal", createdAt: "2026-01-01T00:20:00.000Z" });

    expect(detectRelationships([a, b, c])).toEqual([]);
  });

  it("does not count the project's own name as topic similarity between two otherwise-unrelated sessions", () => {
    const a = makeSession({ id: "a", title: "cctrace weekly usage report generation", project: "cctrace-tool", createdAt: "2026-01-01T00:00:00.000Z" });
    const b = makeSession({ id: "b", title: "cctrace remote server sync verification", project: "cctrace-tool", createdAt: "2026-01-05T00:00:00.000Z" });

    expect(detectRelationships([a, b])).toEqual([]);
  });
});

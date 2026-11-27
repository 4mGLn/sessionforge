import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "./claude-adapter.server.js";
import { runDiscovery } from "./discover.server.js";
import { archiveSession, deleteSessions, restoreSession, runCleanup } from "./lifecycle-actions.server.js";
import { SessionStore } from "./store.server.js";

function jsonl(...lines: Record<string, unknown>[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** Relative to whenever the test actually runs, not a fixed calendar date — classifySession's
 * ARCHIVE_AGE_DAYS (14) threshold is age-based, so a hardcoded past timestamp is a time bomb: it read as
 * "recent" when first written, then silently flipped this fixture's own classification from KEEP to
 * ARCHIVE once enough real time passed, breaking this test and the two others that depend on it. */
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("discover + lifecycle actions (integration)", () => {
  let root: string;
  let previousConfigDir: string | undefined;
  let store: SessionStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sessionforge-discover-"));
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;

    const projectDir = join(root, "projects", "-home-amgln-demo");
    await mkdir(projectDir, { recursive: true });

    await writeFile(
      join(projectDir, "keep-session.jsonl"),
      jsonl(
        {
          type: "user",
          message: { content: "please implement the search command end to end" },
          timestamp: daysAgoIso(2),
          cwd: "/home/amgln/demo",
          sessionId: "keep-session",
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Sure, starting now." }] },
          timestamp: daysAgoIso(2),
          cwd: "/home/amgln/demo",
          sessionId: "keep-session",
        },
      ),
      "utf8",
    );

    await writeFile(
      join(projectDir, "junk-session.jsonl"),
      jsonl({
        type: "user",
        message: { content: "test" },
        timestamp: daysAgoIso(1),
        cwd: "/home/amgln/demo",
        sessionId: "junk-session",
      }),
      "utf8",
    );

    store = new SessionStore(join(root, "sessionforge.db"));
  });

  afterEach(async () => {
    store.close();
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    await rm(root, { recursive: true, force: true });
  });

  it("lists sessions classified from real discovery output", async () => {
    await runDiscovery(store, [new ClaudeCodeAdapter()]);
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(2);

    const junk = sessions.find((s) => s.nativeSessionId === "junk-session");
    const keep = sessions.find((s) => s.nativeSessionId === "keep-session");
    expect(junk?.classification?.category).toBe("JUNK");
    expect(keep?.classification?.category).toBe("KEEP");
  });

  it("makes committed sessions available while a large discovery is still running", async () => {
    const adapter = new ClaudeCodeAdapter();
    const [fixture] = await adapter.discover();
    const total = 260;
    vi.spyOn(adapter, "discover").mockResolvedValue(
      Array.from({ length: total }, (_, index) => ({ ...fixture, nativeSessionId: `batch-${index}` })),
    );

    let sessionsDuringDiscovery = 0;
    const upsert = store.upsertSession.bind(store);
    vi.spyOn(store, "upsertSession").mockImplementationOnce((session) => {
      upsert(session);
      setImmediate(() => {
        sessionsDuringDiscovery = store.listSessions().length;
      });
    });

    await expect(runDiscovery(store, [adapter])).resolves.toEqual({ scanned: total, created: total, updated: 0 });
    expect(sessionsDuringDiscovery).toBeGreaterThan(0);
    expect(sessionsDuringDiscovery).toBeLessThan(total);
    expect(store.listSessions()).toHaveLength(total);
  });

  it("cleanup dry-run reports junk candidates without mutating anything", async () => {
    await runDiscovery(store, [new ClaudeCodeAdapter()]);
    const result = runCleanup(store, "test", true);
    expect(result.dryRun).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.applied).toHaveLength(0);

    const stillThere = store.listSessions();
    expect(stillThere.every((s) => s.lifecycle !== "JUNK")).toBe(true);
  });

  it("cleanup without dry-run trashes junk candidates and records an audit entry", async () => {
    await runDiscovery(store, [new ClaudeCodeAdapter()]);
    const result = runCleanup(store, "test", false);
    expect(result.applied).toHaveLength(1);

    const trashed = store.listSessions({ lifecycle: "JUNK" });
    expect(trashed).toHaveLength(1);

    const audit = store.listAudit();
    expect(audit.some((entry) => entry.action === "TRASH")).toBe(true);
  });

  it("skips ongoing sessions and applies cleanup only to reviewed IDs without moving files", async () => {
    await runDiscovery(store, [new ClaudeCodeAdapter()]);
    const [junk] = store.listSessions({ category: "JUNK" });
    const transcript = await readFile(junk.storagePath, "utf8");
    store.upsertSession({ ...junk, lifecycle: "ONGOING" });
    expect(runCleanup(store, "test", true).candidates).toEqual([]);
    expect(runCleanup(store, "test", false, new Set([junk.id])).applied).toEqual([]);
    store.upsertSession({ ...junk, lifecycle: "ABANDONED" });
    expect(runCleanup(store, "test", false, new Set()).applied).toEqual([]);
    expect(runCleanup(store, "test", false, new Set([junk.id])).applied.map((session) => session.id)).toEqual([junk.id]);
    expect(await readFile(junk.storagePath, "utf8")).toBe(transcript);
  });

  it("requires separate approval for each running or Paseo-linked history", async () => {
    const adapter = new ClaudeCodeAdapter();
    await runDiscovery(store, [adapter]);
    const [linked] = store.listSessions({ category: "JUNK" });
    const [running] = store.listSessions({ category: "KEEP" });
    store.upsertSession({ ...running, status: "ACTIVE", lifecycle: "ONGOING" });

    const trashPath = join(root, "trashed-transcript.jsonl");
    const move = vi.spyOn(adapter, "delete").mockImplementation((path) => rename(path, trashPath));
    const ids = [linked.id, running.id];
    const options = { linkedNativeSessionIds: new Set([linked.nativeSessionId]) };
    const blocked = await deleteSessions(store, [adapter], ids, "test", null, options);
    expect(blocked.deleted).toEqual([]);
    expect(blocked.failed.map((failure) => failure.id)).toEqual(ids);
    expect(blocked.failed.every((failure) => failure.confirmation)).toBe(true);
    expect(move).not.toHaveBeenCalled();
    expect(store.listAudit()).toHaveLength(0);

    const approved = await deleteSessions(store, [adapter], ids, "test", null, {
      ...options,
      confirmedProtectedIds: new Set([linked.id]),
    });
    expect(approved.deleted.map((session) => session.id)).toEqual([linked.id]);
    expect(approved.failed.map((failure) => failure.id)).toEqual([running.id]);
    expect(move).toHaveBeenCalledExactlyOnceWith(linked.storagePath);
    expect(await readFile(trashPath, "utf8")).toContain("junk-session");
    expect(await readFile(running.storagePath, "utf8")).toContain("keep-session");
  });

  it.runIf(process.platform !== "win32")("blocks a recently written transcript even if the inventory calls it stale", async () => {
    const adapter = new ClaudeCodeAdapter();
    await runDiscovery(store, [adapter]);
    const [junk] = store.listSessions({ category: "JUNK" });
    store.upsertSession({ ...junk, status: "STALE", lifecycle: "ABANDONED" });
    const move = vi.spyOn(adapter, "delete");
    const result = await deleteSessions(store, [adapter], [junk.id], "test");
    expect(result.failed[0]).toMatchObject({ id: junk.id, error: "Live process or recent transcript activity detected" });
    expect(move).not.toHaveBeenCalled();
  });

  it("rolls back lifecycle and audit changes when applying cleanup fails", async () => {
    await runDiscovery(store, [new ClaudeCodeAdapter()]);
    const recordAudit = store.recordAudit.bind(store);
    vi.spyOn(store, "recordAudit").mockImplementationOnce((entry) => {
      recordAudit(entry);
      throw new Error("interrupted cleanup");
    });

    expect(() => runCleanup(store, "test", false)).toThrow("interrupted cleanup");
    expect(store.listSessions({ lifecycle: "JUNK" })).toHaveLength(0);
    expect(store.listAudit()).toHaveLength(0);
    expect(runCleanup(store, "test", false).applied).toHaveLength(1);
  });

  it("archive then restore round-trips cleanly", async () => {
    await runDiscovery(store, [new ClaudeCodeAdapter()]);
    const before = store.listSessions({ category: "KEEP" })[0];
    expect(before).toBeDefined();

    const archived = archiveSession(store, before.id, "test");
    expect(archived.lifecycle).toBe("ARCHIVED");
    expect(archived.archivedAt).not.toBeNull();

    const restored = restoreSession(store, before.id, "test");
    expect(restored.archivedAt).toBeNull();
    expect(restored.lifecycle).not.toBe("ARCHIVED");
  });

  it("a rescan does not silently flip an archived session back to active", async () => {
    await runDiscovery(store, [new ClaudeCodeAdapter()]);
    const before = store.listSessions({ category: "KEEP" })[0];
    archiveSession(store, before.id, "test");

    await runDiscovery(store, [new ClaudeCodeAdapter()]);
    const after = store.getSession(before.id);
    expect(after?.lifecycle).toBe("ARCHIVED");
  });
});

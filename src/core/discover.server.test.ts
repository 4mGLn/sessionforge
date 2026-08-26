import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude-adapter.server.js";
import { runDiscovery } from "./discover.server.js";
import { archiveSession, restoreSession, runCleanup } from "./lifecycle-actions.server.js";
import { SessionStore } from "./store.server.js";

function jsonl(...lines: Record<string, unknown>[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
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
          timestamp: "2026-08-20T10:00:00.000Z",
          cwd: "/home/amgln/demo",
          sessionId: "keep-session",
        },
        {
          type: "assistant",
          message: { content: [{ type: "text", text: "Sure, starting now." }] },
          timestamp: "2026-08-20T10:00:05.000Z",
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
        timestamp: "2026-08-21T10:00:00.000Z",
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

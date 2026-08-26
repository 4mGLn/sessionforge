import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./claude-adapter.server.js";

function jsonl(...lines: Record<string, unknown>[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

describe("ClaudeCodeAdapter", () => {
  let root: string;
  let previousConfigDir: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sessionforge-claude-"));
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
  });

  afterEach(async () => {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    await rm(root, { recursive: true, force: true });
  });

  it("returns nothing when the projects directory does not exist", async () => {
    const adapter = new ClaudeCodeAdapter();
    expect(await adapter.discover()).toEqual([]);
  });

  it("parses cwd, branch, and message counts from a session file, ignoring sidechains", async () => {
    const projectDir = join(root, "projects", "-home-amgln-demo");
    await mkdir(projectDir, { recursive: true });

    const sessionId = "11111111-1111-1111-1111-111111111111";
    const content = jsonl(
      { type: "mode", mode: "normal", sessionId },
      {
        type: "user",
        message: { role: "user", content: "implement the claude code adapter" },
        timestamp: "2026-08-20T10:00:00.000Z",
        cwd: "/home/amgln/demo",
        gitBranch: "feature/adapter",
        sessionId,
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "On it." }] },
        timestamp: "2026-08-20T10:00:05.000Z",
        cwd: "/home/amgln/demo",
        gitBranch: "feature/adapter",
        sessionId,
      },
      {
        type: "user",
        isSidechain: true,
        message: { role: "user", content: "internal sub-agent prompt" },
        timestamp: "2026-08-20T10:00:06.000Z",
        cwd: "/home/amgln/demo",
        sessionId,
      },
      {
        type: "user",
        message: { role: "user", content: "now add tests" },
        timestamp: "2026-08-20T10:05:00.000Z",
        cwd: "/home/amgln/demo",
        gitBranch: "feature/adapter",
        sessionId,
      },
    );
    await writeFile(join(projectDir, `${sessionId}.jsonl`), content, "utf8");

    const adapter = new ClaudeCodeAdapter();
    const sessions = await adapter.discover();

    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session.nativeSessionId).toBe(sessionId);
    expect(session.workspace).toBe("/home/amgln/demo");
    expect(session.branch).toBe("feature/adapter");
    expect(session.firstUserMessage).toBe("implement the claude code adapter");
    // The sidechain user line must not be counted.
    expect(session.userMessageCount).toBe(2);
    expect(session.assistantMessageCount).toBe(1);
    expect(session.createdAt).toBe("2026-08-20T10:00:00.000Z");
    expect(session.lastActivityAt).toBe("2026-08-20T10:05:00.000Z");
  });

  it("tolerates unparseable lines instead of failing the whole scan", async () => {
    const projectDir = join(root, "projects", "-home-amgln-demo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "broken.jsonl"), "{not valid json\n", "utf8");

    const adapter = new ClaudeCodeAdapter();
    const sessions = await adapter.discover();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].userMessageCount).toBe(0);
    // cwd could not be recovered from the transcript, so it falls back to the project directory name
    // rather than leaving the session ungroupable.
    expect(sessions[0].workspace).toBe("-home-amgln-demo");
  });

  it("prefers the ai-title record over a derived title", async () => {
    const projectDir = join(root, "projects", "-home-amgln-demo");
    await mkdir(projectDir, { recursive: true });
    const sessionId = "22222222-2222-2222-2222-222222222222";
    const content = jsonl(
      {
        type: "user",
        message: { role: "user", content: "fix the postgres vacuum timeout" },
        timestamp: "2026-08-20T10:00:00.000Z",
        cwd: "/home/amgln/demo",
        sessionId,
      },
      { type: "ai-title", aiTitle: "Fix PostgreSQL VACUUM timeout", sessionId },
    );
    await writeFile(join(projectDir, `${sessionId}.jsonl`), content, "utf8");

    const adapter = new ClaudeCodeAdapter();
    const sessions = await adapter.discover();
    expect(sessions[0].title).toBe("Fix PostgreSQL VACUUM timeout");
  });
});

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GeminiCliAdapter } from "./gemini-adapter.server.js";

describe("GeminiCliAdapter", () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sessionforge-gemini-"));
    previousHome = process.env.GEMINI_CONFIG_DIR;
    process.env.GEMINI_CONFIG_DIR = root;
  });

  afterEach(async () => {
    process.env.GEMINI_CONFIG_DIR = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  it("returns nothing when tmp/ does not exist", async () => {
    const adapter = new GeminiCliAdapter();
    expect(await adapter.discover()).toEqual([]);
  });

  it("resolves the project path via .project_root when present", async () => {
    const projectDir = join(root, "tmp", "my-project");
    const chatsDir = join(projectDir, "chats");
    await mkdir(chatsDir, { recursive: true });
    await writeFile(join(projectDir, ".project_root"), "/home/amgln/demo\n", "utf8");
    await writeFile(
      join(chatsDir, "session-a.json"),
      JSON.stringify({
        sessionId: "session-a",
        projectHash: "irrelevant",
        startTime: "2026-08-20T10:00:00.000Z",
        lastUpdated: "2026-08-20T10:05:00.000Z",
        messages: [
          { type: "user", content: "please implement the search command", timestamp: "2026-08-20T10:00:00.000Z" },
          { type: "gemini", content: "Sure, starting now.", timestamp: "2026-08-20T10:00:05.000Z" },
        ],
      }),
      "utf8",
    );

    const adapter = new GeminiCliAdapter();
    const sessions = await adapter.discover();

    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session.nativeSessionId).toBe("session-a");
    expect(session.workspace).toBe("/home/amgln/demo");
    expect(session.project).toBe("demo");
    expect(session.firstUserMessage).toBe("please implement the search command");
    expect(session.userMessageCount).toBe(1);
    expect(session.assistantMessageCount).toBe(1);
    expect(session.createdAt).toBe("2026-08-20T10:00:00.000Z");
    expect(session.lastActivityAt).toBe("2026-08-20T10:05:00.000Z");
  });

  it("resolves the project path via projects.json hash lookup when no .project_root exists", async () => {
    const realPath = "/home/amgln/hashed-project";
    const hash = createHash("sha256").update(realPath).digest("hex");
    const chatsDir = join(root, "tmp", hash, "chats");
    await mkdir(chatsDir, { recursive: true });
    await writeFile(join(root, "projects.json"), JSON.stringify({ projects: { [realPath]: "hashed-project" } }), "utf8");
    await writeFile(
      join(chatsDir, "session-b.json"),
      JSON.stringify({
        sessionId: "session-b",
        startTime: "2026-08-20T11:00:00.000Z",
        lastUpdated: "2026-08-20T11:01:00.000Z",
        messages: [{ type: "user", content: "hi", timestamp: "2026-08-20T11:00:00.000Z" }],
      }),
      "utf8",
    );

    const adapter = new GeminiCliAdapter();
    const sessions = await adapter.discover();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].workspace).toBe(realPath);
  });

  it("falls back to the raw directory name when the hash cannot be resolved", async () => {
    const chatsDir = join(root, "tmp", "unresolvable-hash", "chats");
    await mkdir(chatsDir, { recursive: true });
    await writeFile(
      join(chatsDir, "session-c.json"),
      JSON.stringify({
        sessionId: "session-c",
        startTime: "2026-08-20T12:00:00.000Z",
        lastUpdated: "2026-08-20T12:00:00.000Z",
        messages: [],
      }),
      "utf8",
    );

    const adapter = new GeminiCliAdapter();
    const sessions = await adapter.discover();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].workspace).toBe("unresolvable-hash");
    expect(sessions[0].userMessageCount).toBe(0);
    expect(sessions[0].assistantMessageCount).toBe(0);
  });
});

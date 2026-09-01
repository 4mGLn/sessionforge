import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiderAdapter } from "./aider-adapter.server.js";
import type { AgentAdapter } from "./types.server.js";

const HISTORY_FILE = ".aider.chat.history.md";

describe("AiderAdapter", () => {
  let root: string;
  let previousSearchRoots: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sessionforge-aider-"));
    previousSearchRoots = process.env.AIDER_SEARCH_ROOTS;
  });

  afterEach(async () => {
    if (previousSearchRoots === undefined) delete process.env.AIDER_SEARCH_ROOTS;
    else process.env.AIDER_SEARCH_ROOTS = previousSearchRoots;
    await rm(root, { recursive: true, force: true });
  });

  it("discovers nothing when AIDER_SEARCH_ROOTS is unset — no default filesystem scan", async () => {
    delete process.env.AIDER_SEARCH_ROOTS;
    const repoDir = join(root, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, HISTORY_FILE), "# aider chat started at 2026-01-01 10:00:00\n\n#### hi\n\nHello!\n");

    expect(await new AiderAdapter().discover()).toEqual([]);
  });

  it("splits a real-shaped history file into one session per 'chat started at' block", async () => {
    const repoDir = join(root, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      join(repoDir, HISTORY_FILE),
      [
        "# aider chat started at 2026-01-01 10:00:00",
        "",
        "> Aider v0.86.1",
        "",
        "#### fix the login bug",
        "",
        "I'll take a look at the login handler.",
        "",
        "> Tokens: 100 sent, 20 received.",
        "",
        "# aider chat started at 2026-01-02 11:00:00",
        "",
        "#### add a test for the fix",
        "",
        "Sure, adding a test now.",
        "",
      ].join("\n"),
    );
    process.env.AIDER_SEARCH_ROOTS = root;

    const sessions = await new AiderAdapter().discover();

    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.firstUserMessage)).toEqual(["fix the login bug", "add a test for the fix"]);
  });

  it("derives workspace/project from the history file's own directory, not any in-file text", async () => {
    const repoDir = join(root, "my-repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, HISTORY_FILE), "# aider chat started at 2026-01-01 10:00:00\n\n#### hi\n\nHello!\n");
    process.env.AIDER_SEARCH_ROOTS = root;

    const sessions = await new AiderAdapter().discover();

    expect(sessions[0].workspace).toBe(repoDir);
    expect(sessions[0].project).toBe("my-repo");
  });

  it("counts a user turn followed by real reply text as one exchange, and one with no reply as zero assistant turns", async () => {
    const repoDir = join(root, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      join(repoDir, HISTORY_FILE),
      [
        "# aider chat started at 2026-01-01 10:00:00",
        "",
        "#### hi",
        "> ^C again to exit",
        "",
        "#### what can you do?",
        "",
        "I can help you edit code in this repository.",
        "",
        "> Tokens: 50 sent, 10 received.",
        "",
      ].join("\n"),
    );
    process.env.AIDER_SEARCH_ROOTS = root;

    const sessions = await new AiderAdapter().discover();

    expect(sessions[0].userMessageCount).toBe(2);
    expect(sessions[0].assistantMessageCount).toBe(1);
  });

  it("does not count aider's own >-prefixed tool/warning/traceback output as an assistant reply", async () => {
    const repoDir = join(root, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      join(repoDir, HISTORY_FILE),
      [
        "# aider chat started at 2026-01-01 10:00:00",
        "",
        "#### hi",
        "> litellm.APIConnectionError: something went wrong",
        "> Traceback (most recent call last):",
        "> File \"litellm/streaming.py\", line 1, in <module>",
        "",
      ].join("\n"),
    );
    process.env.AIDER_SEARCH_ROOTS = root;

    const sessions = await new AiderAdapter().discover();

    expect(sessions[0].assistantMessageCount).toBe(0);
    expect(sessions[0].userMessageCount).toBe(1);
  });

  it("skips a blank or slash-command first user turn when picking firstUserMessage", async () => {
    const repoDir = join(root, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      join(repoDir, HISTORY_FILE),
      ["# aider chat started at 2026-01-01 10:00:00", "", "#### ", "", "#### /exit", "", "#### actually fix the bug", ""].join("\n"),
    );
    process.env.AIDER_SEARCH_ROOTS = root;

    const sessions = await new AiderAdapter().discover();

    expect(sessions[0].firstUserMessage).toBe("actually fix the bug");
  });

  it("produces a stable, deterministic session id across repeated scans of the same block", async () => {
    const repoDir = join(root, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(join(repoDir, HISTORY_FILE), "# aider chat started at 2026-01-01 10:00:00\n\n#### hi\n\nHello!\n");
    process.env.AIDER_SEARCH_ROOTS = root;

    const first = await new AiderAdapter().discover();
    const second = await new AiderAdapter().discover();

    expect(first[0].nativeSessionId).toBe(second[0].nativeSessionId);
  });

  it("gives each block in the same file a distinct session id", async () => {
    const repoDir = join(root, "repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(
      join(repoDir, HISTORY_FILE),
      ["# aider chat started at 2026-01-01 10:00:00", "#### a", "# aider chat started at 2026-01-02 10:00:00", "#### b"].join("\n"),
    );
    process.env.AIDER_SEARCH_ROOTS = root;

    const sessions = await new AiderAdapter().discover();

    expect(new Set(sessions.map((s) => s.nativeSessionId)).size).toBe(2);
  });

  it("uses the file's mtime as lastActivityAt only for the most recent block, and the block's own start time for earlier ones", async () => {
    const repoDir = join(root, "repo");
    await mkdir(repoDir, { recursive: true });
    const filePath = join(repoDir, HISTORY_FILE);
    await writeFile(
      filePath,
      ["# aider chat started at 2026-01-01 10:00:00", "#### a", "# aider chat started at 2026-01-02 10:00:00", "#### b"].join("\n"),
    );
    const mtime = new Date("2026-01-05T00:00:00.000Z");
    await utimes(filePath, mtime, mtime);
    process.env.AIDER_SEARCH_ROOTS = root;

    const sessions = await new AiderAdapter().discover();

    expect(sessions[0].lastActivityAt).toBe(new Date("2026-01-01T10:00:00").toISOString());
    expect(sessions[1].lastActivityAt).toBe(mtime.toISOString());
  });

  it("skips node_modules and hidden directories while searching", async () => {
    const heavyDir = join(root, "node_modules", "some-pkg");
    await mkdir(heavyDir, { recursive: true });
    await writeFile(join(heavyDir, HISTORY_FILE), "# aider chat started at 2026-01-01 10:00:00\n#### should not be found\n");
    const hiddenDir = join(root, ".cache", "nested");
    await mkdir(hiddenDir, { recursive: true });
    await writeFile(join(hiddenDir, HISTORY_FILE), "# aider chat started at 2026-01-01 10:00:00\n#### should not be found either\n");
    process.env.AIDER_SEARCH_ROOTS = root;

    expect(await new AiderAdapter().discover()).toEqual([]);
  });

  it("finds a history file nested a few directories deep under the search root", async () => {
    const nested = join(root, "workspace", "team", "project");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, HISTORY_FILE), "# aider chat started at 2026-01-01 10:00:00\n\n#### found me\n");
    process.env.AIDER_SEARCH_ROOTS = root;

    const sessions = await new AiderAdapter().discover();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].workspace).toBe(nested);
  });

  it("scans multiple colon-separated search roots and dedupes if they overlap", async () => {
    const repoA = join(root, "a");
    const repoB = join(root, "b");
    await mkdir(repoA, { recursive: true });
    await mkdir(repoB, { recursive: true });
    await writeFile(join(repoA, HISTORY_FILE), "# aider chat started at 2026-01-01 10:00:00\n#### in repo a\n");
    await writeFile(join(repoB, HISTORY_FILE), "# aider chat started at 2026-01-01 10:00:00\n#### in repo b\n");
    process.env.AIDER_SEARCH_ROOTS = `${repoA}:${repoB}:${root}`;

    const sessions = await new AiderAdapter().discover();

    expect(sessions).toHaveLength(2);
  });

  it("has no delete() capability — sessions aren't isolatable files, they share one growing per-repo log", () => {
    const adapter: AgentAdapter = new AiderAdapter();
    expect(adapter.delete).toBeUndefined();
  });
});

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moveToTrash } from "./trash.server.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    callback(null, { stdout: "", stderr: "" });
  }),
}));

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("moveToTrash", () => {
  const originalPlatform = process.platform;
  let root: string;
  let previousHome: string | undefined;
  let previousXdgDataHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sessionforge-trash-"));
    previousHome = process.env.HOME;
    previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.HOME = join(root, "home");
  });

  afterEach(async () => {
    setPlatform(originalPlatform);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgDataHome;
    await rm(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("moves a file into the XDG trash on linux", async () => {
    setPlatform("linux");
    process.env.XDG_DATA_HOME = join(root, "xdg-data");
    const src = join(root, "session.jsonl");
    writeFileSync(src, "hello");

    await moveToTrash(src);

    expect(existsSync(src)).toBe(false);
    const dest = join(root, "xdg-data", "Trash", "files", "session.jsonl");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("hello");
    expect(existsSync(join(root, "xdg-data", "Trash", "info", "session.jsonl.trashinfo"))).toBe(true);
  });

  it("dedupes colliding names with a numeric suffix on linux", async () => {
    setPlatform("linux");
    process.env.XDG_DATA_HOME = join(root, "xdg-data");
    const src = join(root, "session.jsonl");

    writeFileSync(src, "first");
    await moveToTrash(src);
    writeFileSync(src, "second");
    await moveToTrash(src);

    expect(existsSync(join(root, "xdg-data", "Trash", "files", "session.jsonl"))).toBe(true);
    expect(existsSync(join(root, "xdg-data", "Trash", "files", "session.jsonl.2"))).toBe(true);
  });

  it("moves a file into ~/.Trash on macos", async () => {
    setPlatform("darwin");
    const src = join(root, "session.jsonl");
    writeFileSync(src, "hello mac");

    await moveToTrash(src);

    expect(existsSync(src)).toBe(false);
    const dest = join(process.env.HOME as string, ".Trash", "session.jsonl");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("hello mac");
  });

  it("dedupes colliding names with a numeric suffix on macos", async () => {
    setPlatform("darwin");
    const src = join(root, "session.jsonl");

    writeFileSync(src, "first");
    await moveToTrash(src);
    writeFileSync(src, "second");
    await moveToTrash(src);

    expect(existsSync(join(process.env.HOME as string, ".Trash", "session.jsonl"))).toBe(true);
    expect(existsSync(join(process.env.HOME as string, ".Trash", "session.jsonl.2"))).toBe(true);
  });

  it("is idempotent when the file is already gone", async () => {
    setPlatform("linux");
    process.env.XDG_DATA_HOME = join(root, "xdg-data");
    await expect(moveToTrash(join(root, "does-not-exist.jsonl"))).resolves.toBeUndefined();
  });

  it("shells out to PowerShell's SendToRecycleBin on windows instead of touching the filesystem itself", async () => {
    const { execFile } = await import("node:child_process");
    setPlatform("win32");
    const src = join(root, "session.jsonl");
    writeFileSync(src, "hello windows");

    await moveToTrash(src);

    const mock = vi.mocked(execFile);
    expect(mock).toHaveBeenCalledTimes(1);
    const [command, args] = mock.mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe("powershell.exe");
    const script = args[args.length - 1];
    expect(script).toContain("SendToRecycleBin");
    expect(script).toContain(src);
  });

  it("escapes embedded single quotes in the path before handing it to PowerShell", async () => {
    const { execFile } = await import("node:child_process");
    setPlatform("win32");
    const src = join(root, "sessi'on.jsonl");
    writeFileSync(src, "hello");

    await moveToTrash(src);

    const mock = vi.mocked(execFile);
    const [, args] = mock.mock.calls[0] as unknown as [string, string[]];
    const script = args[args.length - 1];
    expect(script).toContain("sessi''on.jsonl");
  });
});

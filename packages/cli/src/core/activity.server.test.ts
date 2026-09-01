import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: (...args: unknown[]) => (execFileMock as unknown as (...a: unknown[]) => void)(...args) };
});

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function callbackOk(stdout: string) {
  return (_cmd: string, _args: string[], callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    callback(null, { stdout, stderr: "" });
  };
}

describe("detectActivity", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  // Faking process.platform doesn't fake the underlying filesystem — this needs a real /proc, so it can
  // only run where the actual OS is Linux, not merely where process.platform is set to "linux".
  it.runIf(originalPlatform === "linux")(
    "reports ACTIVE/HIGH on linux via a real /proc scan matching a live claude-like process's cwd",
    async () => {
      setPlatform("linux");
      const { detectActivity } = await import("./activity.server.js");

      const workspace = await realpath(await mkdtemp(join(tmpdir(), "sessionforge-activity-")));
      // The literal word "claude" just needs to appear somewhere in argv — embedding it in the -e script
      // string itself (rather than as a separate --claude-flavored arg) sidesteps node's own CLI arg
      // parser, which treats a trailing "--xyz"-shaped argument as an (unrecognized) node flag and exits
      // immediately rather than passing it through to the script.
      const child = spawn("node", ["-e", "/* claude */ setTimeout(() => {}, 10000)"], { cwd: workspace, stdio: "ignore" });
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));

        const result = await detectActivity({ workspace, lastActivityAt: new Date().toISOString() });

        expect(result.status).toBe("ACTIVE");
        expect(result.confidence).toBe("HIGH");
      } finally {
        child.kill();
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it("falls back to timestamp heuristics on linux when no live process matches the workspace", async () => {
    setPlatform("linux");
    const { detectActivity } = await import("./activity.server.js");

    const result = await detectActivity({ workspace: "/no/such/live/workspace", lastActivityAt: new Date().toISOString() });

    expect(result.status).toBe("RECENT");
    expect(result.confidence).toBe("MEDIUM");
  });

  it("reports ACTIVE on macos by combining mocked ps + lsof output (no /proc there)", async () => {
    setPlatform("darwin");
    execFileMock
      .mockImplementationOnce(callbackOk("4242 /usr/local/bin/node /usr/local/bin/claude\n"))
      .mockImplementationOnce(callbackOk("p4242\nfcwd\nn/Users/dev/project\n"));

    const { detectActivity } = await import("./activity.server.js");
    const result = await detectActivity({ workspace: "/Users/dev/project", lastActivityAt: new Date().toISOString() });

    expect(result.status).toBe("ACTIVE");
    expect(result.confidence).toBe("HIGH");
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0][0]).toBe("ps");
    expect(execFileMock.mock.calls[1][0]).toBe("lsof");
  });

  it("falls back to timestamp heuristics on macos when ps finds no matching process", async () => {
    setPlatform("darwin");
    execFileMock.mockImplementationOnce(callbackOk("99 /usr/bin/unrelated-tool\n"));

    const { detectActivity } = await import("./activity.server.js");
    const result = await detectActivity({ workspace: "/Users/dev/project", lastActivityAt: new Date().toISOString() });

    expect(result.status).toBe("RECENT");
    expect(execFileMock).toHaveBeenCalledTimes(1); // no lsof call needed when ps found nothing
  });

  it("never claims ACTIVE on windows — no live-process signal is available there, even for a fresh timestamp", async () => {
    setPlatform("win32");
    const { detectActivity } = await import("./activity.server.js");

    const result = await detectActivity({ workspace: "C:\\Users\\dev\\project", lastActivityAt: new Date().toISOString() });

    expect(result.status).toBe("RECENT");
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

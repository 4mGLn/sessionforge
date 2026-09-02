import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ExecFileCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;
type ExecFileHandler = (cmd: string, args: string[], callback: ExecFileCallback) => void;

let execFileHandler: ExecFileHandler = (_cmd, _args, callback) => callback(null, { stdout: "", stderr: "" });

vi.mock("node:child_process", () => ({
  execFile: vi.fn((cmd: string, args: string[], callback: ExecFileCallback) => execFileHandler(cmd, args, callback)),
}));

const {
  arePluginsEnabled,
  downloadPluginArchive,
  extractPluginArchive,
  getPluginStatus,
  installPluginDirectory,
  isPaseoCliAvailable,
  pluginInstallDir,
} = await import("./paseo-wire.server.js");

function jsonResult(value: unknown): { stdout: string; stderr: string } {
  return { stdout: JSON.stringify(value), stderr: "" };
}

describe("paseo-wire", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sessionforge-paseo-wire-"));
    execFileHandler = (_cmd, _args, callback) => callback(null, { stdout: "", stderr: "" });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  describe("isPaseoCliAvailable", () => {
    it("returns true when `paseo --version` succeeds", async () => {
      execFileHandler = (_cmd, _args, callback) => callback(null, { stdout: "0.7.0\n", stderr: "" });
      expect(await isPaseoCliAvailable()).toBe(true);
    });

    it("returns false when paseo isn't on PATH", async () => {
      execFileHandler = (_cmd, _args, callback) => callback(new Error("command not found: paseo"));
      expect(await isPaseoCliAvailable()).toBe(false);
    });
  });

  describe("arePluginsEnabled", () => {
    it("reads pluginsEnabled from <daemon home>/config.json", async () => {
      await writeFile(join(root, "config.json"), JSON.stringify({ pluginsEnabled: true }));
      execFileHandler = (_cmd, args, callback) => {
        if (args.includes("status")) return callback(null, jsonResult({ home: root }));
        callback(new Error(`unexpected exec: ${args.join(" ")}`));
      };
      expect(await arePluginsEnabled()).toBe(true);
    });

    it("treats a missing pluginsEnabled field as disabled, matching Paseo's own default", async () => {
      await writeFile(join(root, "config.json"), JSON.stringify({}));
      execFileHandler = (_cmd, args, callback) => {
        if (args.includes("status")) return callback(null, jsonResult({ home: root }));
        callback(new Error(`unexpected exec: ${args.join(" ")}`));
      };
      expect(await arePluginsEnabled()).toBe(false);
    });

    it("treats pluginsEnabled: false as disabled", async () => {
      await writeFile(join(root, "config.json"), JSON.stringify({ pluginsEnabled: false }));
      execFileHandler = (_cmd, args, callback) => {
        if (args.includes("status")) return callback(null, jsonResult({ home: root }));
        callback(new Error(`unexpected exec: ${args.join(" ")}`));
      };
      expect(await arePluginsEnabled()).toBe(false);
    });
  });

  describe("downloadPluginArchive", () => {
    it("downloads the version-matched release asset, not `releases/latest`", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        expect(url).toBe("https://github.com/4mGLn/sessionforge/releases/download/v1.2.3/sessionforge-paseo-plugin.tar.gz");
        return new Response("fake tarball contents", { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);

      const destPath = join(root, "plugin.tar.gz");
      await downloadPluginArchive("1.2.3", destPath);

      expect(fetchMock).toHaveBeenCalledOnce();
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(destPath, "utf8")).toBe("fake tarball contents");
    });

    it("throws with the status when the download fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 404, statusText: "Not Found" })),
      );

      await expect(downloadPluginArchive("9.9.9", join(root, "plugin.tar.gz"))).rejects.toThrow(/404/);
    });
  });

  describe("extractPluginArchive", () => {
    it("wipes the destination and shells out to tar", async () => {
      const destDir = join(root, "dest");
      let sawTarArgs: string[] = [];
      execFileHandler = (cmd, args, callback) => {
        sawTarArgs = args;
        expect(cmd).toBe("tar");
        callback(null, { stdout: "", stderr: "" });
      };

      await extractPluginArchive(join(root, "archive.tar.gz"), destDir);

      expect(sawTarArgs).toEqual(["-xzf", join(root, "archive.tar.gz"), "-C", destDir]);
    });
  });

  describe("installPluginDirectory", () => {
    it("passes the directory and id through to `paseo plugin install`", async () => {
      let sawArgs: string[] = [];
      execFileHandler = (_cmd, args, callback) => {
        sawArgs = args;
        callback(null, jsonResult({ id: "sessionforge", path: "/plugin/dir", enabled: true, status: "running" }));
      };

      const result = await installPluginDirectory("/plugin/dir", "sessionforge");

      expect(sawArgs).toEqual(["plugin", "install", "/plugin/dir", "--id", "sessionforge", "--json"]);
      expect(result).toEqual({ id: "sessionforge", path: "/plugin/dir", enabled: true, status: "running" });
    });
  });

  describe("getPluginStatus", () => {
    it("finds the plugin by id in `paseo plugin ls --json`'s output", async () => {
      execFileHandler = (_cmd, _args, callback) =>
        callback(
          null,
          jsonResult([
            { id: "other-plugin", path: "/x", enabled: true, status: "running" },
            { id: "sessionforge", path: "/y", enabled: true, status: "running" },
          ]),
        );

      expect(await getPluginStatus("sessionforge")).toEqual({ id: "sessionforge", path: "/y", enabled: true, status: "running" });
    });

    it("returns null when the plugin isn't installed", async () => {
      execFileHandler = (_cmd, _args, callback) => callback(null, jsonResult([]));
      expect(await getPluginStatus("sessionforge")).toBeNull();
    });
  });

  describe("pluginInstallDir", () => {
    it("is a stable path under the user's home directory", () => {
      expect(pluginInstallDir()).toContain(".sessionforge");
      expect(pluginInstallDir()).toContain("paseo-plugin");
    });
  });
});

import { existsSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp as mkdtempAsync, readFile, rename as realRename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Lets specific tests simulate a cross-filesystem rename (EXDEV) without needing two real filesystems —
// falls through to the real implementation for every test that doesn't set an override.
let renameOverride: ((source: string, dest: string) => Promise<void>) | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (source: string, dest: string) => (renameOverride ? renameOverride(source, dest) : actual.rename(source, dest)),
  };
});

const {
  checkForUpdateCached,
  compareVersions,
  downloadCliBinary,
  getLatestReleaseVersion,
  InvalidVersionError,
  isUpdateAvailable,
  selfReplaceBinary,
  targetTriple,
} = await import("./update.server.js");

function exdevError(): NodeJS.ErrnoException {
  const error = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
  error.code = "EXDEV";
  return error;
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

describe("compareVersions", () => {
  it("compares numerically, not lexicographically", () => {
    expect(compareVersions("0.10.0", "0.2.0")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.10.0")).toBeLessThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("treats a missing trailing component as 0", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.3", "1.2.9")).toBeGreaterThan(0);
  });

  it("throws InvalidVersionError instead of silently comparing as NaN for a non-numeric component", () => {
    // A plain numeric split+compare would make "0.3.0-rc" parse to [0, 3, NaN] — NaN is never > 0, so a
    // real update would go permanently invisible to isUpdateAvailable without this ever raising an error.
    expect(() => compareVersions("0.3.0-rc", "0.2.0")).toThrow(InvalidVersionError);
  });
});

describe("isUpdateAvailable", () => {
  it("is true when latest is numerically newer", () => {
    expect(isUpdateAvailable("0.2.0", "0.3.0")).toBe(true);
  });

  it("is false when already on the latest version", () => {
    expect(isUpdateAvailable("0.3.0", "0.3.0")).toBe(false);
  });

  it("is false when somehow ahead of the latest release", () => {
    expect(isUpdateAvailable("0.4.0", "0.3.0")).toBe(false);
  });

  it("is always true for a dev-main build — any real release counts as newer", () => {
    expect(isUpdateAvailable("dev-main", "0.0.1")).toBe(true);
  });

  it("fails toward 'yes, update available' rather than silently hiding an unparseable version", () => {
    expect(isUpdateAvailable("0.2.0", "0.3.0-rc.1")).toBe(true);
  });
});

describe("targetTriple", () => {
  const originalPlatform = process.platform;
  const originalArch = process.arch;

  afterEach(() => {
    setPlatform(originalPlatform);
    Object.defineProperty(process, "arch", { value: originalArch, configurable: true });
  });

  function setArch(arch: string): void {
    Object.defineProperty(process, "arch", { value: arch, configurable: true });
  }

  it("maps linux/x64 to the gnu triple", () => {
    setPlatform("linux");
    setArch("x64");
    expect(targetTriple()).toBe("x86_64-unknown-linux-gnu");
  });

  it("maps win32/x64 to the msvc triple", () => {
    setPlatform("win32");
    setArch("x64");
    expect(targetTriple()).toBe("x86_64-pc-windows-msvc");
  });

  it("throws on an unsupported combination rather than guessing", () => {
    setPlatform("linux");
    setArch("ia32");
    expect(() => targetTriple()).toThrow(/Unsupported/);
  });
});

describe("getLatestReleaseVersion", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("strips the leading 'v' from the release tag", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ tag_name: "v0.3.0" }), { status: 200 })),
    );
    expect(await getLatestReleaseVersion()).toBe("0.3.0");
  });

  it("throws with the status on a failed request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404, statusText: "Not Found" })),
    );
    await expect(getLatestReleaseVersion()).rejects.toThrow(/404/);
  });
});

describe("downloadCliBinary", () => {
  const originalPlatform = process.platform;
  let root: string;

  beforeEach(async () => {
    root = await mkdtempAsync(join(tmpdir(), "sessionforge-update-dl-"));
  });

  afterEach(async () => {
    setPlatform(originalPlatform);
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("downloads the platform-matched asset and writes it to the destination path", async () => {
    setPlatform("linux");
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });

    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://github.com/4mGLn/sessionforge/releases/download/v0.3.0/sessionforge-x86_64-unknown-linux-gnu");
      return new Response("fake binary contents", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const destPath = join(root, "sessionforge");
    await downloadCliBinary("0.3.0", destPath);

    expect(await readFile(destPath, "utf8")).toBe("fake binary contents");
  });

  // Faking process.platform doesn't fake the underlying filesystem — chmod's exec bits only mean anything
  // real on a real POSIX filesystem, so this only runs where the actual OS is Linux/macOS, not merely
  // where process.platform is set to one (same principle as activity.server.test.ts's real /proc test).
  it.runIf(originalPlatform !== "win32")("sets the executable bit on a real POSIX filesystem", async () => {
    // No process.platform faking here — this needs the real host OS's real filesystem semantics.
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("fake binary contents", { status: 200 })),
    );

    const destPath = join(root, "sessionforge");
    await downloadCliBinary("0.3.0", destPath);

    expect(statSync(destPath).mode & 0o111).not.toBe(0);
  });

  it("throws with the status when the download fails", async () => {
    setPlatform("linux");
    Object.defineProperty(process, "arch", { value: "x64", configurable: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404, statusText: "Not Found" })),
    );

    await expect(downloadCliBinary("9.9.9", join(root, "sessionforge"))).rejects.toThrow(/404/);
  });
});

describe("selfReplaceBinary", () => {
  const originalPlatform = process.platform;
  let root: string;

  beforeEach(async () => {
    root = await mkdtempAsync(join(tmpdir(), "sessionforge-update-replace-"));
  });

  afterEach(async () => {
    setPlatform(originalPlatform);
    await rm(root, { recursive: true, force: true });
  });

  it("renames the new binary over the current one on linux/macos", async () => {
    setPlatform("linux");
    const current = join(root, "sessionforge");
    const incoming = join(root, "sessionforge-new");
    writeFileSync(current, "old");
    writeFileSync(incoming, "new");

    await selfReplaceBinary(incoming, current);

    expect(await readFile(current, "utf8")).toBe("new");
  });

  it("renames the running exe aside first on windows, since it can't be overwritten directly", async () => {
    setPlatform("win32");
    const current = join(root, "sessionforge.exe");
    const incoming = join(root, "sessionforge-new.exe");
    writeFileSync(current, "old");
    writeFileSync(incoming, "new");

    await selfReplaceBinary(incoming, current);

    expect(await readFile(current, "utf8")).toBe("new");
  });

  afterEach(() => {
    renameOverride = null;
  });

  it("falls back to copy+unlink on EXDEV — e.g. the download and install location are on different filesystems", async () => {
    setPlatform("linux");
    const current = join(root, "sessionforge");
    const incoming = join(root, "sessionforge-new");
    writeFileSync(current, "old");
    writeFileSync(incoming, "new");

    renameOverride = async () => {
      throw exdevError();
    };

    await selfReplaceBinary(incoming, current);

    expect(await readFile(current, "utf8")).toBe("new");
    expect(existsSync(incoming)).toBe(false); // source removed after the copy, same as a real rename would leave it
  });

  it("rolls the original binary back into place on windows if putting the new one there fails, instead of leaving nothing runnable", async () => {
    setPlatform("win32");
    const current = join(root, "sessionforge.exe");
    const incoming = join(root, "sessionforge-new.exe");
    writeFileSync(current, "old");
    writeFileSync(incoming, "new");

    let call = 0;
    renameOverride = async (source, dest) => {
      call += 1;
      if (call === 2) throw new Error("simulated: antivirus lock");
      return realRename(source, dest);
    };

    await expect(selfReplaceBinary(incoming, current)).rejects.toThrow(/antivirus lock/);

    // A failed update must be a no-op, never a bricked install — the original binary has to still be
    // runnable at its original path.
    expect(await readFile(current, "utf8")).toBe("old");
  });
});

describe("checkForUpdateCached", () => {
  let root: string;
  let previousHome: string | undefined;
  let previousUserProfile: string | undefined;
  let previousCi: string | undefined;

  beforeEach(async () => {
    root = await mkdtempAsync(join(tmpdir(), "sessionforge-update-cache-"));
    previousHome = process.env.HOME;
    previousUserProfile = process.env.USERPROFILE;
    previousCi = process.env.CI;
    // node:os's homedir() reads USERPROFILE (not HOME) on Windows — setting both keeps the cache file
    // sandboxed to `root` regardless of which real OS runs this test.
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    // This suite itself normally runs inside GitHub Actions, which sets CI=true by default — unset it here
    // so the non-CI-skip tests below actually exercise real behavior instead of hitting the new CI guard
    // regardless of what they're testing.
    delete process.env.CI;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    await rm(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("returns null immediately for a dev-main build, without any network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await checkForUpdateCached("dev-main")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null immediately in CI, without any network call — no one reads the notice in a pipeline", async () => {
    process.env.CI = "true";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await checkForUpdateCached("0.3.0")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("performs a real check and reports an available update", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ tag_name: "v0.5.0" }), { status: 200 })),
    );

    expect(await checkForUpdateCached("0.3.0")).toEqual({ latestVersion: "0.5.0", updateAvailable: true });
  });

  it("reuses the cached result within the TTL instead of hitting the network again", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tag_name: "v0.5.0" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await checkForUpdateCached("0.3.0");
    await checkForUpdateCached("0.3.0");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails safe (returns null) on a network error rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unreachable");
      }),
    );

    expect(await checkForUpdateCached("0.3.0")).toBeNull();
  });
});

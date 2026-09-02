import { chmodSync, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const REPO = "4mGLn/sessionforge";
const UPDATE_CHECK_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — one real network check per day at most
const BACKGROUND_CHECK_TIMEOUT_MS = 3000; // a background nice-to-have shouldn't stall an unrelated command

function updateCheckCachePath(): string {
  return join(homedir(), ".sessionforge", "update-check.json");
}

/** Same target-triple naming release.yml's matrix and install.sh use — reimplemented here (rather than
 * imported from build-binary.mjs, a build-time-only script not part of the runtime bundle) since it's
 * only a few lines and this needs the actual runtime platform/arch, not a build script's. */
export function targetTriple(): string {
  const p = platform();
  const a = arch();
  if (p === "linux" && a === "x64") return "x86_64-unknown-linux-gnu";
  if (p === "linux" && a === "arm64") return "aarch64-unknown-linux-gnu";
  if (p === "darwin" && a === "x64") return "x86_64-apple-darwin";
  if (p === "darwin" && a === "arm64") return "aarch64-apple-darwin";
  if (p === "win32" && a === "x64") return "x86_64-pc-windows-msvc";
  throw new Error(`Unsupported platform/arch combination for self-update: ${p}/${a}`);
}

/** Compares two dotted-numeric version strings (e.g. "0.10.2" vs "0.2.9") field by field, not
 * lexicographically — a plain string compare would wrongly rank "0.10.0" below "0.2.0". */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** "dev-main" (a local/non-release build) never numerically compares — any real release counts as newer. */
export function isUpdateAvailable(current: string, latest: string): boolean {
  if (current === "dev-main") return true;
  return compareVersions(latest, current) > 0;
}

interface GitHubRelease {
  tag_name: string;
}

/** Strips the release tag's leading "v" (tags are "v0.2.0", versions are "0.2.0") — GitHub's REST API,
 * not `releases/latest` redirect-following, so a 404 (no releases yet) surfaces as a real thrown error
 * instead of silently resolving to some unrelated page. `signal` lets the background auto-check (unlike an
 * explicit `check-update`/`update` run, which should just wait) give up quickly on a slow network instead
 * of noticeably delaying an unrelated command. */
export async function getLatestReleaseVersion(signal?: AbortSignal): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`Failed to check latest release (${response.status} ${response.statusText})`);
  }
  const release = (await response.json()) as GitHubRelease;
  return release.tag_name.replace(/^v/, "");
}

interface UpdateCheckCache {
  lastCheckedAt: number;
  latestVersion: string;
}

/**
 * Rate-limited (24h) background-style check — never throws, so it's safe to call unconditionally at the
 * end of any command without risking that command's own output/exit code. Returns null on any failure
 * (network down, GitHub unreachable, cache unreadable) or when running a dev-main build, so callers can
 * just skip printing anything rather than needing their own error handling.
 */
export async function checkForUpdateCached(currentVersion: string): Promise<{ latestVersion: string; updateAvailable: boolean } | null> {
  if (currentVersion === "dev-main") return null;

  try {
    const cachePath = updateCheckCachePath();
    let cached: UpdateCheckCache | null = null;
    try {
      cached = JSON.parse(await readFile(cachePath, "utf8")) as UpdateCheckCache;
    } catch {
      // no cache yet, or unreadable — fall through to a fresh check
    }

    let latestVersion: string;
    if (cached && Date.now() - cached.lastCheckedAt < UPDATE_CHECK_CACHE_TTL_MS) {
      latestVersion = cached.latestVersion;
    } else {
      latestVersion = await getLatestReleaseVersion(AbortSignal.timeout(BACKGROUND_CHECK_TIMEOUT_MS));
      await mkdir(join(homedir(), ".sessionforge"), { recursive: true });
      await writeFile(cachePath, JSON.stringify({ lastCheckedAt: Date.now(), latestVersion } satisfies UpdateCheckCache));
    }

    return { latestVersion, updateAvailable: isUpdateAvailable(currentVersion, latestVersion) };
  } catch {
    return null;
  }
}

/** Downloads the platform-matched binary asset for a given release version — same naming convention
 * install.sh/build-binary.mjs use: `sessionforge-<target-triple>`, `.exe` suffixed on Windows. */
export async function downloadCliBinary(version: string, destPath: string): Promise<void> {
  const isWindows = platform() === "win32";
  const assetName = `sessionforge-${targetTriple()}${isWindows ? ".exe" : ""}`;
  const url = `https://github.com/${REPO}/releases/download/v${version}/${assetName}`;
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(destPath));
  if (!isWindows) chmodSync(destPath, 0o755);
}

/**
 * Replaces the currently-running binary in place with a freshly-downloaded one — the standard
 * self-updating-CLI pattern (same one rustup/many Go tools use), because a running executable can't just
 * be overwritten directly on every OS:
 * - Linux/macOS: renaming a file that's currently executing is fine — the OS keeps the old inode alive for
 *   the still-running process, and the path just starts pointing at the new file. A same-directory rename
 *   (not a cross-filesystem copy) keeps this atomic.
 * - Windows: a running .exe can't be deleted or overwritten, but it CAN be renamed. So the running binary
 *   is renamed to a `.old.exe` sibling first, then the downloaded file takes its original name. The
 *   `.old.exe` is best-effort deleted immediately after (already-renamed-away, so this rarely fails, but a
 *   file still flushing to disk on a slow machine could keep it locked a moment longer) — a leftover
 *   `.old.exe` is harmless clutter, not a correctness problem, so a failed cleanup isn't treated as fatal.
 */
export async function selfReplaceBinary(newBinaryPath: string, currentExecPath: string): Promise<void> {
  if (platform() === "win32") {
    const oldPath = `${currentExecPath}.old.exe`;
    await rm(oldPath, { force: true });
    await rename(currentExecPath, oldPath);
    await rename(newBinaryPath, currentExecPath);
    await rm(oldPath, { force: true }).catch(() => {});
    return;
  }

  await rename(newBinaryPath, currentExecPath);
}

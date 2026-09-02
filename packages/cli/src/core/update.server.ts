import { chmodSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import { downloadFile } from "./download.server.js";

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

/** Thrown by compareVersions for anything that isn't a plain dotted-numeric version (e.g. a pre-release
 * tag like "0.3.0-rc.1") — better than silently comparing as NaN, which is neither > 0 nor < 0 nor === 0
 * and would make a real update invisible to isUpdateAvailable without ever raising an error anywhere. */
export class InvalidVersionError extends Error {}

function parseVersionParts(version: string): number[] {
  const parts = version.split(".").map(Number);
  if (parts.some((part) => Number.isNaN(part))) {
    throw new InvalidVersionError(`Not a plain dotted-numeric version: "${version}"`);
  }
  return parts;
}

/** Compares two dotted-numeric version strings (e.g. "0.10.2" vs "0.2.9") field by field, not
 * lexicographically — a plain string compare would wrongly rank "0.10.0" below "0.2.0". */
export function compareVersions(a: string, b: string): number {
  const partsA = parseVersionParts(a);
  const partsB = parseVersionParts(b);
  const length = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < length; i += 1) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/**
 * "dev-main" (a local/non-release build) never numerically compares — any real release counts as newer.
 * A version that fails to parse (see InvalidVersionError) fails toward "yes, an update might be available"
 * rather than silently claiming everything's fine when the comparison itself couldn't actually be done.
 */
export function isUpdateAvailable(current: string, latest: string): boolean {
  if (current === "dev-main") return true;
  try {
    return compareVersions(latest, current) > 0;
  } catch (error) {
    if (error instanceof InvalidVersionError) return true;
    throw error;
  }
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
 * Rate-limited (24h) update check appended to the end of most commands. Not a detached background task —
 * it genuinely delays process exit by up to BACKGROUND_CHECK_TIMEOUT_MS on a cache-miss day, since the
 * whole point is printing its notice before the command's own output is done. Never throws, so it's safe
 * to call unconditionally without risking the calling command's own output/exit code. Returns null on any
 * failure (network down, GitHub unreachable, cache unreadable), when running a dev-main build, or in CI
 * (`CI` env var — a stalled network check has no one to read its notice and just wastes time in a
 * pipeline), so callers can just skip printing anything rather than needing their own error handling.
 */
export async function checkForUpdateCached(currentVersion: string): Promise<{ latestVersion: string; updateAvailable: boolean } | null> {
  if (currentVersion === "dev-main" || process.env.CI) return null;

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
  await downloadFile(url, destPath);
  if (!isWindows) chmodSync(destPath, 0o755);
}

/** rename() across filesystems throws EXDEV — falls back to copy+unlink, since the downloaded file
 * (usually under the OS temp dir) and the install location aren't guaranteed to be on the same filesystem
 * (e.g. tmpfs /tmp vs a separately-mounted /usr/local/bin). Same pattern trash.server.ts's own
 * renameOrCopy already uses for the identical reason. */
async function renameOrCopy(sourcePath: string, destPath: string): Promise<void> {
  try {
    await rename(sourcePath, destPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await copyFile(sourcePath, destPath);
    await unlink(sourcePath);
  }
}

/**
 * Replaces the currently-running binary in place with a freshly-downloaded one — the standard
 * self-updating-CLI pattern (same one rustup/many Go tools use), because a running executable can't just
 * be overwritten directly on every OS:
 * - Linux/macOS: renaming (or, cross-filesystem, copying) over a file that's currently executing is fine —
 *   the OS keeps the old inode alive for the still-running process, and the path just starts pointing at
 *   the new file.
 * - Windows: a running .exe can't be deleted or overwritten, but it CAN be renamed. So the running binary
 *   is renamed to a `.old.exe` sibling first, then the downloaded file takes its original name. If that
 *   second step fails (cross-filesystem copy error, antivirus lock, disk full) the `.old.exe` is renamed
 *   straight back to the original name so the user isn't left with no runnable binary at all — a failed
 *   update should be a no-op, never a bricked install. The `.old.exe` is best-effort deleted once the swap
 *   actually succeeds; a leftover on a rare cleanup failure is harmless clutter, not a correctness problem.
 */
export async function selfReplaceBinary(newBinaryPath: string, currentExecPath: string): Promise<void> {
  if (platform() === "win32") {
    const oldPath = `${currentExecPath}.old.exe`;
    await rm(oldPath, { force: true });
    await renameOrCopy(currentExecPath, oldPath);
    try {
      await renameOrCopy(newBinaryPath, currentExecPath);
    } catch (error) {
      await renameOrCopy(oldPath, currentExecPath).catch(() => {});
      throw error;
    }
    await rm(oldPath, { force: true }).catch(() => {});
    return;
  }

  await renameOrCopy(newBinaryPath, currentExecPath);
}

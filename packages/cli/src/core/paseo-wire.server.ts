import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_PLUGIN_ID = "sessionforge";
export const PLUGIN_ARCHIVE_NAME = "sessionforge-paseo-plugin.tar.gz";

/** Where a downloaded plugin gets extracted to before `paseo plugin install` points at it — a stable,
 * reusable path so re-running wire-paseo cleanly replaces a previous install with a newer one. */
export function pluginInstallDir(): string {
  return join(homedir(), ".sessionforge", "paseo-plugin");
}

/** Confirms the `paseo` CLI is actually on PATH before attempting anything that shells out to it. */
export async function isPaseoCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync("paseo", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

interface DaemonStatus {
  home: string;
}

/** The daemon's own state directory (holding config.json) — via `paseo daemon status --json`, not
 * guessed, since it's configurable and this must work for both default and custom PASEO_HOME setups. */
async function getDaemonHome(): Promise<string> {
  const { stdout } = await execFileAsync("paseo", ["daemon", "status", "--json"]);
  const status = JSON.parse(stdout) as DaemonStatus;
  if (!status.home) throw new Error("`paseo daemon status --json` did not report a home directory.");
  return status.home;
}

/**
 * Plugins are trusted, unsandboxed code — this only ever reads the daemon's `pluginsEnabled` setting, it
 * never writes it. A missing field is treated as disabled, matching Paseo's own documented default.
 */
export async function arePluginsEnabled(): Promise<boolean> {
  const home = await getDaemonHome();
  const configPath = join(home, "config.json");
  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw) as { pluginsEnabled?: boolean };
  return config.pluginsEnabled === true;
}

/** Downloads a version-matched release asset — not `releases/latest`, so an older sessionforge binary
 * always wires up the plugin build it actually shipped with, not a possibly-incompatible newer one. */
export async function downloadPluginArchive(version: string, destPath: string): Promise<void> {
  const url = `https://github.com/4mGLn/sessionforge/releases/download/v${version}/${PLUGIN_ARCHIVE_NAME}`;
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}): ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(destPath));
}

/** tar ships on Linux/macOS by default and as bsdtar on Windows 10 1803+ / Windows 11 — the same
 * assumption install.sh/install.ps1 and this project's other platform-support claims already make. */
export async function extractPluginArchive(archivePath: string, destDir: string): Promise<void> {
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  await execFileAsync("tar", ["-xzf", archivePath, "-C", destDir]);
}

interface PluginInstallResult {
  id: string;
  path: string;
  enabled: boolean;
  status: string;
  error?: string;
}

export async function installPluginDirectory(pluginDir: string, id: string = DEFAULT_PLUGIN_ID): Promise<PluginInstallResult> {
  const { stdout } = await execFileAsync("paseo", ["plugin", "install", pluginDir, "--id", id, "--json"]);
  return JSON.parse(stdout) as PluginInstallResult;
}

export async function getPluginStatus(id: string = DEFAULT_PLUGIN_ID): Promise<PluginInstallResult | null> {
  const { stdout } = await execFileAsync("paseo", ["plugin", "ls", "--json"]);
  const plugins = JSON.parse(stdout) as PluginInstallResult[];
  return plugins.find((plugin) => plugin.id === id) ?? null;
}

export function pluginArchiveExists(path: string): boolean {
  return existsSync(path);
}

const PLUGIN_VERSION_FILE = ".sessionforge-version";

/**
 * Reads the version marker `scripts/package-plugin.mjs` bakes into every packaged plugin bundle — lets
 * `paseo-status` report drift between what's actually installed and the running CLI's own version, without
 * needing Paseo itself to know anything about SessionForge's versioning. Returns null for a plugin that
 * was never installed via `wire-paseo` at all (e.g. the manual `paseo plugin install /path/to/clone` dev
 * flow, which has no such marker file) — that's a legitimate, expected case, not an error.
 */
export async function getInstalledPluginVersion(pluginDir: string): Promise<string | null> {
  try {
    return (await readFile(join(pluginDir, PLUGIN_VERSION_FILE), "utf8")).trim();
  } catch {
    return null;
  }
}

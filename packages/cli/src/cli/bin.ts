#!/usr/bin/env -S npx tsx
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiderAdapter } from "../core/aider-adapter.server.js";
import { ClaudeCodeAdapter } from "../core/claude-adapter.server.js";
import { CodexAdapter } from "../core/codex-adapter.server.js";
import { runDiscovery } from "../core/discover.server.js";
import { GeminiCliAdapter } from "../core/gemini-adapter.server.js";
import { archiveSession, restoreSession, runCleanup, SessionNotFoundError } from "../core/lifecycle-actions.server.js";
import { OpenCodeAdapter } from "../core/opencode-adapter.server.js";
import {
  arePluginsEnabled,
  DEFAULT_PLUGIN_ID,
  downloadPluginArchive,
  extractPluginArchive,
  getPluginStatus,
  installPluginDirectory,
  isPaseoCliAvailable,
  PLUGIN_ARCHIVE_NAME,
  pluginInstallDir,
} from "../core/paseo-wire.server.js";
import { SessionStore } from "../core/store.server.js";
import type { AgentId, ClassificationCategory, SessionLifecycle, SessionStatus } from "../core/types.server.js";
import { formatSessionDetail, formatSessionTable, parseOlderThan } from "./format.js";

const ADAPTERS = [new ClaudeCodeAdapter(), new CodexAdapter(), new GeminiCliAdapter(), new OpenCodeAdapter(), new AiderAdapter()];
const ACTOR = "cli";

// Baked in by esbuild's `define` when built into the standalone binary (see build-binary.mjs), which in
// turn gets it from the git tag that triggered release.yml — the tag is the single source of truth for
// version, not packages/cli/package.json (whose own version field is unrelated and never read here).
// "dev-main" means this binary wasn't built by release.yml at all — a local/dev build, not a release.
declare const __SESSIONFORGE_VERSION__: string | undefined;

const DEV_VERSION = "dev-main";

function getVersion(): string {
  return typeof __SESSIONFORGE_VERSION__ !== "undefined" ? __SESSIONFORGE_VERSION__ : DEV_VERSION;
}

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags.set(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(body, next);
        i += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }
    positional.push(arg);
  }

  return { positional, flags };
}

function flagString(flags: Map<string, string | boolean>, key: string): string | undefined {
  const value = flags.get(key);
  return typeof value === "string" ? value : undefined;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function cmdDiscover(): Promise<void> {
  const store = new SessionStore();
  try {
    const result = await runDiscovery(store, ADAPTERS);
    console.log(`Scanned ${result.scanned} session(s): ${result.created} new, ${result.updated} updated.`);
  } finally {
    store.close();
  }
}

async function cmdList(args: ParsedArgs): Promise<void> {
  const store = new SessionStore();
  try {
    if (args.flags.get("scan")) await runDiscovery(store, ADAPTERS);

    const olderThanFlag = flagString(args.flags, "older-than");
    const sessions = store.listSessions({
      agent: flagString(args.flags, "agent") as AgentId | undefined,
      project: flagString(args.flags, "project"),
      status: flagString(args.flags, "status")?.toUpperCase() as SessionStatus | undefined,
      lifecycle: flagString(args.flags, "lifecycle")?.toUpperCase() as SessionLifecycle | undefined,
      category: flagString(args.flags, "category")?.toUpperCase() as ClassificationCategory | undefined,
      olderThanMs: olderThanFlag ? parseOlderThan(olderThanFlag) : undefined,
      query: flagString(args.flags, "query"),
    });

    if (args.flags.get("json")) printJson(sessions);
    else console.log(formatSessionTable(sessions));
  } finally {
    store.close();
  }
}

async function cmdShow(args: ParsedArgs): Promise<void> {
  const id = args.positional[0];
  if (!id) throw new Error("Usage: sessionforge show <id>");

  const store = new SessionStore();
  try {
    const session = store.getSession(id);
    if (!session) {
      console.error(`Session not found: ${id}`);
      process.exitCode = 1;
      return;
    }
    const relationships = store.listRelationships(id);
    if (args.flags.get("json")) printJson({ ...session, relationships });
    else console.log(formatSessionDetail(session, relationships));
  } finally {
    store.close();
  }
}

async function cmdSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(" ");
  if (!query) throw new Error("Usage: sessionforge search <query>");

  const store = new SessionStore();
  try {
    const sessions = store.listSessions({ query });
    if (args.flags.get("json")) printJson(sessions);
    else console.log(formatSessionTable(sessions));
  } finally {
    store.close();
  }
}

async function cmdCleanup(args: ParsedArgs): Promise<void> {
  const store = new SessionStore();
  try {
    const dryRun = !args.flags.get("apply");
    const result = runCleanup(store, ACTOR, dryRun);

    if (args.flags.get("json")) {
      printJson(result);
      return;
    }

    if (result.candidates.length === 0) {
      console.log("No junk candidates found. Nothing to clean up.");
      return;
    }

    console.log(dryRun ? "JUNK CANDIDATES (dry run — nothing changed)\n" : "TRASHED SESSIONS\n");
    for (const [index, session] of result.candidates.entries()) {
      console.log(`${index + 1}. ${session.agent} / ${session.project}`);
      console.log(`   Created: ${session.createdAt.slice(0, 10)}`);
      console.log(`   Messages: ${session.messageCount}`);
      console.log(`   Reason: ${session.classification?.reason ?? "-"}`);
      console.log(`   Confidence: ${Math.round((session.classification?.confidence ?? 0) * 100)}%\n`);
    }
    console.log(dryRun ? "Nothing deleted. Re-run with --apply to move these to trash." : `${result.applied.length} session(s) moved to trash.`);
  } finally {
    store.close();
  }
}

async function cmdArchive(args: ParsedArgs): Promise<void> {
  const id = args.positional[0];
  if (!id) throw new Error("Usage: sessionforge archive <id> [--reason <text>]");

  const store = new SessionStore();
  try {
    const session = archiveSession(store, id, ACTOR, flagString(args.flags, "reason") ?? null);
    console.log(`Archived ${session.id} (${session.title ?? "untitled"}).`);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    store.close();
  }
}

async function cmdRestore(args: ParsedArgs): Promise<void> {
  const id = args.positional[0];
  if (!id) throw new Error("Usage: sessionforge restore <id> [--reason <text>]");

  const store = new SessionStore();
  try {
    const session = restoreSession(store, id, ACTOR, flagString(args.flags, "reason") ?? null);
    console.log(`Restored ${session.id} to lifecycle ${session.lifecycle}.`);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    store.close();
  }
}

async function cmdAudit(args: ParsedArgs): Promise<void> {
  const store = new SessionStore();
  try {
    const entries = store.listAudit(args.positional[0]);
    if (args.flags.get("json")) {
      printJson(entries);
      return;
    }
    if (entries.length === 0) {
      console.log("No audit entries.");
      return;
    }
    for (const entry of entries) {
      console.log(`${entry.at}  ${entry.action.padEnd(8)} ${entry.sessionId}  ${entry.previousLifecycle ?? "-"} -> ${entry.newLifecycle ?? "-"}  (${entry.actor})`);
    }
  } finally {
    store.close();
  }
}

/**
 * Automates the manual "clone the repo, `paseo plugin install /path/to/it`" flow: downloads the
 * version-matched Paseo plugin bundle from this CLI's own GitHub Release, extracts it to a stable local
 * directory, and installs it via the real `paseo plugin install`. Never touches the daemon's
 * `pluginsEnabled` switch itself — plugins are trusted, unsandboxed code, so enabling that is left to the
 * user, in the Paseo app.
 */
async function cmdWirePaseo(args: ParsedArgs): Promise<void> {
  if (!(await isPaseoCliAvailable())) {
    console.error("The `paseo` CLI was not found on PATH. Install Paseo first, then re-run this command.");
    process.exitCode = 1;
    return;
  }
  console.log("paseo CLI found.");

  if (!(await arePluginsEnabled())) {
    console.error(
      "\nPlugins are disabled on this Paseo daemon. Plugins are trusted, unsandboxed code — backend " +
        "plugin code can access your daemon machine, including files, processes, credentials, and " +
        "network services. Client plugin code runs inside the Paseo app.\n\n" +
        "Enable plugins yourself first (Settings → Plugins → Enable plugins in the Paseo app), " +
        "then re-run this command.",
    );
    process.exitCode = 1;
    return;
  }
  console.log("Plugins are enabled on this daemon.");

  const versionFlag = flagString(args.flags, "version");
  const version = versionFlag ?? getVersion();
  if (version === DEV_VERSION && !versionFlag) {
    console.error(
      `\nThis is a development build (version: ${DEV_VERSION}), not a tagged release — there's no ` +
        "matching Paseo plugin asset to download.\nPass --version <tag> (e.g. --version 0.2.0) to install " +
        "a specific release's plugin, or use a released sessionforge binary instead.",
    );
    process.exitCode = 1;
    return;
  }

  const archivePath = join(tmpdir(), PLUGIN_ARCHIVE_NAME);
  console.log(`Downloading the v${version} Paseo plugin release asset...`);
  await downloadPluginArchive(version, archivePath);

  const installDir = pluginInstallDir();
  console.log(`Extracting to ${installDir}...`);
  await extractPluginArchive(archivePath, installDir);

  const id = flagString(args.flags, "id") ?? DEFAULT_PLUGIN_ID;
  console.log("Installing via `paseo plugin install`...");
  const result = await installPluginDirectory(installDir, id);

  if (result.status !== "running") {
    console.error(`\nPlugin installed but is not running (status: ${result.status}).`);
    if (result.error) console.error(result.error);
    console.error(`Check \`paseo plugin logs ${id}\` for details.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nSessionForge is wired into Paseo (plugin id: ${id}, status: running).`);
}

async function cmdPaseoStatus(): Promise<void> {
  const status = await getPluginStatus(DEFAULT_PLUGIN_ID);
  if (!status) {
    console.log(`Not installed. Run \`sessionforge wire-paseo\` to install it.`);
    return;
  }
  console.log(`${status.id}: ${status.status}${status.enabled ? "" : " (disabled)"} — ${status.path}`);
  if (status.error) console.log(`Error: ${status.error}`);
}

function printHelp(): void {
  console.log(`sessionforge — unified agent session inventory (SessionForge)

Usage:
  sessionforge discover                      scan agent-owned storage and refresh the local index
  sessionforge list [flags]                  list sessions (--agent --project --status --lifecycle --category --older-than 30d --query --scan --json)
  sessionforge show <id> [--json]            show one session in detail
  sessionforge search <query> [--json]       full-text search across title/summary/project
  sessionforge cleanup [--apply] [--json]    preview (default) or apply junk cleanup; nothing is deleted, only trashed
  sessionforge archive <id> [--reason ...]   move a session out of the active view
  sessionforge restore <id> [--reason ...]   bring an archived/trashed session back
  sessionforge audit [id] [--json]           show the audit trail for destructive operations
  sessionforge wire-paseo [--version ...]    download and install the Paseo plugin for this CLI's version
  sessionforge paseo-status                  show whether the Paseo plugin is installed and running
  sessionforge --version                     print this CLI's own version
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional.shift();

  // parseArgs treats any "--xxx" token as a flag regardless of position, so `sessionforge --version` never
  // reaches the switch below as a positional "--version" — it lands here instead, with command undefined.
  if (command === undefined && args.flags.get("version")) {
    console.log(getVersion());
    return;
  }

  switch (command) {
    case "discover":
      return cmdDiscover();
    case "list":
      return cmdList(args);
    case "show":
      return cmdShow(args);
    case "search":
      return cmdSearch(args);
    case "cleanup":
      return cmdCleanup(args);
    case "archive":
      return cmdArchive(args);
    case "restore":
      return cmdRestore(args);
    case "audit":
      return cmdAudit(args);
    case "wire-paseo":
      return cmdWirePaseo(args);
    case "paseo-status":
      return cmdPaseoStatus();
    case "version":
    case "-v":
      console.log(getVersion());
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return printHelp();
    default:
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

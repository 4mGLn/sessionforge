import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { ActivityConfidence, SessionActivity, SessionStatus } from "./types.server.js";

const execFileAsync = promisify(execFile);

const RECENT_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

let liveClaudeCwdsCache: { at: number; cwds: Set<string> } | null = null;
const PROCESS_SCAN_CACHE_MS = 5000;

/** Linux: /proc gives an exact, instant cmdline + cwd per pid — no subprocess spawn needed. */
async function liveClaudeCwdsLinux(): Promise<Set<string>> {
  const cwds = new Set<string>();
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return cwds;
  }

  await Promise.all(
    pids.map(async (pid) => {
      try {
        const cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
        if (!/\bclaude\b/.test(cmdline)) return;
        const cwd = await readlink(`/proc/${pid}/cwd`);
        cwds.add(cwd);
      } catch {
        // process exited mid-scan, or unreadable (permissions) — ignore
      }
    }),
  );

  return cwds;
}

/**
 * macOS has no /proc. `ps -axww -o pid=,command=` (the `ww` disables ps's own line-truncation, which
 * would otherwise cut off long command lines) finds candidate pids, then a single `lsof -d cwd` call for
 * all of them at once reads each one's working directory — same information /proc gives on Linux, just
 * via two subprocess calls instead of a filesystem read. Both `ps` and `lsof` ship with every macOS
 * install, on Apple Silicon and Intel alike (this is a CPU-architecture-independent OS convention).
 */
async function liveClaudeCwdsMac(): Promise<Set<string>> {
  const cwds = new Set<string>();

  let psOutput: string;
  try {
    psOutput = (await execFileAsync("ps", ["-axww", "-o", "pid=,command="])).stdout;
  } catch {
    return cwds;
  }

  const matchingPids: string[] = [];
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    const spaceIndex = trimmed.indexOf(" ");
    if (spaceIndex === -1) continue;
    const pid = trimmed.slice(0, spaceIndex);
    const command = trimmed.slice(spaceIndex + 1);
    if (/\bclaude\b/.test(command)) matchingPids.push(pid);
  }
  if (matchingPids.length === 0) return cwds;

  try {
    const lsofOutput = (await execFileAsync("lsof", ["-a", "-d", "cwd", "-p", matchingPids.join(","), "-Fn"])).stdout;
    for (const line of lsofOutput.split("\n")) {
      if (line.startsWith("n")) cwds.add(line.slice(1));
    }
  } catch {
    // lsof can partially fail (e.g. permission denied for another user's process) — a partial result
    // from the pids it could read is still useful, so this isn't treated as a hard failure.
  }

  return cwds;
}

/**
 * Scans for running `claude` processes and returns their working directories, so a session can be
 * reported ACTIVE with real evidence instead of only a recent-timestamp guess (GOAL.md §5: "Do not claim
 * a session is active when only file modification time suggests activity").
 *
 * Linux and macOS both get this signal. Windows has no equivalent without a native addon — there's no
 * standard API or WMI class exposing a process's current working directory the way /proc or lsof do — so
 * it returns an empty set and every session falls through to the timestamp-only heuristic below
 * (RECENT/IDLE/STALE at MEDIUM confidence). That's a real fidelity gap on Windows, not silently papered
 * over: it's why this function never fabricates ACTIVE/HIGH there.
 */
async function liveClaudeCwds(): Promise<Set<string>> {
  if (liveClaudeCwdsCache && Date.now() - liveClaudeCwdsCache.at < PROCESS_SCAN_CACHE_MS) {
    return liveClaudeCwdsCache.cwds;
  }

  let cwds: Set<string>;
  if (process.platform === "linux") cwds = await liveClaudeCwdsLinux();
  else if (process.platform === "darwin") cwds = await liveClaudeCwdsMac();
  else cwds = new Set();

  liveClaudeCwdsCache = { at: Date.now(), cwds };
  return cwds;
}

export interface ActivityInput {
  workspace: string;
  lastActivityAt: string;
}

export async function detectActivity(input: ActivityInput): Promise<SessionActivity> {
  const lastActivity = Date.parse(input.lastActivityAt);
  if (Number.isNaN(lastActivity)) {
    return { status: "UNKNOWN", confidence: "LOW", signals: ["unparseable last-activity timestamp"] };
  }

  const ageMs = Date.now() - lastActivity;
  const liveCwds = await liveClaudeCwds();
  const hasLiveProcess = liveCwds.has(input.workspace);

  const signals: string[] = [];
  let status: SessionStatus;
  let confidence: ActivityConfidence;

  if (hasLiveProcess) {
    signals.push("matching claude process running with this workspace as cwd");
    status = "ACTIVE";
    confidence = ageMs <= RECENT_THRESHOLD_MS ? "HIGH" : "MEDIUM";
  } else if (ageMs <= RECENT_THRESHOLD_MS) {
    signals.push(`last activity ${Math.round(ageMs / 1000)}s ago, no matching live process found`);
    status = "RECENT";
    confidence = "MEDIUM";
  } else if (ageMs <= IDLE_THRESHOLD_MS) {
    signals.push(`last activity ${Math.round(ageMs / 3_600_000)}h ago`);
    status = "IDLE";
    confidence = "MEDIUM";
  } else {
    signals.push(`last activity ${Math.round(ageMs / 86_400_000)}d ago`);
    status = "STALE";
    confidence = "MEDIUM";
  }

  return { status, confidence, signals };
}

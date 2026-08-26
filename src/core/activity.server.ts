import { readdir, readFile, readlink } from "node:fs/promises";
import type { ActivityConfidence, SessionActivity, SessionStatus } from "./types.server.js";

const RECENT_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

let liveClaudeCwdsCache: { at: number; cwds: Set<string> } | null = null;
const PROCESS_SCAN_CACHE_MS = 5000;

/** Scans /proc for running `claude` processes and returns their working directories. Linux-only; empty set elsewhere or on failure. */
async function liveClaudeCwds(): Promise<Set<string>> {
  if (liveClaudeCwdsCache && Date.now() - liveClaudeCwdsCache.at < PROCESS_SCAN_CACHE_MS) {
    return liveClaudeCwdsCache.cwds;
  }

  const cwds = new Set<string>();
  if (process.platform !== "linux") {
    liveClaudeCwdsCache = { at: Date.now(), cwds };
    return cwds;
  }

  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  } catch {
    liveClaudeCwdsCache = { at: Date.now(), cwds };
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

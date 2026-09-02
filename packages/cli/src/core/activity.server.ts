import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { ActivityConfidence, AgentId, SessionActivity, SessionStatus } from "./types.server.js";

const execFileAsync = promisify(execFile);

const RECENT_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Binary name each agent's own CLI process shows up as in `ps`/`/proc` cmdline output — verified against
 * real installs on this machine for claude/codex/gemini-cli/opencode. aider's `aider` console-script name
 * is the well-documented pip package entry point but wasn't available to verify the same way (not
 * installed here). "custom" has no knowable binary name, so it's intentionally absent — it never gets
 * live-process detection, only the timestamp fallback below.
 */
const AGENT_PROCESS_PATTERNS: Partial<Record<AgentId, RegExp>> = {
  "claude-code": /\bclaude\b/,
  codex: /\bcodex\b/,
  "gemini-cli": /\bgemini\b/,
  opencode: /\bopencode\b/,
  aider: /\baider\b/,
};

function matchAgent(cmdline: string): AgentId | null {
  for (const [agent, pattern] of Object.entries(AGENT_PROCESS_PATTERNS) as [AgentId, RegExp][]) {
    if (pattern.test(cmdline)) return agent;
  }
  return null;
}

function addCwd(map: Map<AgentId, Set<string>>, agent: AgentId, cwd: string): void {
  let set = map.get(agent);
  if (!set) {
    set = new Set();
    map.set(agent, set);
  }
  set.add(cwd);
}

let liveAgentCwdsCache: { at: number; cwds: Map<AgentId, Set<string>> } | null = null;
const PROCESS_SCAN_CACHE_MS = 5000;

/** Linux: /proc gives an exact, instant cmdline + cwd per pid — no subprocess spawn needed. One scan
 * covers every agent at once, each pid bucketed by whichever pattern matched its cmdline. */
async function liveAgentCwdsLinux(): Promise<Map<AgentId, Set<string>>> {
  const result = new Map<AgentId, Set<string>>();
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry));
  } catch {
    return result;
  }

  await Promise.all(
    pids.map(async (pid) => {
      try {
        const cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
        const agent = matchAgent(cmdline);
        if (!agent) return;
        const cwd = await readlink(`/proc/${pid}/cwd`);
        addCwd(result, agent, cwd);
      } catch {
        // process exited mid-scan, or unreadable (permissions) — ignore
      }
    }),
  );

  return result;
}

/**
 * macOS has no /proc. `ps -axww -o pid=,command=` (the `ww` disables ps's own line-truncation, which
 * would otherwise cut off long command lines) finds candidate pids per agent, then one `lsof -d cwd` call
 * per matched agent reads that agent's pids' working directories — same information /proc gives on Linux,
 * just via subprocess calls instead of a filesystem read. Separate calls per agent (rather than one call
 * for every pid, disambiguated by lsof's own per-process "p<pid>" lines) keeps the proven single-agent
 * parsing logic unchanged instead of adding new, harder-to-verify multi-pid output parsing. Both `ps` and
 * `lsof` ship with every macOS install, on Apple Silicon and Intel alike.
 */
async function liveAgentCwdsMac(): Promise<Map<AgentId, Set<string>>> {
  const result = new Map<AgentId, Set<string>>();

  let psOutput: string;
  try {
    psOutput = (await execFileAsync("ps", ["-axww", "-o", "pid=,command="])).stdout;
  } catch {
    return result;
  }

  const pidsByAgent = new Map<AgentId, string[]>();
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    const spaceIndex = trimmed.indexOf(" ");
    if (spaceIndex === -1) continue;
    const pid = trimmed.slice(0, spaceIndex);
    const command = trimmed.slice(spaceIndex + 1);
    const agent = matchAgent(command);
    if (!agent) continue;
    const pids = pidsByAgent.get(agent);
    if (pids) pids.push(pid);
    else pidsByAgent.set(agent, [pid]);
  }

  await Promise.all(
    [...pidsByAgent.entries()].map(async ([agent, pids]) => {
      try {
        const lsofOutput = (await execFileAsync("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fn"])).stdout;
        for (const line of lsofOutput.split("\n")) {
          if (line.startsWith("n")) addCwd(result, agent, line.slice(1));
        }
      } catch {
        // lsof can partially fail (e.g. permission denied for another user's process) — a partial result
        // from the pids it could read is still useful, so this isn't treated as a hard failure. Failing
        // for one agent's pids doesn't affect the others, since each runs its own independent call.
      }
    }),
  );

  return result;
}

/**
 * Scans for running agent CLI processes and returns their working directories per agent, so a session can
 * be reported ACTIVE with real evidence instead of only a recent-timestamp guess (GOAL.md §5: "Do not
 * claim a session is active when only file modification time suggests activity").
 *
 * Linux and macOS both get this signal, for every agent with a known binary name (see
 * AGENT_PROCESS_PATTERNS). Windows has no equivalent without a native addon — there's no standard API or
 * WMI class exposing a process's current working directory the way /proc or lsof do — so it returns an
 * empty map and every session falls through to the timestamp-only heuristic below (RECENT/IDLE/STALE at
 * MEDIUM confidence). That's a real fidelity gap on Windows, not silently papered over: it's why this
 * function never fabricates ACTIVE/HIGH there.
 */
async function liveAgentCwds(): Promise<Map<AgentId, Set<string>>> {
  if (liveAgentCwdsCache && Date.now() - liveAgentCwdsCache.at < PROCESS_SCAN_CACHE_MS) {
    return liveAgentCwdsCache.cwds;
  }

  let cwds: Map<AgentId, Set<string>>;
  if (process.platform === "linux") cwds = await liveAgentCwdsLinux();
  else if (process.platform === "darwin") cwds = await liveAgentCwdsMac();
  else cwds = new Map();

  liveAgentCwdsCache = { at: Date.now(), cwds };
  return cwds;
}

export interface ActivityInput {
  agentId: AgentId;
  workspace: string;
  lastActivityAt: string;
}

export async function detectActivity(input: ActivityInput): Promise<SessionActivity> {
  const lastActivity = Date.parse(input.lastActivityAt);
  if (Number.isNaN(lastActivity)) {
    return { status: "UNKNOWN", confidence: "LOW", signals: ["unparseable last-activity timestamp"] };
  }

  const ageMs = Date.now() - lastActivity;
  const liveCwds = await liveAgentCwds();
  const hasLiveProcess = (liveCwds.get(input.agentId) ?? new Set()).has(input.workspace);

  const signals: string[] = [];
  let status: SessionStatus;
  let confidence: ActivityConfidence;

  if (hasLiveProcess) {
    signals.push(`matching ${input.agentId} process running with this workspace as cwd`);
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

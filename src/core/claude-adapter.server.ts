import { homedir } from "node:os";
import { join, basename } from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { AgentAdapter, DiscoveredSession } from "./types.server.js";
import { parseClaudeTranscript } from "./claude-transcript.server.js";

function claudeProjectsRoot(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(configDir, "projects");
}

function projectNameFromCwd(cwd: string | null, fallbackDirName: string): string {
  if (!cwd) return fallbackDirName;
  const name = basename(cwd);
  return name.length > 0 ? name : cwd;
}

async function listSessionFiles(projectsRoot: string): Promise<string[]> {
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsRoot);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const dirName of projectDirs) {
    const dirPath = join(projectsRoot, dirName);
    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) files.push(join(dirPath, entry));
    }
  }
  return files;
}

/** Reference adapter implementation. Read-only: only reads `~/.claude/projects/**​/*.jsonl`, never writes agent-owned files. */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly agent = "claude-code" as const;

  async discover(): Promise<DiscoveredSession[]> {
    const projectsRoot = claudeProjectsRoot();
    const files = await listSessionFiles(projectsRoot);
    const sessions: DiscoveredSession[] = [];

    for (const filePath of files) {
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }

      let transcript;
      try {
        transcript = await parseClaudeTranscript(filePath);
      } catch {
        continue;
      }

      const nativeSessionId = transcript.sessionId ?? basename(filePath, ".jsonl");
      const fallbackDirName = basename(join(filePath, ".."));

      sessions.push({
        agent: "claude-code",
        provider: "claude-code",
        nativeSessionId,
        project: projectNameFromCwd(transcript.cwd, fallbackDirName),
        workspace: transcript.cwd ?? fallbackDirName,
        repository: null,
        branch: transcript.gitBranch,
        createdAt: transcript.createdAt ?? fileStat.birthtime.toISOString(),
        lastActivityAt: transcript.lastActivityAt ?? fileStat.mtime.toISOString(),
        title: transcript.title,
        firstUserMessage: transcript.firstUserMessage,
        messageCount: transcript.messageCount,
        userMessageCount: transcript.userMessageCount,
        assistantMessageCount: transcript.assistantMessageCount,
        storagePath: filePath,
        sizeBytes: fileStat.size,
        metadata: {
          version: transcript.version,
          malformedLineCount: transcript.malformedLineCount,
        },
      });
    }

    return sessions;
  }
}

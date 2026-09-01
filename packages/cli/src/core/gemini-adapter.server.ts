import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { AgentAdapter, DiscoveredSession } from "./types.server.js";
import { capFirstMessage } from "./text-utils.server.js";
import { moveToTrash } from "./trash.server.js";

interface GeminiMessage {
  type?: string;
  content?: string;
  timestamp?: string;
}

interface GeminiSessionFile {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  lastUpdated?: string;
  messages?: GeminiMessage[];
}

function geminiHomeDir(): string {
  return process.env.GEMINI_CONFIG_DIR ?? join(homedir(), ".gemini");
}

function truncateTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

/** Resolves `~/.gemini/tmp/<dirName>` back to the real project path Gemini CLI hashed it from. */
class ProjectResolver {
  private readonly hashToPath = new Map<string, string>();
  private loaded = false;

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const projectsJsonPath = join(geminiHomeDir(), "projects.json");
    if (!existsSync(projectsJsonPath)) return;
    try {
      const raw = JSON.parse(await readFile(projectsJsonPath, "utf8")) as { projects?: Record<string, string> };
      for (const path of Object.keys(raw.projects ?? {})) {
        this.hashToPath.set(createHash("sha256").update(path).digest("hex"), path);
      }
    } catch {
      // malformed projects.json — fall back to per-directory resolution only
    }
  }

  async resolve(tmpDirName: string, tmpDirPath: string): Promise<string> {
    const projectRootFile = join(tmpDirPath, ".project_root");
    if (existsSync(projectRootFile)) {
      try {
        const content = (await readFile(projectRootFile, "utf8")).trim();
        if (content) return content;
      } catch {
        // fall through to hash resolution
      }
    }

    await this.ensureLoaded();
    return this.hashToPath.get(tmpDirName) ?? tmpDirName;
  }
}

async function listSessionFiles(tmpRoot: string): Promise<string[]> {
  let dirNames: string[];
  try {
    dirNames = await readdir(tmpRoot);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const dirName of dirNames) {
    const chatsDir = join(tmpRoot, dirName, "chats");
    let entries: string[];
    try {
      entries = await readdir(chatsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".json")) files.push(join(chatsDir, entry));
    }
  }
  return files;
}

/**
 * Reads Gemini CLI's own `~/.gemini/tmp/<project>/chats/*.json` session files. discover() is read-only;
 * delete() is the one explicit, user-confirmed exception — it moves a single session file to the
 * system trash (never a hard unlink; see trash.server.ts).
 */
export class GeminiCliAdapter implements AgentAdapter {
  readonly agent = "gemini-cli" as const;

  async delete(storagePath: string): Promise<void> {
    await moveToTrash(storagePath);
  }

  async discover(): Promise<DiscoveredSession[]> {
    const tmpRoot = join(geminiHomeDir(), "tmp");
    const files = await listSessionFiles(tmpRoot);
    const resolver = new ProjectResolver();
    const sessions: DiscoveredSession[] = [];

    for (const filePath of files) {
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }

      let parsed: GeminiSessionFile;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8")) as GeminiSessionFile;
      } catch {
        continue;
      }

      const messages = parsed.messages ?? [];
      const userMessages = messages.filter((m) => m.type === "user");
      const assistantMessages = messages.filter((m) => m.type === "gemini");
      const rawFirstUserMessage = userMessages.find((m) => typeof m.content === "string" && m.content.trim().length > 0)?.content ?? null;
      const firstUserMessage = rawFirstUserMessage ? capFirstMessage(rawFirstUserMessage) : null;

      const tmpDirName = basename(join(filePath, "..", ".."));
      const tmpDirPath = join(filePath, "..", "..");
      const workspace = await resolver.resolve(tmpDirName, tmpDirPath);

      sessions.push({
        agent: "gemini-cli",
        provider: "gemini-cli",
        nativeSessionId: parsed.sessionId ?? basename(filePath, ".json"),
        project: basename(workspace) || workspace,
        workspace,
        repository: null,
        branch: null,
        createdAt: parsed.startTime ?? fileStat.birthtime.toISOString(),
        lastActivityAt: parsed.lastUpdated ?? fileStat.mtime.toISOString(),
        title: firstUserMessage ? truncateTitle(firstUserMessage) : null,
        firstUserMessage,
        messageCount: userMessages.length + assistantMessages.length,
        userMessageCount: userMessages.length,
        assistantMessageCount: assistantMessages.length,
        storagePath: filePath,
        sizeBytes: fileStat.size,
        metadata: {},
      });
    }

    return sessions;
  }
}

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentAdapter, DiscoveredSession } from "./types.server.js";
import { capFirstMessage } from "./text-utils.server.js";

const HISTORY_FILE_NAME = ".aider.chat.history.md";
const MAX_SEARCH_DEPTH = 6;
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "__pycache__", "dist", "build"]);

const SESSION_START_PATTERN = /^# aider chat started at (.+)$/;
const USER_TURN_PATTERN = /^#### (.*)$/;

/**
 * Aider has no central session directory the way Claude Code/Codex/Gemini CLI/OpenCode do — it appends to
 * a `.aider.chat.history.md` file (plus `.aider.input.history`, not used here) directly in whatever
 * project directory it was launched from, and there's nothing in Aider's own global state
 * (`~/.aider/analytics.json`, `installs.json`) that tracks which directories that is. So this adapter
 * can't just read one well-known path; it has to search, and searching the whole home directory by
 * default would be slow and surprising for the (likely large) majority of users who don't use Aider at
 * all. Instead it only searches directories explicitly listed in AIDER_SEARCH_ROOTS (colon-separated,
 * like PATH) — nothing is scanned unless the user opts in.
 */
function searchRoots(): string[] {
  const raw = process.env.AIDER_SEARCH_ROOTS;
  if (!raw) return [];
  return raw
    .split(":")
    .map((p) => p.trim())
    .filter(Boolean);
}

async function findHistoryFiles(root: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_SEARCH_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name === HISTORY_FILE_NAME) {
        found.push(join(dir, entry.name));
        continue;
      }
      // Skip hidden directories (caches like .aider.tags.cache.v4, .git, etc.) and known-heavy ones —
      // keeps a real search bounded instead of crawling every dependency tree under the search root.
      if (entry.isDirectory() && !entry.name.startsWith(".") && !EXCLUDED_DIR_NAMES.has(entry.name)) {
        await walk(join(dir, entry.name), depth + 1);
      }
    }
  }

  await walk(root, 0);
  return found;
}

function collapseWhitespace(text: string): string | null {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed || null;
}

function truncateTitle(text: string): string | null {
  const collapsed = collapseWhitespace(text);
  if (!collapsed) return null;
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}...` : collapsed;
}

/** Stable across rescans (unlike a random id) so the same launch isn't re-discovered as a "new" session every time. */
function deriveSessionId(filePath: string, startedAtRaw: string): string {
  return createHash("sha1").update(`${filePath}:${startedAtRaw}`).digest("hex").slice(0, 16);
}

interface ParsedBlock {
  startedAtRaw: string;
  text: string;
}

function splitIntoBlocks(content: string): ParsedBlock[] {
  const lines = content.split("\n");
  const blocks: ParsedBlock[] = [];
  let currentStart: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(SESSION_START_PATTERN);
    if (match) {
      if (currentStart !== null) blocks.push({ startedAtRaw: currentStart, text: currentLines.join("\n") });
      currentStart = match[1].trim();
      currentLines = [];
      continue;
    }
    if (currentStart !== null) currentLines.push(line);
  }
  if (currentStart !== null) blocks.push({ startedAtRaw: currentStart, text: currentLines.join("\n") });

  return blocks;
}

interface BlockStats {
  userMessageCount: number;
  assistantMessageCount: number;
  firstUserMessage: string | null;
}

/**
 * Heuristic, not exact: a user turn is any `#### ` line; an assistant turn is counted whenever a user
 * turn is followed by at least one line of real content that isn't blank, isn't a `#### ` line, and isn't
 * one of Aider's own `>`-prefixed tool/system/error lines (warnings, tracebacks, "Tokens: ... sent").
 * Good enough to distinguish "got a real reply" from "no reply" without needing a full markdown parser.
 */
function analyzeBlock(text: string): BlockStats {
  let userMessageCount = 0;
  let assistantMessageCount = 0;
  let firstUserMessage: string | null = null;
  let pendingAssistantContent = false;

  for (const line of text.split("\n")) {
    const userMatch = line.match(USER_TURN_PATTERN);
    if (userMatch) {
      if (pendingAssistantContent) {
        assistantMessageCount += 1;
        pendingAssistantContent = false;
      }
      userMessageCount += 1;
      const utterance = collapseWhitespace(userMatch[1]);
      if (firstUserMessage === null && utterance && !utterance.startsWith("/")) firstUserMessage = utterance;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith(">") && !trimmed.startsWith("#")) pendingAssistantContent = true;
  }
  if (pendingAssistantContent) assistantMessageCount += 1;

  return { userMessageCount, assistantMessageCount, firstUserMessage };
}

/** "2025-09-02 17:03:43" (no timezone) — parsed as local time, matching wall-clock time on the machine that ran aider. */
function parseAiderTimestamp(raw: string): Date | null {
  const date = new Date(raw.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

export class AiderAdapter implements AgentAdapter {
  readonly agent = "aider" as const;

  async discover(): Promise<DiscoveredSession[]> {
    const roots = searchRoots();
    if (roots.length === 0) return [];

    const filesPerRoot = await Promise.all(roots.map((root) => findHistoryFiles(root)));
    const files = Array.from(new Set(filesPerRoot.flat()));

    const sessions: DiscoveredSession[] = [];
    for (const filePath of files) {
      let content: string;
      let fileStat;
      try {
        [content, fileStat] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
      } catch {
        continue;
      }

      const workspace = dirname(filePath);
      const project = basename(workspace) || workspace;
      const blocks = splitIntoBlocks(content);

      blocks.forEach((block, index) => {
        const startedAt = parseAiderTimestamp(block.startedAtRaw);
        if (!startedAt) return;

        const stats = analyzeBlock(block.text);
        // The file's own mtime is only a trustworthy "last activity" proxy for the most recent session in
        // it — for earlier ones it would reflect a later session's edits, not this one's. Falling back to
        // the block's own start time is an honest under-estimate rather than borrowing a misleading value.
        const isLastBlock = index === blocks.length - 1;
        const lastActivityAt = isLastBlock ? fileStat.mtime : startedAt;

        sessions.push({
          agent: "aider",
          provider: "aider",
          nativeSessionId: deriveSessionId(filePath, block.startedAtRaw),
          project,
          workspace,
          repository: null,
          branch: null,
          createdAt: startedAt.toISOString(),
          lastActivityAt: lastActivityAt.toISOString(),
          title: stats.firstUserMessage ? truncateTitle(stats.firstUserMessage) : null,
          firstUserMessage: stats.firstUserMessage ? capFirstMessage(stats.firstUserMessage) : null,
          messageCount: stats.userMessageCount + stats.assistantMessageCount,
          userMessageCount: stats.userMessageCount,
          assistantMessageCount: stats.assistantMessageCount,
          storagePath: filePath,
          sizeBytes: Buffer.byteLength(block.text, "utf8"),
          metadata: {},
        });
      });
    }

    return sessions;
  }
}

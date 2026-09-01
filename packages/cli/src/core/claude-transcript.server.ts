import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { capFirstMessage } from "./text-utils.server.js";

interface ContentBlock {
  type?: string;
  text?: string;
}

interface TranscriptMessage {
  role?: string;
  content?: string | ContentBlock[];
}

interface TranscriptRecord {
  type?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: TranscriptMessage;
  aiTitle?: string;
}

export interface ParsedTranscript {
  sessionId: string | null;
  cwd: string | null;
  gitBranch: string | null;
  version: string | null;
  createdAt: string | null;
  lastActivityAt: string | null;
  title: string | null;
  firstUserMessage: string | null;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  malformedLineCount: number;
}

function extractText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string" && block.text.trim().length > 0)
      .map((block) => block.text as string)
      .join("\n");
  }
  return "";
}

function isGenuineUserTurn(record: TranscriptRecord): boolean {
  if (record.type !== "user" || record.isSidechain) return false;
  const content = record.message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) return content.some((block) => block?.type === "text" && (block.text ?? "").trim().length > 0);
  return false;
}

function isAssistantTurn(record: TranscriptRecord): boolean {
  return record.type === "assistant" && !record.isSidechain;
}

/** Streams a Claude Code session JSONL transcript and extracts SessionForge's session-model fields. Tolerates malformed lines. */
export async function parseClaudeTranscript(filePath: string): Promise<ParsedTranscript> {
  const result: ParsedTranscript = {
    sessionId: null,
    cwd: null,
    gitBranch: null,
    version: null,
    createdAt: null,
    lastActivityAt: null,
    title: null,
    firstUserMessage: null,
    messageCount: 0,
    userMessageCount: 0,
    assistantMessageCount: 0,
    malformedLineCount: 0,
  };

  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let record: TranscriptRecord;
    try {
      record = JSON.parse(line) as TranscriptRecord;
    } catch {
      result.malformedLineCount += 1;
      continue;
    }

    if (!result.sessionId && record.sessionId) result.sessionId = record.sessionId;
    if (!result.cwd && record.cwd) result.cwd = record.cwd;
    if (!result.gitBranch && record.gitBranch && record.gitBranch !== "HEAD") result.gitBranch = record.gitBranch;
    if (!result.version && record.version) result.version = record.version;

    if (record.timestamp) {
      if (!result.createdAt) result.createdAt = record.timestamp;
      result.lastActivityAt = record.timestamp;
    }

    if (record.type === "ai-title" && typeof record.aiTitle === "string") {
      result.title = record.aiTitle;
    }

    if (isGenuineUserTurn(record)) {
      result.messageCount += 1;
      result.userMessageCount += 1;
      if (!result.firstUserMessage) {
        const text = extractText(record.message?.content);
        if (text) result.firstUserMessage = capFirstMessage(text);
      }
    } else if (isAssistantTurn(record)) {
      result.messageCount += 1;
      result.assistantMessageCount += 1;
    }
  }

  if (!result.title && result.firstUserMessage) {
    const trimmed = result.firstUserMessage.trim().replace(/\s+/g, " ");
    result.title = trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
  }

  return result;
}

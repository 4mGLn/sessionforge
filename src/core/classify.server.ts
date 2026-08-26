import type { SessionClassification, SessionStatus } from "./types.server.js";

const ARCHIVE_AGE_DAYS = 14;
const TEST_PROMPT_PATTERN = /^(hi|hello|hey|yo|test|testing|ping|asdf|hmm+|ok|okay)[.!?]?$/i;

function isLikelyTestPrompt(text: string | null): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return trimmed.length <= 15 || TEST_PROMPT_PATTERN.test(trimmed);
}

export interface ClassifyInput {
  status: SessionStatus;
  lastActivityAt: string;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  firstUserMessage: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Local heuristic classifier (GOALD §6/§7). No network calls, no LLM — MVP scope is KEEP/ARCHIVE/JUNK only. */
export function classifySession(input: ClassifyInput): SessionClassification {
  const classifiedAt = nowIso();

  if (input.assistantMessageCount === 0) {
    return {
      category: "JUNK",
      confidence: 0.95,
      reason: "No assistant response — likely an aborted or accidental launch",
      evidence: [`${input.userMessageCount} user message(s)`, "no assistant response"],
      classifiedAt,
    };
  }

  if (input.messageCount <= 1) {
    return {
      category: "JUNK",
      confidence: 0.9,
      reason: "Single-message session with no follow-up",
      evidence: [`${input.messageCount} total message(s)`],
      classifiedAt,
    };
  }

  if (input.userMessageCount <= 1 && isLikelyTestPrompt(input.firstUserMessage)) {
    return {
      category: "JUNK",
      confidence: 0.85,
      reason: "Looks like a test or accidental prompt",
      evidence: [`first message: "${input.firstUserMessage}"`, `${input.messageCount} total messages`],
      classifiedAt,
    };
  }

  const ageMs = Date.now() - Date.parse(input.lastActivityAt);
  const ageDays = Number.isNaN(ageMs) ? 0 : ageMs / 86_400_000;

  if (input.status === "STALE" && ageDays > ARCHIVE_AGE_DAYS) {
    const confidence = Math.min(0.95, 0.5 + ageDays / 60);
    return {
      category: "ARCHIVE",
      confidence,
      reason: `Inactive for ${Math.round(ageDays)} days, likely completed`,
      evidence: [`${input.messageCount} messages`, `last activity ${Math.round(ageDays)}d ago`],
      classifiedAt,
    };
  }

  if (input.status === "ACTIVE" || input.status === "RECENT") {
    return {
      category: "KEEP",
      confidence: 0.9,
      reason: "Recently active",
      evidence: [`status ${input.status}`, `${input.messageCount} messages`],
      classifiedAt,
    };
  }

  return {
    category: "KEEP",
    confidence: 0.55,
    reason: "No junk or archive signals found; assumed still relevant",
    evidence: [`${input.messageCount} messages`, `status ${input.status}`],
    classifiedAt,
  };
}

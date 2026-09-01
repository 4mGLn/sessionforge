import type { SessionClassification } from "./types.server.js";

const MAX_TOPIC_LENGTH = 100;

function collapseAndTruncate(text: string, maxLength: number): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 3)}...` : collapsed;
}

export interface SummarizeInput {
  title: string | null;
  firstUserMessage: string | null;
  userMessageCount: number;
  classification: SessionClassification;
}

/**
 * Local, heuristic "concise summary" (GOAL.md §6/§22) — no LLM call, no network access, consistent with
 * §20's "prefer local processing" and "do not upload full conversations to external services by default".
 * Pairs the session's topic (title, falling back to the first user message) with the classifier's own
 * outcome signal, since that's the cheapest genuinely-informative addition beyond what's already visible
 * as the row title elsewhere in the UI/CLI.
 */
export function summarizeSession(input: SummarizeInput): string | null {
  const topic = input.title ?? input.firstUserMessage;
  if (!topic) return null;

  const truncatedTopic = collapseAndTruncate(topic, MAX_TOPIC_LENGTH);

  if (input.classification.category === "JUNK") {
    return `${truncatedTopic} — ${input.classification.reason}`;
  }

  const exchanges = input.userMessageCount === 1 ? "1 exchange" : `${input.userMessageCount} exchanges`;
  return `${truncatedTopic} (${exchanges})`;
}

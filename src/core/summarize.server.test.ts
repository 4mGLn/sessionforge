import { describe, expect, it } from "vitest";
import { summarizeSession } from "./summarize.server.js";
import type { SessionClassification } from "./types.server.js";

function classification(overrides: Partial<SessionClassification> = {}): SessionClassification {
  return {
    category: "KEEP",
    confidence: 0.9,
    reason: "Recently active",
    evidence: [],
    classifiedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("summarizeSession", () => {
  it("returns null when there is no title or first message to summarize", () => {
    expect(summarizeSession({ title: null, firstUserMessage: null, userMessageCount: 0, classification: classification() })).toBeNull();
  });

  it("prefers the title over the first user message as the topic", () => {
    const result = summarizeSession({
      title: "Fix PostgreSQL VACUUM issue",
      firstUserMessage: "something else entirely",
      userMessageCount: 3,
      classification: classification(),
    });
    expect(result).toContain("Fix PostgreSQL VACUUM issue");
    expect(result).not.toContain("something else entirely");
  });

  it("falls back to the first user message when there is no title", () => {
    const result = summarizeSession({
      title: null,
      firstUserMessage: "help me debug this crash",
      userMessageCount: 2,
      classification: classification(),
    });
    expect(result).toContain("help me debug this crash");
  });

  it("includes the exchange count for non-junk sessions", () => {
    const result = summarizeSession({
      title: "Implement GUI migration wizard",
      firstUserMessage: null,
      userMessageCount: 5,
      classification: classification({ category: "ARCHIVE", reason: "Inactive for 20 days, likely completed" }),
    });
    expect(result).toBe("Implement GUI migration wizard (5 exchanges)");
  });

  it("uses singular 'exchange' for a single user message", () => {
    const result = summarizeSession({
      title: "Quick question",
      firstUserMessage: null,
      userMessageCount: 1,
      classification: classification(),
    });
    expect(result).toBe("Quick question (1 exchange)");
  });

  it("surfaces the classifier's reason instead of an exchange count for JUNK sessions", () => {
    const result = summarizeSession({
      title: null,
      firstUserMessage: "test",
      userMessageCount: 1,
      classification: classification({ category: "JUNK", reason: "Looks like a test or accidental prompt" }),
    });
    expect(result).toBe("test — Looks like a test or accidental prompt");
  });

  it("collapses whitespace and truncates a very long topic", () => {
    const longTitle = `line one\n\nline   two   ${"x".repeat(200)}`;
    const result = summarizeSession({ title: longTitle, firstUserMessage: null, userMessageCount: 1, classification: classification() });
    expect(result).not.toBeNull();
    expect(result!.includes("\n")).toBe(false);
    // topic portion is capped at 100 chars (before the "..." and the trailing "(1 exchange)" suffix)
    expect(result!.indexOf("(1 exchange)")).toBeLessThanOrEqual(104);
  });
});

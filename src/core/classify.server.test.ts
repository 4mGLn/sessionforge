import { describe, expect, it } from "vitest";
import { classifySession } from "./classify.server.js";

describe("classifySession", () => {
  it("flags empty sessions as junk with near-certain confidence", () => {
    const result = classifySession({
      status: "IDLE",
      lastActivityAt: new Date().toISOString(),
      messageCount: 0,
      userMessageCount: 0,
      assistantMessageCount: 0,
      firstUserMessage: null,
    });
    expect(result.category).toBe("JUNK");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("flags a single test-style prompt as junk", () => {
    const result = classifySession({
      status: "IDLE",
      lastActivityAt: new Date().toISOString(),
      messageCount: 2,
      userMessageCount: 1,
      assistantMessageCount: 1,
      firstUserMessage: "test",
    });
    expect(result.category).toBe("JUNK");
  });

  it("flags a lone user message with no response as junk", () => {
    const result = classifySession({
      status: "IDLE",
      lastActivityAt: new Date().toISOString(),
      messageCount: 1,
      userMessageCount: 1,
      assistantMessageCount: 0,
      firstUserMessage: "can you help me refactor this module",
    });
    expect(result.category).toBe("JUNK");
  });

  it("keeps substantial active sessions", () => {
    const result = classifySession({
      status: "ACTIVE",
      lastActivityAt: new Date().toISOString(),
      messageCount: 26,
      userMessageCount: 12,
      assistantMessageCount: 14,
      firstUserMessage: "Let's build the session discovery adapter for Claude Code",
    });
    expect(result.category).toBe("KEEP");
  });

  it("archives substantial sessions that have been stale for weeks", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = classifySession({
      status: "STALE",
      lastActivityAt: thirtyDaysAgo,
      messageCount: 42,
      userMessageCount: 20,
      assistantMessageCount: 22,
      firstUserMessage: "Implemented the GUI migration wizard",
    });
    expect(result.category).toBe("ARCHIVE");
  });

  it("keeps substantial sessions that are merely idle, not stale", () => {
    const result = classifySession({
      status: "IDLE",
      lastActivityAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      messageCount: 42,
      userMessageCount: 20,
      assistantMessageCount: 22,
      firstUserMessage: "Implemented the GUI migration wizard",
    });
    expect(result.category).toBe("KEEP");
  });
});

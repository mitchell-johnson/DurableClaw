import { describe, expect, it } from "vitest";

import {
  buildSummaryContext,
  extractMessageContent,
  formatMessagesForSummary,
  selectMessagesForSummary,
  type ArchivedConversationMessage,
  type ConversationSummary,
} from "../../src/agent/summary-memory";

function makeArchivedMessages(count: number): ArchivedConversationMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    sequence: index + 1,
    messageId: `msg-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index + 1}`,
    createdAt: index + 1,
  }));
}

describe("extractMessageContent", () => {
  it("combines text parts and completed tool output into a single archive string", () => {
    const content = extractMessageContent({
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "text", text: "Found the file." },
        {
          type: "tool-read_file",
          toolName: "read_file",
          toolCallId: "call-1",
          state: "output-available",
          input: { path: "notes/today.md" },
          output: "todo list",
        },
      ],
    } as never);

    expect(content).toContain("Found the file.");
    expect(content).toContain("Tool read_file");
    expect(content).toContain("todo list");
  });

  it("truncates oversized archived content so summary jobs stay bounded", () => {
    const content = extractMessageContent({
      id: "assistant-2",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "x".repeat(5000),
        },
      ],
    } as never);

    expect(content.length).toBeLessThan(4200);
    expect(content.endsWith("[truncated]")).toBe(true);
  });
});

describe("selectMessagesForSummary", () => {
  it("selects the oldest unsummarized window while keeping recent messages raw", () => {
    const selected = selectMessagesForSummary(makeArchivedMessages(10), {
      lastSummarizedSequence: 2,
      retainRecentMessages: 3,
      minMessages: 2,
      maxMessages: 4,
    });

    expect(selected.map((message) => message.sequence)).toEqual([3, 4, 5, 6]);
  });

  it("returns no summary window when too few messages remain outside the recent buffer", () => {
    const selected = selectMessagesForSummary(makeArchivedMessages(5), {
      lastSummarizedSequence: 0,
      retainRecentMessages: 4,
      minMessages: 2,
      maxMessages: 4,
    });

    expect(selected).toEqual([]);
  });
});

describe("buildSummaryContext", () => {
  it("formats the newest summaries first and limits how many are injected", () => {
    const summaries: ConversationSummary[] = [
      {
        id: "summary-1",
        startSequence: 1,
        endSequence: 4,
        messageCount: 4,
        summary: "Early setup work.",
        createdAt: 10,
      },
      {
        id: "summary-2",
        startSequence: 5,
        endSequence: 8,
        messageCount: 4,
        summary: "Later planning decisions.",
        createdAt: 20,
      },
    ];

    const context = buildSummaryContext(summaries, 1);

    expect(context).toContain("<conversation_summaries>");
    expect(context).toContain("Messages 5-8");
    expect(context).toContain("Later planning decisions.");
    expect(context).not.toContain("Early setup work.");
  });
});

describe("formatMessagesForSummary", () => {
  it("renders archived messages in sequence order for the summarizer prompt", () => {
    const formatted = formatMessagesForSummary([
      {
        sequence: 4,
        messageId: "msg-4",
        role: "assistant",
        content: "Second point",
        createdAt: 4,
      },
      {
        sequence: 3,
        messageId: "msg-3",
        role: "user",
        content: "First point",
        createdAt: 3,
      },
    ]);

    expect(formatted).toBe(
      "[3] user: First point\n[4] assistant: Second point",
    );
  });
});

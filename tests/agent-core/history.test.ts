import { beforeEach, describe, expect, it } from "vitest";
import { createSqliteStorage } from "../helpers/sqlite";
import { ConversationHistoryStore } from "../../src/agent-core/history";

let sql: ReturnType<typeof createSqliteStorage>;
let store: ConversationHistoryStore;
beforeEach(() => {
  sql = createSqliteStorage();
  store = new ConversationHistoryStore(sql as any);
  store.ensureTables();
  store.ensureConversationRow("one");
  store.ensureConversationRow("two");
});

describe("SQLite conversation history", () => {
  it("keeps tied timestamps stable under bounded history reads", () => {
    for (const content of ["first", "second", "third"])
      store.appendMessage({ conversationId: "one", role: "user", content });
    sql.exec("UPDATE messages SET created_at = ?", 100);
    expect(
      store.loadRecentMessageRows("one", 2).map((row) => row.content),
    ).toEqual(["second", "third"]);
    expect(store.loadRecentMessageRows("two")).toEqual([]);
  });
  it("deduplicates durable delivery IDs without changing message counts or allowing cross-conversation overwrite", () => {
    const delivery = {
      messageId: "delivery",
      conversationId: "one",
      role: "assistant" as const,
      content: "Found two records",
    };
    store.appendMessage(delivery);
    store.appendMessage(delivery);
    expect(store.getConversationRow("one")?.message_count).toBe(1);
    expect(() =>
      store.appendMessage({ ...delivery, conversationId: "two" }),
    ).toThrow("another conversation");
    expect(store.loadRecentMessageRows("two")).toEqual([]);
  });
  it("round-trips provider tool signatures and tool outputs after recreation", () => {
    store.appendMessage({
      conversationId: "one",
      role: "user",
      content: "Inspect",
    });
    store.appendTurnMessages(
      "one",
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call",
              toolName: "inspect",
              input: { id: 1 },
              providerOptions: { openrouter: { signature: "signature" } },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call",
              toolName: "inspect",
              output: { type: "json", value: { id: 1 } },
            },
          ],
        },
        { role: "assistant", content: "Found it" },
      ],
      "Found it",
    );
    const restored = new ConversationHistoryStore(sql as any);
    expect(restored.loadRecentMessages("one")).toEqual([
      { role: "user", content: "Inspect" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call",
            toolName: "inspect",
            input: { id: 1 },
            providerOptions: { openrouter: { signature: "signature" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call",
            toolName: "inspect",
            output: { type: "json", value: { id: 1 } },
          },
        ],
      },
      { role: "assistant", content: "Found it" },
    ]);
    expect(restored.loadRecentMessages("one", 2)).toEqual([
      { role: "assistant", content: "Found it" },
    ]);
  });
  it("does not send an incomplete leading tool exchange to a provider", () => {
    store.appendMessage({
      conversationId: "one",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          type: "tool-call",
          toolCallId: "lost",
          toolName: "inspect",
          input: {},
        },
      ],
    });
    store.appendMessage({
      conversationId: "one",
      role: "user",
      content: "Continue",
    });
    expect(store.loadRecentMessages("one")).toEqual([
      { role: "user", content: "Continue" },
    ]);
  });
  it("falls back to an assistant text row when the provider omits messages", () => {
    const id = store.appendTurnMessages("one", [], "Answer");
    expect(id).toBeTruthy();
    expect(store.loadRecentMessageRows("one")).toMatchObject([
      { message_id: id, content: "Answer" },
    ]);
  });
});

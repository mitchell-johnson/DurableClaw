import { describe, it, expect } from "vitest";
import { NanoChatAgent } from "../src/durable-objects/NanoChatAgent";
import { ConversationHistoryStore } from "../src/agent-core/history";
import { createSqliteStorage } from "./helpers/sqlite";

describe("conversation history pagination", () => {
  it("reaches every conversation with equal timestamps without duplicates", async () => {
    const sql = createSqliteStorage();
    const history = new ConversationHistoryStore(sql as any);
    history.ensureTables();
    for (let i = 0; i < 67; i++)
      history.ensureConversationRow(`chat-${String(i).padStart(3, "0")}`);
    sql.exec("UPDATE conversations SET last_active_at=100");
    const agent = Object.assign(Object.create(NanoChatAgent.prototype), {
      sql,
    });
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const url = new URL("https://agent/conversations?limit=30");
      if (cursor) url.searchParams.set("cursor", cursor);
      const data = await agent.handleListConversations(url).json();
      expect(data.conversations.length).toBeLessThanOrEqual(30);
      ids.push(...data.conversations.map((row: any) => row.conversation_id));
      cursor = data.next_cursor;
    } while (cursor && ids.length < 100);
    expect(ids).toHaveLength(67);
    expect(new Set(ids).size).toBe(67);
  });
  it.each([
    "cursor=not-base64",
    "cursor=" + encodeURIComponent(btoa(JSON.stringify([1, { bad: true }]))),
    "limit=1.5",
  ])("rejects invalid pagination inputs: %s", async (query) => {
    const sql = createSqliteStorage();
    new ConversationHistoryStore(sql as any).ensureTables();
    const agent = Object.assign(Object.create(NanoChatAgent.prototype), {
      sql,
    });
    expect(
      agent.handleListConversations(
        new URL("https://agent/conversations?" + query),
      ).status,
    ).toBe(400);
  });
});

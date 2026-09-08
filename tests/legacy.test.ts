import { describe, expect, it } from "vitest";
import { createSqliteStorage } from "./helpers/sqlite";
import { ConversationHistoryStore } from "../src/agent-core/history";
import {
  exportLegacyPage,
  importLegacyPage,
} from "../src/durable-objects/assistant/legacy";
describe("additive legacy upgrade", () => {
  it("imports multiple pages idempotently, preserves ordering and leaves original records intact", () => {
    const sql = createSqliteStorage() as any;
    new ConversationHistoryStore(sql).ensureTables();
    sql.exec(
      "CREATE TABLE archived_messages (sequence INTEGER PRIMARY KEY,message_id TEXT,role TEXT,content TEXT,created_at INTEGER)",
    );
    for (let n = 1; n <= 205; n++)
      sql.exec(
        "INSERT INTO archived_messages VALUES (?,?,?,?,?)",
        n,
        "old-" + n,
        "user",
        "Message " + n,
        n,
      );
    const first = exportLegacyPage(sql);
    expect(first.messages).toHaveLength(200);
    expect(first.next_cursor).toBe(200);
    importLegacyPage(sql, "session", first);
    importLegacyPage(sql, "session", first);
    const second = exportLegacyPage(sql, 200);
    expect(second.next_cursor).toBeNull();
    importLegacyPage(sql, "session", second);
    expect(sql.exec("SELECT COUNT(*) AS count FROM messages").one().count).toBe(
      205,
    );
    expect(
      sql.exec("SELECT COUNT(*) AS count FROM archived_messages").one().count,
    ).toBe(205);
    expect(
      sql.exec("SELECT content FROM messages ORDER BY created_at LIMIT 1").one()
        .content,
    ).toBe("Message 1");
  });
  it("separates imported message, memory and summary identities across sessions", () => {
    const sql = createSqliteStorage() as any;
    new ConversationHistoryStore(sql).ensureTables();
    const empty = {
      messages: [],
      memories: [],
      summaries: [],
      next_cursor: null,
    };
    const pages = [
      [
        "a",
        {
          ...empty,
          memories: [{ key: "1", value: "First saved memory", updated_at: 10 }],
        },
      ],
      [
        "memory-a",
        {
          ...empty,
          messages: [
            {
              sequence: 1,
              message_id: "source-1",
              role: "user",
              content: "Distinct message",
              created_at: 20,
            },
          ],
        },
      ],
      [
        "a-b",
        {
          ...empty,
          memories: [{ key: "c", value: "Other saved memory", updated_at: 30 }],
        },
      ],
      [
        "a",
        {
          ...empty,
          memories: [{ key: "b-c", value: "Fourth memory", updated_at: 40 }],
        },
      ],
    ] as const;
    for (const [session, page] of pages)
      importLegacyPage(sql, session, page as any);
    for (const [session, page] of pages)
      importLegacyPage(sql, session, page as any);
    const rows = sql
      .exec("SELECT content,conversation_id FROM messages")
      .toArray();
    expect(rows).toHaveLength(4);
    expect(
      rows.find((row: any) => row.content === "Distinct message")
        ?.conversation_id,
    ).toBe("legacy-memory-a");
  });
});

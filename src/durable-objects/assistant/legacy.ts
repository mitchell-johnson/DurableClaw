import { ConversationHistoryStore } from "../../agent-core/history";
export interface LegacyPage {
  messages: Array<{
    sequence: number;
    message_id: string;
    role: string;
    content: string;
    created_at: number;
  }>;
  summaries: Array<{ id: string; summary: string; created_at: number }>;
  memories: Array<{ key: string; value: string; updated_at: number }>;
  next_cursor: number | null;
}
const hasTable = (sql: SqlStorage, table: string) =>
  sql
    .exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table)
    .toArray().length > 0;
/** Read-only, bounded export from the original SDK-backed object. */
export function exportLegacyPage(sql: SqlStorage, after = 0): LegacyPage {
  const messages = hasTable(sql, "archived_messages")
    ? (sql
        .exec(
          "SELECT sequence,message_id,role,content,created_at FROM archived_messages WHERE sequence>? ORDER BY sequence LIMIT 200",
          after,
        )
        .toArray() as unknown as LegacyPage["messages"])
    : [];
  const summaries =
    after === 0 && hasTable(sql, "conversation_summaries")
      ? (sql
          .exec(
            "SELECT id,summary,created_at FROM conversation_summaries ORDER BY created_at LIMIT 1000",
          )
          .toArray() as unknown as LegacyPage["summaries"])
      : [];
  const memories =
    after === 0 && hasTable(sql, "group_memory")
      ? (sql
          .exec(
            "SELECT key,value,updated_at FROM group_memory ORDER BY key LIMIT 1000",
          )
          .toArray() as unknown as LegacyPage["memories"])
      : [];
  return {
    messages,
    summaries,
    memories,
    next_cursor: messages.length === 200 ? messages.at(-1)!.sequence : null,
  };
}
/** Additive and idempotent. Original SDK/archive tables remain untouched. */
export function importLegacyPage(
  sql: SqlStorage,
  session: string,
  page: LegacyPage,
): string {
  const history = new ConversationHistoryStore(sql);
  const conversation = "legacy-" + session;
  history.ensureConversationRow(conversation);
  const importId = (
    kind: string,
    key: string,
    oldId: string,
    role: string,
    content: string,
  ) => {
    const existing = sql
      .exec(
        "SELECT conversation_id,role,content FROM messages WHERE message_id=?",
        oldId,
      )
      .toArray()[0];
    // Reuse earlier imports only when the entire record identity matches.
    if (
      existing?.conversation_id === conversation &&
      existing.role === role &&
      existing.content === content
    )
      return oldId;
    return `sdk-import:${kind}:${session.length}:${session}:${key}`;
  };
  for (const m of page.messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    let content = m.content;
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed))
        content = parsed
          .filter((p) => p && p.type === "text" && typeof p.text === "string")
          .map((p) => p.text || "")
          .join("\n");
    } catch {}
    const id = history.appendMessage({
      messageId: importId(
        "message",
        String(m.sequence),
        `legacy-${session}-${m.sequence}`,
        m.role,
        content,
      ),
      conversationId: conversation,
      role: m.role,
      content,
    });
    sql.exec(
      "UPDATE messages SET created_at=? WHERE message_id=?",
      m.created_at,
      id,
    );
  }
  for (const m of page.memories)
    history.appendMessage({
      messageId: importId(
        "memory",
        m.key,
        `legacy-memory-${session}-${m.key}`,
        "assistant",
        `Imported saved memory ${m.key}: ${m.value}`,
      ),
      conversationId: conversation,
      role: "assistant",
      content: `Imported saved memory ${m.key}: ${m.value}`,
    });
  for (const m of page.summaries)
    history.appendMessage({
      messageId: importId(
        "summary",
        m.id,
        `legacy-summary-${session}-${m.id}`,
        "assistant",
        `Imported conversation summary: ${m.summary}`,
      ),
      conversationId: conversation,
      role: "assistant",
      content: `Imported conversation summary: ${m.summary}`,
    });
  sql.exec(
    "UPDATE conversations SET title=? WHERE conversation_id=?",
    "Imported conversation",
    conversation,
  );
  return conversation;
}

import type { DreamSql } from "./dreaming";

/** Source identities survive forgetting; conversation text stays in history. */
export const MEMORY_SOURCE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memory_source_messages (
  vector_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY (vector_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_source_message ON memory_source_messages(message_id);
CREATE TABLE IF NOT EXISTS memory_excluded_messages (message_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS memory_inventory_cursors (kind TEXT PRIMARY KEY,cursor TEXT NOT NULL);
`;

function hasMessages(sql: DreamSql): boolean {
  return (
    sql
      .exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='messages'",
      )
      .toArray().length > 0
  );
}

export function recordMemorySourceMessages(
  sql: DreamSql,
  vectorId: string,
  messageIds: string[],
): void {
  for (const id of new Set(messageIds))
    sql.exec(
      "INSERT OR IGNORE INTO memory_source_messages (vector_id,message_id) VALUES (?,?)",
      vectorId,
      id,
    );
}

/** Include the initiating user message and every assistant/tool row in its turn. */
export function memoryTurnMessageIds(
  sql: DreamSql,
  conversationId: string,
  lastMessageId?: string,
): string[] {
  if (!hasMessages(sql)) return [];
  const end = (
    lastMessageId
      ? sql.exec(
          "SELECT created_at,rowid AS position FROM messages WHERE conversation_id=? AND message_id=?",
          conversationId,
          lastMessageId,
        )
      : sql.exec(
          "SELECT created_at,rowid AS position FROM messages WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
          conversationId,
        )
  ).toArray()[0] as { created_at: number; position: number } | undefined;
  if (!end) return [];
  const start = sql
    .exec(
      "SELECT created_at,rowid AS position FROM messages WHERE conversation_id=? AND role='user' AND (created_at<? OR (created_at=? AND rowid<=?)) ORDER BY created_at DESC,rowid DESC LIMIT 1",
      conversationId,
      end.created_at,
      end.created_at,
      end.position,
    )
    .toArray()[0] as { created_at: number; position: number } | undefined;
  return (
    sql
      .exec(
        `SELECT message_id FROM messages WHERE conversation_id=?
    AND (created_at>? OR (created_at=? AND rowid>=?))
    AND (created_at<? OR (created_at=? AND rowid<=?))`,
        conversationId,
        start?.created_at ?? end.created_at,
        start?.created_at ?? end.created_at,
        start?.position ?? end.position,
        end.created_at,
        end.created_at,
        end.position,
      )
      .toArray() as Array<{ message_id: string }>
  ).map((row) => row.message_id);
}

export function excludeMemoryTurn(
  sql: DreamSql,
  conversationId: string,
  lastMessageId: string,
): void {
  for (const id of memoryTurnMessageIds(sql, conversationId, lastMessageId))
    sql.exec(
      "INSERT OR IGNORE INTO memory_excluded_messages (message_id) VALUES (?)",
      id,
    );
}

export function excludeAllMemorySources(sql: DreamSql): void {
  if (hasMessages(sql))
    sql.exec(
      "INSERT OR IGNORE INTO memory_excluded_messages (message_id) SELECT message_id FROM messages",
    );
}

/** Expand only the remembered fact's originating user turn, never a later turn
 * that happens to share a summary. The anchor is saved before publication.
 */
function completeAnchoredTurn(
  sql: DreamSql,
  conversationId: string,
  anchorId: string,
): string[] {
  const anchor = sql
    .exec(
      "SELECT created_at,rowid AS position FROM messages WHERE message_id=? AND conversation_id=? AND role='user'",
      anchorId,
      conversationId,
    )
    .toArray()[0] as { created_at: number; position: number } | undefined;
  if (!anchor) return [];
  const next = sql
    .exec(
      "SELECT created_at,rowid AS position FROM messages WHERE conversation_id=? AND role='user' AND (created_at,rowid)>(?,?) ORDER BY created_at,rowid LIMIT 1",
      conversationId,
      anchor.created_at,
      anchor.position,
    )
    .toArray()[0] as { created_at: number; position: number } | undefined;
  return (
    sql
      .exec(
        `SELECT message_id FROM messages WHERE conversation_id=? AND (created_at,rowid)>=(?,?) ${next ? "AND (created_at,rowid)<(?,?)" : ""}`,
        conversationId,
        anchor.created_at,
        anchor.position,
        ...(next ? [next.created_at, next.position] : []),
      )
      .toArray() as Array<{ message_id: string }>
  ).map((row) => row.message_id);
}

/** An explicit source forget also removes existing copies of that same turn.
 * Removing a learned insight remains reversible and does not erase its sources.
 * Old summaries without exact provenance conservatively exclude their conversation.
 */
export function excludeForgottenMemorySources(
  sql: DreamSql,
  vectorIds: string[],
  metadataSources: Record<string, string[]> = {},
): string[] {
  if (!hasMessages(sql)) return vectorIds;
  const excluded = new Set<string>();
  for (const vectorId of vectorIds) {
    const memory = sql
      .exec(
        "SELECT type,conversation_id FROM memory_index WHERE vector_id=?",
        vectorId,
      )
      .toArray()[0] as
      { type: string; conversation_id: string | null } | undefined;
    if (memory?.type === "insight") continue;
    const mapped = sql
      .exec(
        "SELECT message_id FROM memory_source_messages WHERE vector_id=?",
        vectorId,
      )
      .toArray() as Array<{ message_id: string }>;
    for (const row of mapped) excluded.add(row.message_id);
    for (const id of metadataSources[vectorId] ?? []) excluded.add(id);
    if (memory?.type === "memory" && memory.conversation_id) {
      // remember completes before the assistant's final reply exists. Resolve
      // the saved user anchor through the next user boundary when forgetting.
      for (const id of new Set([
        ...mapped.map((row) => row.message_id),
        ...(metadataSources[vectorId] ?? []),
      ]))
        for (const sourceId of completeAnchoredTurn(
          sql,
          memory.conversation_id,
          id,
        ))
          excluded.add(sourceId);
    }
    const raw = sql
      .exec(
        "SELECT message_id,conversation_id FROM messages WHERE vector_id=?",
        vectorId,
      )
      .toArray() as Array<{ message_id: string; conversation_id: string }>;
    for (const row of raw)
      for (const id of memoryTurnMessageIds(
        sql,
        row.conversation_id,
        row.message_id,
      ))
        excluded.add(id);
    if (
      !mapped.length &&
      !metadataSources[vectorId]?.length &&
      !raw.length &&
      memory?.conversation_id
    )
      for (const row of sql
        .exec(
          "SELECT message_id FROM messages WHERE conversation_id=?",
          memory.conversation_id,
        )
        .toArray() as Array<{ message_id: string }>)
        excluded.add(row.message_id);
  }
  const related = new Set(vectorIds);
  for (const id of excluded) {
    sql.exec(
      "INSERT OR IGNORE INTO memory_excluded_messages (message_id) VALUES (?)",
      id,
    );
    for (const row of sql
      .exec(
        `SELECT vector_id FROM memory_source_messages WHERE message_id=?
      UNION SELECT vector_id FROM messages WHERE message_id=? AND vector_id IS NOT NULL`,
        id,
        id,
      )
      .toArray() as Array<{ vector_id: string }>)
      related.add(row.vector_id);
  }
  return [...related];
}

export function sourceMessageIdsFromMetadata(
  extra: Record<string, unknown> | undefined,
): string[] {
  try {
    const value =
      typeof extra?.source_message_ids === "string"
        ? JSON.parse(extra.source_message_ids)
        : [];
    return Array.isArray(value) &&
      value.length <= 100 &&
      value.every((id) => typeof id === "string" && id.length <= 128)
      ? value
      : [];
  } catch {
    return [];
  }
}

import { recordMemorySourceMessages } from "./memorySources";
/**
 * DurableClaw conversation compaction: snapshot an unsummarized window into the
 * durable batch outbox, then apply the completed result on a later alarm.
 * The source messages and cursor are revalidated before each external write.
 * Raw vectors and the cursor remain untouched until the summary is stored;
 * cold originals backing dream insights are retained. Entity links carry
 * forward to the summary so cross-conversation retrieval survives compaction.
 */

import { enqueueHousekeepingTask } from "./housekeepingBatch";
import {
  markMemoriesForDeletion,
  cleanupPendingMemoryDeletions,
} from "./dreaming";
import { createHash } from "node:crypto";
import type { Env } from "../../types";
import { writeOwnedMemory } from "./ownedMemory";
import { logInfo, logWarn, logError } from "../../telemetry/logger";

/** Default size of the oldest-message batch to summarize. */
export const DEFAULT_BATCH_SIZE = 20;

/** Cap on output tokens. ~500 tokens ~= 2-3 sentence summary. */
const SUMMARY_MAX_TOKENS = 500;

/**
 * Completion budget for the batch summarization request. Kept separate from
 * SUMMARY_MAX_TOKENS (the length guidance given to the model in the prompt)
 * because reasoning tokens share the completion budget. The batch model
 * needs headroom above
 * the ~500-token summary itself or reasoning alone can exhaust the cap and
 * leave no room for visible text.
 */
const SUMMARY_COMPLETION_BUDGET = 4096;

/**
 * Minimal SQL-runner shape used by the summarizer. Matches the subset
 * of `SqlStorage` we touch; declared narrowly so unit tests can mock
 * with `_helpers/inMemorySql.ts` rather than the full SqlStorage
 * interface.
 */
export interface SqlExecLike {
  exec(query: string, ...params: unknown[]): { toArray(): unknown[] };
}

/** Shape of a row read from the `messages` table during summarization. */
interface SummarizableMessageRow {
  message_id: string;
  conversation_id: string;
  role: string;
  content: string;
  vector_id: string | null;
  created_at: number;
}

/** Reasons the summarizer might return `summarized: false`. */
export type SummarizerSkipReason =
  | "queued"
  | "stale_source"
  | "queue_full"
  | "below_batch_threshold"
  | "no_messages"
  | "ai_call_failed"
  | "ai_empty_response"
  | "embed_failed"
  | "vector_write_failed";

export interface SummarizeResult {
  summarized: boolean;
  message_count: number;
  summary_vector_id?: string;
  reason?: SummarizerSkipReason;
}

/** Queue the oldest complete window without advancing its cursor or deleting memories. */
export async function summarizeConversation(args: {
  env: Env;
  sql: SqlExecLike;
  user_id: string;
  tenant_binding: string;
  conversation_id: string;
  batch_size?: number;
}): Promise<SummarizeResult> {
  const batchSize = args.batch_size ?? DEFAULT_BATCH_SIZE;

  // ---------------------------------------------------------------------
  // 1. Load the cursor + oldest unsummarized messages
  // ---------------------------------------------------------------------
  const cursorRow = readCursor(args.sql, args.conversation_id);
  const oldestRows = readOldestSinceCursor(
    args.sql,
    args.conversation_id,
    cursorRow?.summarized_through_message_id ?? null,
    batchSize,
  );

  if (oldestRows.length === 0) {
    return { summarized: false, message_count: 0, reason: "no_messages" };
  }

  // ---------------------------------------------------------------------
  // 2. Threshold guard
  // ---------------------------------------------------------------------
  if (oldestRows.length < batchSize) {
    return {
      summarized: false,
      message_count: oldestRows.length,
      reason: "below_batch_threshold",
    };
  }

  const payload: SummaryPayload = {
    conversation_id: args.conversation_id,
    cursor: cursorRow?.summarized_through_message_id ?? null,
    messages: oldestRows.map((row) => ({
      message_id: row.message_id,
      role: row.role,
      content_digest: createHash("sha256").update(row.content).digest("hex"),
    })),
  };
  const taskId = enqueueHousekeepingTask(args.sql, {
    key: `summary:${args.conversation_id}`,
    kind: "summary",
    conversationId: args.conversation_id,
    payload,
    request: {
      system: "Write faithful conversation summaries for long-term memory.",
      prompt: buildSummarizationPrompt(oldestRows),
      maxTokens: SUMMARY_COMPLETION_BUDGET,
    },
    now: Date.now(),
  });
  return {
    summarized: false,
    message_count: oldestRows.length,
    reason: taskId ? "queued" : "queue_full",
  };
}

export interface SummaryPayload {
  conversation_id: string;
  cursor: string | null;
  messages: Array<{ message_id: string; role: string; content_digest: string }>;
}

/** A delayed completion can only compact the original, still-current window. */
export function isSummaryValid(
  sql: SqlExecLike,
  payload: SummaryPayload,
): boolean {
  const cursor = readCursor(sql, payload.conversation_id);
  if (!cursor || cursor.summarized_through_message_id !== payload.cursor)
    return false;
  const current = readOldestSinceCursor(
    sql,
    payload.conversation_id,
    payload.cursor,
    payload.messages.length,
  );
  return (
    current.length === payload.messages.length &&
    current.every(
      (row, i) =>
        row.message_id === payload.messages[i].message_id &&
        row.role === payload.messages[i].role &&
        createHash("sha256").update(row.content).digest("hex") ===
          payload.messages[i].content_digest,
    )
  );
}

/** Apply a completed batch response. Embedding failures retain the response for retry. */
export async function applyConversationSummary(args: {
  env: Env;
  sql: SqlExecLike;
  user_id: string;
  tenant_binding: string;
  payload: SummaryPayload;
  text: string | null;
  taskId: string;
  stillValid: () => boolean;
  onDeletionPending?: () => void;
}): Promise<SummarizeResult> {
  const { payload } = args;
  const conversationId = payload.conversation_id;
  const valid = () => args.stillValid() && isSummaryValid(args.sql, payload);
  if (!valid())
    return { summarized: false, message_count: 0, reason: "stale_source" };
  if (!args.text?.trim())
    return {
      summarized: false,
      message_count: payload.messages.length,
      reason: "ai_empty_response",
    };
  const summaryText = args.text;
  // Raw compression may have finished since submission. Resolve vector IDs
  // from the current source rows so late writes cannot escape compaction.
  const oldestRows = readOldestSinceCursor(
    args.sql,
    conversationId,
    payload.cursor,
    payload.messages.length,
  );
  // ---------------------------------------------------------------------
  // 4. Persist as a `summary` memory (embed + Vectorize upsert inside)
  // ---------------------------------------------------------------------
  const sourceMessageIds = oldestRows.map((r) => r.message_id);
  let sourceVectorIds = oldestRows
    .map((r) => r.vector_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const lastMessageId = oldestRows[oldestRows.length - 1].message_id;

  let deletableVectorIds: string[] = [];
  let summaryWrite: { vector_id: string; persisted: boolean };
  try {
    summaryWrite = await writeOwnedMemory({
      env: args.env,
      sql: args.sql,
      retryTaskId: args.taskId,
      onDeletionPending: args.onDeletionPending,
      onCommit: (vectorId) => {
        recordMemorySourceMessages(args.sql, vectorId, sourceMessageIds);
        // A raw write can finish during this summary's embedding/upsert. Capture
        // its final IDs for authoritative local provenance before committing the
        // cursor, which prevents any subsequent raw write from passing its guard.
        sourceVectorIds = readOldestSinceCursor(
          args.sql,
          conversationId,
          payload.cursor,
          payload.messages.length,
        )
          .map((row) => row.vector_id)
          .filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          );
        // Dream sources are reversible: compaction must not remove originals
        // that a live insight has moved cold.
        deletableVectorIds = sourceVectorIds.filter((id) => {
          const row = args.sql
            .exec("SELECT tier FROM memory_index WHERE vector_id = ?", id)
            .toArray()[0] as { tier: string } | undefined;
          return row?.tier !== "cold";
        });

        // Commit provenance and the cursor before external raw cleanup. A forget
        // during that await can now discover the derived summary, and cannot leave
        // a stale cursor pointing at deleted source memories.

        for (const source of sourceVectorIds) {
          args.sql.exec(
            "INSERT OR IGNORE INTO memory_insight_sources (insight_id, source_id) VALUES (?, ?)",
            vectorId,
            source,
          );
        }
        carryForwardEntityLinks(
          args.sql,
          sourceVectorIds,
          vectorId,
          conversationId,
        );
        args.sql.exec(
          "UPDATE conversations SET summarized_through_message_id = ? WHERE conversation_id = ?",
          lastMessageId,
          conversationId,
        );
      },
      memory: {
        user_id: args.user_id,
        tenant_binding: args.tenant_binding,
        conversation_id: conversationId,
        type: "summary",
        vector_id: `summary-${args.taskId}`,
        stillValid: valid,
        content: summaryText,
        extra: {
          // Compact metadata. Source ids stored as a JSON-encoded string so
          // they survive the metadata-value-as-scalar Vectorize constraint.
          source_message_ids: JSON.stringify(sourceMessageIds),
          source_count: sourceMessageIds.length,
          ...(sourceVectorIds.length > 0
            ? { source_vector_ids: JSON.stringify(sourceVectorIds) }
            : {}),
        },
      },
    });
  } catch (error) {
    // Embedding failure surfaces here too (generateEmbedding throws into
    // writeMemory). Categorise as vector_write_failed and back off.
    logError("summarizer: writeMemory failed", error as Error, {
      "durableclaw.summarizer.user_id": args.user_id,
      "durableclaw.summarizer.conversation_id": conversationId,
    });
    return {
      summarized: false,
      message_count: oldestRows.length,
      reason: "vector_write_failed",
    };
  }

  if (!summaryWrite.persisted) {
    // Binding-missing path. Treated as embed/write failure so callers
    // don't think work happened.
    logWarn(
      "summarizer: memory publication did not commit; source memories retained",
      {
        "durableclaw.summarizer.user_id": args.user_id,
        "durableclaw.summarizer.conversation_id": conversationId,
      },
    );
    return {
      summarized: false,
      message_count: oldestRows.length,
      reason: valid() ? "vector_write_failed" : "stale_source",
    };
  }

  // Persist cleanup intent before yielding: failed or ambiguous raw deletion
  // must stay hidden and retryable without repeating the committed summary.
  // Cold originals backing live insights remain available for reversibility.
  if (deletableVectorIds.length > 0) {
    markMemoriesForDeletion(args.sql, deletableVectorIds);
    args.onDeletionPending?.();
    try {
      await cleanupPendingMemoryDeletions({ sql: args.sql, env: args.env });
    } catch (err) {
      logError(
        "summarizer: raw cleanup will retry; committed summary retained",
        err as Error,
        {
          "durableclaw.summarizer.conversation_id": conversationId,
        },
      );
    }
  }

  logInfo("summarizer: conversation summarized", {
    "durableclaw.summarizer.user_id": args.user_id,
    "durableclaw.summarizer.tenant_binding": args.tenant_binding,
    "durableclaw.summarizer.conversation_id": conversationId,
    "durableclaw.summarizer.message_count": oldestRows.length,
    "durableclaw.summarizer.summary_vector_id": summaryWrite.vector_id,
    "durableclaw.summarizer.raw_vector_count": sourceVectorIds.length,
  });

  return {
    summarized: true,
    message_count: oldestRows.length,
    summary_vector_id: summaryWrite.vector_id,
  };
}

// -----------------------------------------------------------------------------
// internals
// -----------------------------------------------------------------------------

/**
 * Read the conversation row to get the current cursor. Returns `null`
 * if the conversation doesn't exist (the alarm scan should never call
 * us in that case, but we tolerate it).
 */
function readCursor(
  sql: SqlExecLike,
  conversation_id: string,
): { summarized_through_message_id: string | null } | null {
  const rows = sql
    .exec(
      `SELECT summarized_through_message_id FROM conversations WHERE conversation_id = ? LIMIT 1`,
      conversation_id,
    )
    .toArray() as Array<{ summarized_through_message_id: string | null }>;
  return rows[0] ?? null;
}

/**
 * Resolve one eligibility predicate for batch selection and alarm counts.
 * History is ordered by (created_at, rowid), preserving insertion order when
 * a completed turn stores several assistant/tool rows in the same millisecond.
 * The durable cursor remains a message ID; a missing source restarts at the
 * conversation head so clearing/deleting a row cannot strand the scheduler.
 */
function messagesSinceCursor(
  sql: SqlExecLike,
  conversationId: string,
  cursorMessageId: string | null,
): { predicate: string; bindings: unknown[] } {
  const cursor = cursorMessageId
    ? (sql
        .exec(
          `SELECT created_at, rowid AS cursor_rowid FROM messages
         WHERE conversation_id = ? AND message_id = ? LIMIT 1`,
          conversationId,
          cursorMessageId,
        )
        .toArray()[0] as
        { created_at: number; cursor_rowid: number } | undefined)
    : undefined;
  // A reply/tool row may arrive after forgetting (for example, a stopped
  // stream's partial reply). It inherits its own user turn's exclusion, but
  // an unrelated subsequent user turn stays eligible.
  const sourceEligible = `
    NOT EXISTS (SELECT 1 FROM memory_excluded_messages WHERE memory_excluded_messages.message_id = messages.message_id)
    AND NOT EXISTS (
      SELECT 1 FROM memory_excluded_messages WHERE memory_excluded_messages.message_id = (
        SELECT source_user.message_id FROM messages AS source_user
        WHERE source_user.conversation_id = messages.conversation_id
          AND source_user.role = 'user'
          AND (source_user.created_at, source_user.rowid) <= (messages.created_at, messages.rowid)
        ORDER BY source_user.created_at DESC, source_user.rowid DESC LIMIT 1
      )
    )`;
  if (!cursor)
    return {
      predicate: `conversation_id = ? AND ${sourceEligible}`,
      bindings: [conversationId],
    };
  return {
    predicate: `conversation_id = ? AND (created_at > ? OR (created_at = ? AND rowid > ?)) AND ${sourceEligible}`,
    bindings: [
      conversationId,
      cursor.created_at,
      cursor.created_at,
      cursor.cursor_rowid,
    ],
  };
}

function readOldestSinceCursor(
  sql: SqlExecLike,
  conversationId: string,
  cursorMessageId: string | null,
  batchSize: number,
): SummarizableMessageRow[] {
  const { predicate, bindings } = messagesSinceCursor(
    sql,
    conversationId,
    cursorMessageId,
  );
  return sql
    .exec(
      `SELECT message_id, conversation_id, role, content, vector_id, created_at
     FROM messages WHERE ${predicate}
     ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      ...bindings,
      batchSize,
    )
    .toArray() as SummarizableMessageRow[];
}

/** Count exactly the rows eligible for the next summary batch. */
export function countMessagesSinceCursor(
  sql: SqlExecLike,
  conversationId: string,
  cursorMessageId: string | null,
): number {
  const { predicate, bindings } = messagesSinceCursor(
    sql,
    conversationId,
    cursorMessageId,
  );
  const row = sql
    .exec(
      `SELECT COUNT(*) AS count FROM messages WHERE ${predicate}`,
      ...bindings,
    )
    .toArray()[0] as { count: number };
  return row.count;
}

export function isMessageUncompacted(
  sql: SqlExecLike,
  conversationId: string,
  messageId: string,
): boolean {
  const cursor = readCursor(sql, conversationId);
  if (!cursor) return false;
  const { predicate, bindings } = messagesSinceCursor(
    sql,
    conversationId,
    cursor.summarized_through_message_id,
  );
  return (
    sql
      .exec(
        `SELECT message_id FROM messages WHERE ${predicate} AND message_id = ? LIMIT 1`,
        ...bindings,
        messageId,
      )
      .toArray().length > 0
  );
}

/**
 * Build the summarization prompt as a single string.
 *
 * The prompt template is fixed for durable memory - captures *what*
 * was discussed, *key facts*, and *user preferences*; excludes tool-
 * call mechanics, self-references, and filler.
 */
function buildSummarizationPrompt(rows: SummarizableMessageRow[]): string {
  const turns = rows
    .map((r, i) => {
      const role = r.role === "tool" ? "tool result" : r.role;
      const content = r.content?.slice(0, 1200) ?? "";
      return `${i + 1}. [${role}] ${content}`;
    })
    .join("\n");

  return `You are summarizing a conversation between a user and an AI assistant for long-term memory retention. The conversation is part of a workspace.

CONVERSATION TURNS:
${turns}

Produce a single concise summary (2-3 sentences, max ${SUMMARY_MAX_TOKENS} tokens) that captures:
- WHAT was discussed (entities, decisions, requests)
- KEY facts the user would want recalled later
- ANY user preferences expressed

Do NOT include:
- Tool call mechanics
- Self-references ("the AI said")
- Apologies or filler

Output the summary as plain text only.`;
}

/**
 * Carry forward entity links from the raw vectors being replaced.
 *
 * Aggregates DISTINCT (entity_type, entity_id) tuples that point at any
 * of the source vector_ids, then inserts one row per tuple keyed on the
 * new summary's vector_id. Duplicate inserts (rare - the summary
 * vector_id is fresh) are tolerated via the PK conflict catch in case
 * the function is invoked twice for the same window.
 */
function carryForwardEntityLinks(
  sql: SqlExecLike,
  sourceVectorIds: string[],
  summaryVectorId: string,
  conversation_id: string,
): void {
  if (sourceVectorIds.length === 0) return;

  // Collect DISTINCT (entity_type, entity_id) across all source vectors.
  // We do this one source at a time because the in-memory SQL mock and
  // SqlStorage's parameter binding doesn't expose a clean `IN (?)` over
  // an array; per-id queries are bounded by sourceVectorIds.length (max
  // batch_size = 20) so this is fine.
  const seen = new Set<string>();
  const distinct: Array<{ entity_type: string; entity_id: string }> = [];
  for (const sourceId of sourceVectorIds) {
    const rows = sql
      .exec(
        `SELECT entity_type, entity_id FROM memory_links WHERE vector_id = ?`,
        sourceId,
      )
      .toArray() as Array<{ entity_type: string; entity_id: string }>;
    for (const r of rows) {
      const key = `${r.entity_type}:${r.entity_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      distinct.push(r);
    }
  }

  const now = Date.now();
  for (const e of distinct) {
    try {
      sql.exec(
        `INSERT INTO memory_links (vector_id, entity_type, entity_id, conversation_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        summaryVectorId,
        e.entity_type,
        e.entity_id,
        conversation_id,
        now,
      );
    } catch {
      // PK conflict (vector_id+entity_type+entity_id). Re-runs of the
      // summarizer for the same window land here; safe to ignore.
    }
  }
}

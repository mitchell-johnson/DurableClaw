/**
 * DurableClaw memory orchestration helpers.
 *
 * Keeps memory wiring out of `AssistantAgent.ts` (which is already huge).
 * Exposes the WRITE half of the turn loop plus the entity-link primitive the
 * read half needs:
 *
 *   - `writeRawTurnMemory`        post-turn `raw` memory (user+assistant pair).
 *   - `writeToolCallMemory`       per-tool `tool_call` memory + `memory_links`.
 *   - `collectExpansionVectorIds` walks `memory_links` for related vectors.
 *
 * READING memory is no longer done here. `retrieveMemoryForTurn` and
 * `formatMemorySections` pre-fetched memories and stuffed them into the system
 * prompt on every turn; that was replaced by the `search_memory` tool, which
 * the model calls when a request actually leans on prior context. The tool
 * still performs the same `memory_links` expansion via
 * `collectExpansionVectorIds` — which is why that helper is exported rather
 * than private.
 *
 * Design notes:
 *
 *   - Vectorize-backed; falls back to no-op when `env.MEMORY_INDEX` is
 *     unset (the underlying `memoryClient` already degrades, we
 *     just respect its `persisted: false` signal).
 *   - Token budgeting uses a rough chars/4 heuristic. Real tiktoken
 *     counting is overkill for a soft cap and is overhead in the hot
 *     path.
 *   - Long assistant text is queued by the coordinator for batch compression.
 *     This writer accepts the completed summary, with a local fallback.
 */

import type { Env } from "../../types";
import { writeOwnedMemory } from "./ownedMemory";
import { extractEntities } from "./entityExtraction";
import { logError, logDebug } from "../../telemetry/logger";

/** Top-3 semantic hits drive entity-link expansion. */
export const ENTITY_EXPANSION_SEED = 3;
/** Up to 5 linked vectors fetched per entity. */
const ENTITY_EXPANSION_PER_ENTITY = 5;
/** Hard cap on total entity-link expansions to keep getByIds bounded. */
const ENTITY_EXPANSION_TOTAL_CAP = 15;
/** Boost applied to entity-link matches in re-ranking. */
export const ENTITY_LINK_BOOST = 0.1;
/**
 * Multiplier applied to the synthesized score=1 baseline that
 * `getMemoriesByIds` returns for entity-link expansion. Expansion is
 * augmentation, not override — keep semantic hits primary. With this
 * multiplier the expansion weighted_score becomes
 * `(0.5) × type_weight + ENTITY_LINK_BOOST` rather than
 * `(1.0) × type_weight + ENTITY_LINK_BOOST`, so a semantic hit at
 * cosine 0.7 with type_weight 1.0 (weighted_score 0.7) outranks an
 * expansion synthesized 0.5 × 1.0 + 0.1 = 0.6.
 */
export const EXPANSION_SCORE_MULTIPLIER = 0.5;
/** Threshold above which we summarize assistant text before embedding. */
export const SUMMARIZE_THRESHOLD = 1500;
/** Fallback truncation length if the model summary fails. */
const FALLBACK_TRUNCATE = 1200;

/**
 * Minimal SQL-runner shape used for `memory_links` reads/writes.
 * Matches Cloudflare's `SqlStorage` surface for the subset we need;
 * declared narrowly so unit tests can mock without dragging the full
 * SqlStorage interface.
 */
export interface SqlExecLike {
  exec(query: string, ...params: unknown[]): { toArray(): unknown[] };
}

/**
 * Write a `raw` memory after a turn completes.
 *
 * Composes:
 *   `User: ${user_message}\n\nAssistant: ${assistant_summary}`
 *
 * The coordinator supplies a batch summary for long assistant replies.
 * When no summary is available, this writer uses a local truncation.
 * Memory is written (possibly with degraded quality) as long
 * as `env.MEMORY_INDEX` is bound.
 *
 * Returns `{ vector_id: null }` when persistence is unavailable.
 */
export async function writeRawTurnMemory(
  env: Env,
  sql: SqlExecLike,
  args: {
    user_id: string;
    tenant_binding: string;
    conversation_id: string;
    user_message: string;
    assistant_text: string;
    assistant_summary?: string;
    vector_id?: string;
    stillValid?: () => boolean;
    retryTaskId?: string;
    onCommit?: (vectorId: string) => void;
    onDeletionPending?: () => void;
  },
): Promise<{ vector_id: string | null }> {
  try {
    const assistantSummary =
      args.assistant_summary ?? truncateAssistantText(args.assistant_text);

    const content = `User: ${args.user_message}\n\nAssistant: ${assistantSummary}`;

    const result = await writeOwnedMemory({
      env,
      sql,
      retryTaskId: args.retryTaskId,
      onCommit: args.onCommit,
      onDeletionPending: args.onDeletionPending,
      memory: {
        user_id: args.user_id,
        tenant_binding: args.tenant_binding,
        conversation_id: args.conversation_id,
        type: "raw",
        vector_id: args.vector_id,
        stillValid: args.stillValid,
        content,
      },
    });

    return { vector_id: result.persisted ? result.vector_id : null };
  } catch (error) {
    logError("writeRawTurnMemory failed", error as Error, {
      "durableclaw.memory.user_id": args.user_id,
      "durableclaw.memory.tenant_binding": args.tenant_binding,
    });
    return { vector_id: null };
  }
}

/**
 * Write a `tool_call` memory + `memory_links` rows.
 *
 * The embedded text is the INTENT (the user message that triggered
 * the call + a brief tool/result-count summary), NOT the result rows.
 * Embedding result payloads would (a) bloat memories with stale data
 * and (b) leak application specifics into retrieval results.
 *
 * Entity extraction runs on `tool_args` + `tool_output` and writes
 * one `memory_links` row per (entity_type, entity_id) pair.
 *
 * Returns `{ vector_id: null }` when persistence is unavailable; in
 * that case we DO NOT write memory_links either (no FK target).
 */
export async function writeToolCallMemory(
  env: Env,
  sql: SqlExecLike,
  args: {
    user_id: string;
    tenant_binding: string;
    conversation_id: string;
    user_message: string;
    tool_name: string;
    tool_args: unknown;
    tool_output: unknown;
    result_count?: number;
    stillValid?: () => boolean;
    onDeletionPending?: () => void;
  },
): Promise<{ vector_id: string | null }> {
  try {
    // Compose intent text. Keep it short - embeddings care about gist.
    const resultCountPart =
      typeof args.result_count === "number"
        ? ` Result: ${args.result_count} item${args.result_count === 1 ? "" : "s"}.`
        : "";
    const intent = `User asked: ${args.user_message}\nTool: ${args.tool_name}.${resultCountPart}`;

    const result = await writeOwnedMemory({
      env,
      sql,
      onDeletionPending: args.onDeletionPending,
      memory: {
        user_id: args.user_id,
        tenant_binding: args.tenant_binding,
        conversation_id: args.conversation_id,
        type: "tool_call",
        content: intent,
        stillValid: args.stillValid,
        extra: {
          tool_name: args.tool_name,
          ...(typeof args.result_count === "number"
            ? { result_count: args.result_count }
            : {}),
        },
      },
      onCommit: (vectorId) => {
        // Extract entities + write memory_links rows. The DO's SQL is
        // not transactional in the JS sense, but consecutive statements
        // on the same SqlStorage are serially applied; that's good enough
        // here - partial writes are recoverable (memory_links can be
        // re-derived from a later turn).
        const entities = extractEntities(
          args.tool_name,
          args.tool_args,
          args.tool_output,
        );
        const now = Date.now();
        for (const e of entities) {
          try {
            sql.exec(
              `INSERT INTO memory_links (vector_id, entity_type, entity_id, conversation_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
              vectorId,
              e.entity_type,
              e.entity_id,
              args.conversation_id,
              now,
            );
          } catch (err) {
            // Duplicate key (vector_id+entity_type+entity_id is the PK) is
            // fine - we just don't double-write. Anything else is logged.
            logDebug("memory_links insert skipped (likely duplicate)", {
              "durableclaw.memory.vector_id": vectorId,
              "durableclaw.memory.entity_type": e.entity_type,
              "durableclaw.memory.entity_id": e.entity_id,
              "error.message": (err as Error).message,
            });
          }
        }
      },
    });
    if (!result.persisted) return { vector_id: null };

    return { vector_id: result.vector_id };
  } catch (error) {
    logError("writeToolCallMemory failed", error as Error, {
      "durableclaw.memory.user_id": args.user_id,
      "durableclaw.memory.tenant_binding": args.tenant_binding,
      "durableclaw.memory.tool_name": args.tool_name,
    });
    return { vector_id: null };
  }
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * Walk memory_links for each seed vector_id and collect up to
 * `ENTITY_EXPANSION_PER_ENTITY` *other* vector_ids per entity, capped
 * at `ENTITY_EXPANSION_TOTAL_CAP` overall.
 *
 * Implementation: we issue one SELECT per seed to find that seed's
 * entities, then one SELECT per entity to find sibling vectors. This
 * is two-round-trip-per-seed in the worst case but each query is
 * bounded by `LIMIT` and runs against the in-DO SQLite (no network).
 *
 * `excludeIds` is the semantic-result set - we don't expand into
 * vectors already in `background`.
 */
export function collectExpansionVectorIds(
  sql: SqlExecLike,
  seedIds: string[],
  excludeIds: Set<string>,
): string[] {
  if (seedIds.length === 0) return [];

  const collected = new Set<string>();
  const seenEntityKeys = new Set<string>();

  for (const seed of seedIds) {
    if (collected.size >= ENTITY_EXPANSION_TOTAL_CAP) break;

    let entities: Array<{ entity_type: string; entity_id: string }>;
    try {
      const cursor = sql.exec(
        `SELECT entity_type, entity_id FROM memory_links WHERE vector_id = ?`,
        seed,
      );
      entities = cursor.toArray() as Array<{
        entity_type: string;
        entity_id: string;
      }>;
    } catch (err) {
      logDebug("memory_links read failed for seed", {
        "durableclaw.memory.seed_id": seed,
        "error.message": (err as Error).message,
      });
      continue;
    }

    for (const e of entities) {
      if (collected.size >= ENTITY_EXPANSION_TOTAL_CAP) break;
      const key = `${e.entity_type}:${e.entity_id}`;
      if (seenEntityKeys.has(key)) continue;
      seenEntityKeys.add(key);

      let siblings: Array<{ vector_id: string }>;
      try {
        const cursor = sql.exec(
          `SELECT vector_id FROM memory_links
           WHERE entity_type = ? AND entity_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
          e.entity_type,
          e.entity_id,
          ENTITY_EXPANSION_PER_ENTITY,
        );
        siblings = cursor.toArray() as Array<{ vector_id: string }>;
      } catch (err) {
        logDebug("memory_links sibling lookup failed", {
          "durableclaw.memory.entity_type": e.entity_type,
          "durableclaw.memory.entity_id": e.entity_id,
          "error.message": (err as Error).message,
        });
        continue;
      }

      for (const s of siblings) {
        if (collected.size >= ENTITY_EXPANSION_TOTAL_CAP) break;
        if (excludeIds.has(s.vector_id)) continue;
        collected.add(s.vector_id);
      }
    }
  }

  return Array.from(collected);
}

export function tokenEstimate(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

/** Local fallback, also used if a batch fails or no model is configured. */
export function truncateAssistantText(text: string): string {
  return text.length > SUMMARIZE_THRESHOLD
    ? text.slice(0, FALLBACK_TRUNCATE)
    : text;
}

/** Text-only request; the durable batch queue performs inference later. */
export function buildRawMemoryRequest(text: string) {
  return {
    system:
      "You write one-sentence summaries of an AI assistant response. Capture only the user-facing outcome. Do not include personal opinions, follow-up questions, or formatting.",
    prompt: text.slice(0, 60_000),
    maxTokens: 2048,
  };
}

/**
 * DurableClaw memory tools: `remember` and `forget`.
 *
 * These are the only two tools the LLM uses to manage long-term
 * memory explicitly (raw + tool_call memories are written by the DO
 * automatically; summaries are produced by the housekeeping alarm).
 *
 * Closure-injected context:
 *   - `user_id` and `tenant_binding` come from the DO's restored
 *     `this.context`. The LLM NEVER sees these args - only the DO
 *     does, when constructing the tools array.
 *
 * Two-step `forget` flow:
 *   1. First call (`matching`) -> query top-5 type=memory candidates,
 *      return their ids + previews. The LLM presents these to the
 *      user and waits for explicit confirmation.
 *   2. Second call (`confirm_ids`) -> validate each id maps to a
 *      memory in THIS user's namespace, then delete from Vectorize
 *      and `memory_links`.
 *
 * Validation in step 2 is critical: a misbehaving LLM could pass
 * unrelated ids. We re-fetch via `getMemoriesByIds` and check
 * `metadata.user_namespace === ${user_id}:${tenant_binding}` before
 * deleting.
 */

import { writeOwnedMemory } from "../ownedMemory";
import type { Env } from "../../../types";
import {
  queryMemory,
  getMemoriesByIds,
  buildNamespace,
} from "../../../utils/memoryClient";
import { defineTool } from "../../../action-library/helpers";
import { logInfo, logWarn } from "../../../telemetry/logger";
import {
  deleteOwnedMemoryVectors,
  filterWarmMemoryIds,
  markMemoriesForDeletion,
  planMemoryDeletion,
  removeIndexedMemories,
} from "../dreaming";

/**
 * Minimal SQL-runner shape used by the forget cascade. Matches the
 * subset of `SqlStorage` we need; declared narrowly so unit tests
 * can mock easily.
 */
export interface SqlExecLike {
  exec(query: string, ...params: unknown[]): { toArray(): unknown[] };
}

export interface MemoryToolContext {
  env: Env;
  sql: SqlExecLike;
  user_id: string;
  tenant_binding: string;
  conversation_id?: string;
  /** Invalidates pending housekeeping before deleting a source memory. */
  onForget?: () => void;
  /** The user may disable memory while embedding or upsert is in flight. */
  stillValid?: () => boolean;
  /** Capture per invocation because the ToolSet is reused across turns. */
  getWriteVersion?: () => number;
  onDeletionPending?: () => void;
}

/**
 * Build the `remember` and `forget` tools with closure-bound context.
 * Returned as a partial ToolSet ready to be spread into `createTools`.
 */
export function createMemoryTools(ctx: MemoryToolContext) {
  return {
    remember: defineTool<{ fact: string; scope: "global" }>({
      description:
        "Persist a fact about the user or their preferences so you can recall it in future conversations. " +
        "Only use this when the user EXPLICITLY asks to remember something. " +
        'Examples of valid input: "Remember that I prefer concise responses", "Remember that my focus this quarter is accessibility".',
      properties: {
        fact: {
          type: "string",
          description:
            "The fact to remember. 1-500 characters. Phrase as a clear statement.",
          minLength: 1,
          maxLength: 500,
        },
        scope: {
          type: "string",
          enum: ["global"],
          description:
            'Currently only "global" (remembered across all conversations) is supported.',
        },
      },
      required: ["fact", "scope"],
      execute: async (input) => {
        const fact = (input.fact ?? "").trim();
        if (!fact) {
          return JSON.stringify({
            error: "fact is required and cannot be empty",
          });
        }
        if (fact.length > 500) {
          return JSON.stringify({
            error: "fact must be 500 characters or fewer",
          });
        }
        const version = ctx.getWriteVersion?.();
        const stillValid = () =>
          (ctx.stillValid?.() ?? true) && ctx.getWriteVersion?.() === version;
        if (!stillValid())
          return JSON.stringify({
            confirmation: "Long-term memory is disabled.",
            persisted: false,
          });
        const result = await writeOwnedMemory({
          env: ctx.env,
          sql: ctx.sql,
          onDeletionPending: ctx.onDeletionPending,
          memory: {
            user_id: ctx.user_id,
            tenant_binding: ctx.tenant_binding,
            conversation_id: ctx.conversation_id,
            type: "memory",
            content: fact,
            extra: { source: "remember_tool" },
            stillValid,
          },
        });
        if (!result.persisted) {
          return JSON.stringify({
            confirmation:
              "Long-term memory is not available right now, so I cannot save that - please try again later.",
            persisted: false,
          });
        }
        logInfo("remember tool persisted a memory", {
          "durableclaw.memory.user_id": ctx.user_id,
          "durableclaw.memory.vector_id": result.vector_id,
        });
        return JSON.stringify({
          vector_id: result.vector_id,
          confirmation: "Remembered.",
        });
      },
    }),

    forget: defineTool<{ matching?: string; confirm_ids?: string[] }>({
      description:
        "Two-step delete of remembered facts. First call with `matching` (a description of what to forget) to get a list of candidate memories. " +
        "Present the candidates to the user and wait for explicit confirmation. Then call again with `confirm_ids` set to the ids the user confirmed.",
      properties: {
        matching: {
          type: "string",
          description:
            "A short description of what to forget. Used to find candidate memories. Required on the first (preview) call.",
        },
        confirm_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Vector ids returned from the previous preview call. Provide only after the user has explicitly confirmed which memories to delete.",
        },
      },
      execute: async (input) => {
        // Step 2: delete confirmed ids.
        if (Array.isArray(input.confirm_ids) && input.confirm_ids.length > 0) {
          const expectedNamespace = buildNamespace(
            ctx.user_id,
            ctx.tenant_binding,
          );

          // Validate every id belongs to this user's namespace BEFORE
          // deleting anything. Belt and braces against a misbehaving
          // LLM passing ids from another user.
          const candidates = await getMemoriesByIds(ctx.env, input.confirm_ids);
          const validIds: string[] = [];
          const rejectedIds: string[] = [];
          for (const c of candidates) {
            if (c.metadata.user_namespace === expectedNamespace) {
              validIds.push(c.vector_id);
            } else {
              rejectedIds.push(c.vector_id);
            }
          }
          if (rejectedIds.length > 0) {
            logWarn("forget tool rejected ids from a different namespace", {
              "durableclaw.memory.user_id": ctx.user_id,
              "durableclaw.memory.tenant_binding": ctx.tenant_binding,
              "durableclaw.memory.rejected_count": rejectedIds.length,
            });
          }

          if (validIds.length === 0) {
            return JSON.stringify({
              deleted: 0,
              confirmation:
                "I could not delete those memories - none of them are owned by you or they no longer exist.",
            });
          }

          // Best-effort atomic: Vectorize delete first, then SQL.
          // If Vectorize delete throws we surface the error to the
          // model; if SQL throws we log and warn (cleanup is
          // recoverable later by the orphan-link sweep in scheduled maintenance).
          ctx.onForget?.();
          const deletionIds = planMemoryDeletion(ctx.sql, validIds);
          markMemoriesForDeletion(ctx.sql, deletionIds);
          ctx.onDeletionPending?.();
          let vectorOk = false;
          try {
            await deleteOwnedMemoryVectors(ctx.env, ctx.sql, deletionIds);
            vectorOk = true;
            removeIndexedMemories(ctx.sql, deletionIds);
          } catch (err) {
            logWarn("forget tool: deleteMemoriesByIds failed", {
              "durableclaw.memory.error": (err as Error).message,
            });
            return JSON.stringify({
              error:
                "Failed to delete memories from the vector store. Please try again.",
            });
          }

          // Cascade-delete memory_links rows pointing at the now-gone
          // vectors. We issue one DELETE per id so the in-memory SQL
          // mock used by unit tests can match each statement; in
          // production this is still a tight inner loop over at most
          // a handful of ids.
          for (const vid of deletionIds) {
            try {
              ctx.sql.exec(`DELETE FROM memory_links WHERE vector_id = ?`, vid);
            } catch (err) {
              logWarn("forget tool: memory_links cascade-delete failed", {
                "durableclaw.memory.vector_id": vid,
                "durableclaw.memory.error": (err as Error).message,
              });
              // Continue: vector was deleted from Vectorize, so the
              // orphan link will be harmless until the cleanup sweep.
            }
          }

          logInfo("forget tool deleted memories", {
            "durableclaw.memory.user_id": ctx.user_id,
            "durableclaw.memory.deleted_count": validIds.length,
            "durableclaw.memory.vector_ok": vectorOk,
          });
          return JSON.stringify({
            deleted: validIds.length,
            confirmation: "Forgotten.",
          });
        }

        // Step 1: preview candidates for the requested matching text.
        const matching = (input.matching ?? "").trim();
        if (!matching) {
          return JSON.stringify({
            error:
              "Provide a `matching` description to look up which memories to forget, then call again with `confirm_ids` after the user agrees.",
          });
        }

        const queried = await queryMemory(ctx.env, {
          user_id: ctx.user_id,
          tenant_binding: ctx.tenant_binding,
          query_text: matching,
          topK: 5,
          typeFilter: ["memory", "insight"],
        });

        const visible = new Set(
          filterWarmMemoryIds(
            ctx.sql,
            queried.map((m) => m.vector_id),
          ),
        );
        const matches = queried.filter((m) => visible.has(m.vector_id));
        if (matches.length === 0) {
          return JSON.stringify({
            candidates: [],
            confirmation:
              "I could not find any explicit memories matching that description. Nothing to forget.",
          });
        }

        return JSON.stringify({
          candidates: matches.map((m) => ({
            vector_id: m.vector_id,
            content_preview: m.metadata.content_preview,
          })),
          instructions:
            "Present these to the user, ask which to forget, then call `forget` again with the agreed `confirm_ids` array.",
        });
      },
    }),
  };
}

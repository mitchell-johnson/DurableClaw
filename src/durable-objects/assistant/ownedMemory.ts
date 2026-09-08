/** Owner-side publication journal for memory writes. An external write is never
 * authoritative until its synchronous local commit removes the pending marker. */
import type { Env } from "../../types";
import {
  buildNamespace,
  buildVectorId,
  writeMemory,
} from "../../utils/memoryClient";
import {
  type DreamSql,
  indexMemory,
  markMemoriesForDeletion,
  removeIndexedMemories,
  deleteOwnedMemoryVectors,
} from "./dreaming";
import { logWarn } from "../../telemetry/logger";

interface PendingWrite {
  vector_id: string;
  retry_task_id: string | null;
}
function rejectWrites(sql: DreamSql, rows: PendingWrite[]): number {
  for (const row of rows) {
    markMemoriesForDeletion(sql, [row.vector_id]);
    sql.exec(
      "DELETE FROM memory_pending_writes WHERE vector_id = ?",
      row.vector_id,
    );
  }
  return rows.length;
}
/** Reconstructing an owner abandons transient writes. Existing durable jobs may
 * retry their exact IDs without treating a valid storage failure as forgetting. */
export function recoverPendingMemoryWrites(
  sql: DreamSql,
  retainRetry: (taskId: string) => boolean,
): number {
  const rows = sql
    .exec("SELECT vector_id, retry_task_id FROM memory_pending_writes")
    .toArray() as PendingWrite[];
  return rejectWrites(
    sql,
    rows.filter((row) => !row.retry_task_id || !retainRetry(row.retry_task_id)),
  );
}
export function discardPendingMemoryWrites(
  sql: DreamSql,
  taskId: string,
): number {
  return rejectWrites(
    sql,
    sql
      .exec(
        "SELECT vector_id, retry_task_id FROM memory_pending_writes WHERE retry_task_id = ?",
        taskId,
      )
      .toArray() as PendingWrite[],
  );
}

export async function writeOwnedMemory(args: {
  env: Env;
  sql: DreamSql;
  memory: Parameters<typeof writeMemory>[1];
  retryTaskId?: string;
  onCommit?: (vectorId: string) => void;
  onDeletionPending?: () => void;
}): Promise<{ vector_id: string; persisted: boolean }> {
  const { sql, env, memory } = args;
  const vectorId = memory.vector_id ?? buildVectorId();
  const skipped = { vector_id: vectorId, persisted: false };
  if (!env.MEMORY_INDEX || memory.stillValid?.() === false) return skipped;
  if (
    sql
      .exec(
        "SELECT vector_id FROM memory_tombstones WHERE vector_id = ?",
        vectorId,
      )
      .toArray().length
  )
    return skipped;
  const attemptId = crypto.randomUUID();
  // These synchronous statements precede embedding and every publication await.
  sql.exec(
    "INSERT OR IGNORE INTO memory_write_scopes (vector_id, user_namespace) VALUES (?, ?)",
    vectorId,
    buildNamespace(memory.user_id, memory.tenant_binding),
  );
  indexMemory(sql, {
    vector_id: vectorId,
    type: memory.type,
    content: memory.content,
    conversation_id: memory.conversation_id,
  });
  sql.exec(
    "INSERT OR REPLACE INTO memory_pending_writes (vector_id, attempt_id, retry_task_id, started_at) VALUES (?, ?, ?, ?)",
    vectorId,
    attemptId,
    args.retryTaskId ?? null,
    Date.now(),
  );
  const valid = () =>
    memory.stillValid?.() !== false &&
    sql
      .exec(
        `SELECT memory_index.vector_id FROM memory_index JOIN memory_pending_writes USING (vector_id)
     WHERE memory_index.vector_id = ? AND attempt_id = ? AND deleting_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM memory_tombstones WHERE vector_id = ?)`,
        vectorId,
        attemptId,
        vectorId,
      )
      .toArray().length === 1;
  const compensate = async () => {
    // Forget-all may already have removed the initial journal and locator while
    // an R2 put was suspended. Recreate cleanup ownership before compensation.
    markMemoriesForDeletion(sql, [vectorId]);
    sql.exec("DELETE FROM memory_pending_writes WHERE vector_id = ?", vectorId);
    args.onDeletionPending?.();
    try {
      await deleteOwnedMemoryVectors(env, sql, [vectorId]);
      removeIndexedMemories(sql, [vectorId]);
    } catch (error) {
      logWarn("Memory publication compensation remains pending", {
        "error.message": error instanceof Error ? error.message : String(error),
      });
    }
  };
  try {
    const result = await writeMemory(env, {
      ...memory,
      vector_id: vectorId,
      stillValid: valid,
      deferCompensationToOwner: true,
    });
    if (!result.persisted || !valid()) {
      await compensate();
      return skipped;
    }
    // No asynchronous work is allowed between validity, local effects and
    // publication. This also keeps summary provenance and cursor authoritative.
    args.onCommit?.(vectorId);
    sql.exec(
      "DELETE FROM memory_pending_writes WHERE vector_id = ? AND attempt_id = ?",
      vectorId,
      attemptId,
    );
    return result;
  } catch (error) {
    // Valid durable tasks retain the exact pending ID for their existing retry.
    // Every other outcome retains a durable deletion marker until purge succeeds.
    if (!args.retryTaskId || !valid()) await compensate();
    throw error;
  }
}

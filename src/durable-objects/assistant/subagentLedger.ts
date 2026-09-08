/**
 * Durable state for DurableClaw's subagent tasks.
 *
 * The row set is also the concurrency semaphore: the number of rows
 * currently dispatched or running IS the number of slots in use. There is
 * no separate counter, so there is nothing to drift out of sync after an
 * eviction, a crash, or a duplicate callback.
 *
 * Pure functions over an injected SQL runner, `now` passed in rather than
 * read, matching `assistant/memory.ts` and `assistant/scheduler.ts`.
 */
import type { SqlExecLike } from "./memory";

export type SubagentTier = "foreground" | "background";

export type SubagentStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "done"
  | "failed"
  | "timeout"
  | "cancelled";

/** Statuses from which no further transition is allowed. */
const TERMINAL: readonly SubagentStatus[] = [
  "done",
  "failed",
  "timeout",
  "cancelled",
];

/**
 * Statuses that hold a concurrency slot. Deliberately excludes `queued`: a
 * task waits in `queued` for a slot, it does not hold one.
 *
 * If `queued` counted here, a batch of >= cap tasks — every one born
 * `queued` — would make `cap - inFlightCount(sql)` zero before a single
 * task ever dispatched, and `claimSlots` would return `[]` forever. A
 * full-size batch would deadlock against its own cap instead of draining in
 * rounds as `claimSlots`'s own contract promises.
 */
const IN_FLIGHT_STATUSES: readonly SubagentStatus[] = ["dispatched", "running"];

/**
 * Per-user ceiling on concurrent subagents, from issue #293. Per user, so it
 * bounds one user's blast radius; global load is bounded separately by the
 * daily budget counters introduced in Stage 2.
 */
export const MAX_CONCURRENT_SUBAGENTS = 100;

export interface SubagentTask {
  task_id: string;
  batch_id: string;
  origin: string;
  conversation_id: string | null;
  goal: string;
  tier: SubagentTier;
  toolset: string;
  status: SubagentStatus;
  attempt: number;
  result_json: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  deadline_at: number;
  tokens_in: number | null;
  tokens_out: number | null;
}

export function insertBatch(
  sql: SqlExecLike,
  args: {
    batch_id: string;
    origin: string;
    conversation_id: string | null;
    toolset: string[];
    deadline_at: number;
    now: number;
    tasks: Array<{ task_id: string; goal: string; tier: SubagentTier }>;
  },
): void {
  const toolsetJson = JSON.stringify(args.toolset);
  for (const task of args.tasks) {
    sql.exec(
      `INSERT INTO subagent_tasks
         (task_id, batch_id, origin, conversation_id, goal, tier, toolset,
          status, attempt, created_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
      task.task_id,
      args.batch_id,
      args.origin,
      args.conversation_id,
      task.goal,
      task.tier,
      toolsetJson,
      args.now,
      args.deadline_at,
    );
  }
}

/**
 * Take up to `limit` queued tasks, never exceeding `cap` in flight, and mark
 * them dispatched.
 *
 * This is the whole enforcement of the concurrency cap. Callers drain it
 * repeatedly as slots free rather than fanning out once, so a batch larger
 * than the cap still completes — it just takes more rounds. The cap is
 * checked against `inFlightCount` (dispatched + running only, see
 * `IN_FLIGHT_STATUSES`) rather than every non-terminal row, precisely so a
 * batch bigger than the cap can make progress at all instead of
 * deadlocking against its own backlog.
 *
 * `now` stamps `started_at` on every row it claims, so the ledger records
 * when a task actually entered flight rather than leaving the column null
 * for its whole life.
 */
export function claimSlots(
  sql: SqlExecLike,
  args: { cap: number; limit: number; now: number },
): SubagentTask[] {
  const free = Math.max(0, args.cap - inFlightCount(sql));
  const take = Math.min(free, args.limit);
  if (take <= 0) return [];

  // One conditional update performs the claim without a read/update per row.
  // SQL is synchronous in a DO, so count + claim cannot interleave with another
  // event. RETURNING ordering is unspecified; restore the dispatch FIFO below.
  const rows = sql
    .exec(
      `UPDATE subagent_tasks SET status = 'dispatched', started_at = ?
      WHERE status = 'queued' AND task_id IN (
        SELECT task_id FROM subagent_tasks WHERE status = 'queued'
        ORDER BY created_at ASC, task_id ASC LIMIT ?
      ) RETURNING *`,
      args.now,
      take,
    )
    .toArray() as unknown as SubagentTask[];
  return rows.sort(
    (a, b) =>
      a.created_at - b.created_at ||
      (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0),
  );
}

/**
 * Move a task to a terminal state. Compare-and-swap on the current status.
 *
 * Returns true ONLY for the call that actually transitioned the row. The
 * subagent calls back over the network, so a retry will arrive for a task
 * that is already settled; the caller uses this boolean to decide whether to
 * advance batch state, which is what stops a duplicate callback from
 * double-counting a batch into premature synthesis.
 */
export function settleTask(
  sql: SqlExecLike,
  args: {
    task_id: string;
    status: Extract<
      SubagentStatus,
      "done" | "failed" | "timeout" | "cancelled"
    >;
    result_json?: string;
    error?: string;
    tokens_in?: number;
    tokens_out?: number;
    now: number;
  },
): boolean {
  const changed = sql
    .exec(
      `UPDATE subagent_tasks
        SET status = ?, result_json = ?, error = ?, tokens_in = ?,
            tokens_out = ?, finished_at = ?
      WHERE task_id = ? AND status IN ('queued', 'dispatched', 'running')
      RETURNING task_id`,
      args.status,
      args.result_json ?? null,
      args.error ?? null,
      args.tokens_in ?? null,
      args.tokens_out ?? null,
      args.now,
      args.task_id,
    )
    .toArray();
  return changed.length === 1;
}

/**
 * Time out every non-terminal task in a batch past its deadline.
 *
 * The conditional update settles only live rows. SQLite tests exercise the
 * same SQL and RETURNING semantics as the Durable Object storage engine.
 */
export function sweepTimeouts(
  sql: SqlExecLike,
  args: { batch_id: string; now: number },
): number {
  return sql
    .exec(
      `UPDATE subagent_tasks
        SET status = 'timeout', result_json = NULL, error = ?,
            tokens_in = NULL, tokens_out = NULL, finished_at = ?
      WHERE batch_id = ? AND deadline_at <= ?
        AND status IN ('queued', 'dispatched', 'running')
      RETURNING task_id`,
      "Subagent exceeded its deadline",
      args.now,
      args.batch_id,
      args.now,
    )
    .toArray().length;
}

export function batchState(
  sql: SqlExecLike,
  batch_id: string,
): { total: number; settled: number; results: SubagentTask[] } {
  const results = sql
    .exec(
      `SELECT * FROM subagent_tasks WHERE batch_id = ? ORDER BY created_at ASC`,
      batch_id,
    )
    .toArray() as unknown as SubagentTask[];
  return {
    total: results.length,
    settled: results.filter((r) => TERMINAL.includes(r.status)).length,
    results,
  };
}

/**
 * How many slots are currently occupied — dispatched or running — across
 * every batch for this user.
 *
 * Deliberately does NOT count `queued`: see `IN_FLIGHT_STATUSES`. A queued
 * task is waiting for a slot, not holding one; counting it here would make
 * a batch at or above the cap unable to ever dispatch its first task. This
 * is the semaphore read — `claimSlots` calls it rather than duplicating the
 * query privately, so there is exactly one definition of "occupied" and the
 * tests that pin this function's behaviour also pin the cap's.
 */
export function inFlightCount(sql: SqlExecLike): number {
  const rows = sql
    .exec(
      "SELECT COUNT(*) AS count FROM subagent_tasks WHERE status IN (?, ?)",
      ...IN_FLIGHT_STATUSES,
    )
    .toArray() as unknown as Array<{ count: number }>;
  return rows[0]?.count ?? 0;
}

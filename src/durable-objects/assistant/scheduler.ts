/**
 * The job queue behind NanoChatAgent's alarm multiplexer.
 *
 * A Durable Object has exactly one alarm slot. Summarization used to own it
 * outright; summarization, proactive wakes, dreaming, provider batch work,
 * cleanup, and subagent deadline/synthesis jobs now share it. To coordinate
 * `setAlarm`, they each write a row here and the DO's `alarm()` runs
 * whatever is due and re-arms for the next earliest `run_at`.
 *
 * Every function is pure over an injected SQL runner and takes `now` as a
 * parameter rather than reading the clock, so tests control time without
 * faking timers.
 */
import type { SqlExecLike } from "./memory";

export type JobKind =
  | "summarize"
  | "wake"
  | "dream"
  | "housekeeping"
  | "housekeeping_cleanup"
  | "batch_deadline"
  | "batch_synthesis"
  | "subagent_cancel"
  | "subagent_dispatch"
  | "scheduled_task";

export interface ScheduledJob {
  job_id: string;
  kind: JobKind;
  run_at: number;
  payload_json: string | null;
  created_at: number;
}

/**
 * Insert or move a job. Keyed on `job_id`, so a caller that re-schedules the
 * same logical job (a debounced summarization, the next wake) overwrites its
 * own row instead of stacking duplicates — which is what stops a chatty
 * conversation from queueing dozens of identical summarize jobs.
 */
export function scheduleJob(
  sql: SqlExecLike,
  args: {
    job_id: string;
    kind: JobKind;
    run_at: number;
    payload?: unknown;
    now: number;
  },
): void {
  sql.exec(
    `INSERT INTO scheduled_jobs (job_id, kind, run_at, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET
       kind = excluded.kind,
       run_at = excluded.run_at,
       payload_json = excluded.payload_json`,
    args.job_id,
    args.kind,
    args.run_at,
    args.payload === undefined ? null : JSON.stringify(args.payload),
    args.now,
  );
}

/**
 * Jobs whose time has come, earliest first.
 *
 * `limit` is not optional by accident: alarms must complete in bounded time,
 * so the dispatcher takes a fixed slice per pass and leaves the rest for the
 * next one rather than running an unbounded queue in a single alarm.
 */
export function dueJobs(
  sql: SqlExecLike,
  now: number,
  limit: number,
): ScheduledJob[] {
  return sql
    .exec(
      `SELECT job_id, kind, run_at, payload_json, created_at
         FROM scheduled_jobs
        WHERE run_at <= ?
        ORDER BY run_at ASC
        LIMIT ?`,
      now,
      limit,
    )
    .toArray() as unknown as ScheduledJob[];
}

/**
 * The timestamp the DO's alarm should be re-armed for, or null if idle.
 *
 * Written as `ORDER BY run_at ASC LIMIT 1` rather than `MIN(run_at)` — same
 * result (including the empty-queue `null`), but every caller of this module
 * only ever touches a handful of rows per user, so there's no cost to
 * preferring the plain-select shape the row-oriented helpers already use.
 */
export function nextRunAt(sql: SqlExecLike): number | null {
  const rows = sql
    .exec(`SELECT run_at FROM scheduled_jobs ORDER BY run_at ASC LIMIT 1`)
    .toArray() as unknown as Array<{ run_at: number }>;
  return rows[0]?.run_at ?? null;
}

/**
 * Drop jobs by kind or by id. Returns how many rows went.
 *
 * Selects the matching ids before deleting rather than counting rows before
 * and after — same result, one fewer round trip, and the returned count
 * comes straight from the set that was actually deleted instead of being
 * inferred from a before/after difference.
 */
export function cancelJobs(
  sql: SqlExecLike,
  filter: { kind?: JobKind; job_id?: string },
): number {
  if (filter.job_id) {
    const matched = sql
      .exec(`SELECT job_id FROM scheduled_jobs WHERE job_id = ?`, filter.job_id)
      .toArray();
    sql.exec(`DELETE FROM scheduled_jobs WHERE job_id = ?`, filter.job_id);
    return matched.length;
  }
  if (filter.kind) {
    const matched = sql
      .exec(`SELECT job_id FROM scheduled_jobs WHERE kind = ?`, filter.kind)
      .toArray();
    sql.exec(`DELETE FROM scheduled_jobs WHERE kind = ?`, filter.kind);
    return matched.length;
  }
  return 0;
}

/** Remove a single completed one-shot job. */
export function deleteJob(sql: SqlExecLike, job_id: string): void {
  sql.exec(`DELETE FROM scheduled_jobs WHERE job_id = ?`, job_id);
}

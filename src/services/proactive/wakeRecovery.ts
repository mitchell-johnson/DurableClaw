import type { SqlExecLike } from "../../durable-objects/assistant/memory";
import {
  readObserverCursor,
  writeObserverCursor,
  deleteObserverCursor,
} from "./cursors";

export const WAKE_RECOVERY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS observer_baselines (
  source_key TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS wake_observation_windows (
  run_id TEXT PRIMARY KEY,
  cursors_before_json TEXT NOT NULL,
  phase TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wake_admissions (
  run_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL UNIQUE,
  task_count INTEGER NOT NULL,
  day_utc TEXT NOT NULL
);
`;

export function beginWakeObservation(
  sql: SqlExecLike,
  runId: string,
  observerNames: string[],
): void {
  const before = Object.fromEntries(
    observerNames.map((name) => [name, readObserverCursor(sql, name)]),
  );
  sql.exec(
    "INSERT INTO wake_observation_windows (run_id,cursors_before_json,phase) VALUES (?,?,'observing')",
    runId,
    JSON.stringify(before),
  );
}
export function setWakeObservationPhase(
  sql: SqlExecLike,
  runId: string,
  phase: "triage" | "publishing",
): void {
  sql.exec(
    "UPDATE wake_observation_windows SET phase=? WHERE run_id=?",
    phase,
    runId,
  );
}
export function finishWakeObservation(sql: SqlExecLike, runId: string): void {
  sql.exec("DELETE FROM wake_observation_windows WHERE run_id=?", runId);
}

/** Runs synchronously in the owner's storage transaction. Publication is never blindly replayed. */
export function settleInterruptedWake(
  sql: SqlExecLike,
  runId: string,
  now: number,
  error: string,
): void {
  const run = sql
    .exec(
      "SELECT status,batch_id,signals_json FROM wake_runs WHERE run_id=?",
      runId,
    )
    .toArray()[0] as Record<string, unknown> | undefined;
  if (!run) return;
  if (run.batch_id) {
    // An admitted batch owns delivery, even when the triage provider failed afterwards.
    if (run.status === "running" || run.status === "awaiting_batch")
      sql.exec(
        "UPDATE wake_runs SET status='awaiting_batch',error=? WHERE run_id=?",
        error,
        runId,
      );
    finishWakeObservation(sql, runId);
    return;
  }
  const window = sql
    .exec("SELECT * FROM wake_observation_windows WHERE run_id=?", runId)
    .toArray()[0] as Record<string, unknown> | undefined;
  const uncertain = window?.phase === "publishing";
  if (window && !uncertain) {
    const before = JSON.parse(String(window.cursors_before_json)) as Record<
      string,
      string | null
    >;
    for (const [name, value] of Object.entries(before)) {
      if (value === null) deleteObserverCursor(sql, name);
      else writeObserverCursor(sql, name, value, now);
    }
    const signals = JSON.parse(String(run.signals_json || "[]")) as Array<{
      dedupe_key: string;
    }>;
    for (const signal of signals)
      sql.exec(
        "DELETE FROM wake_signals_seen WHERE dedupe_key=?",
        signal.dedupe_key,
      );
  }
  sql.exec(
    "UPDATE wake_runs SET status='failed',error=?,completed_at=? WHERE run_id=?",
    uncertain
      ? `${error}; output may be incomplete and will not be replayed.`
      : error,
    now,
    runId,
  );
  finishWakeObservation(sql, runId);
}
export function recoverInterruptedWakes(sql: SqlExecLike, now: number): void {
  const pending = sql
    .exec("SELECT run_id FROM wake_observation_windows")
    .toArray() as Array<{ run_id: string }>;
  for (const row of pending)
    settleInterruptedWake(
      sql,
      String(row.run_id),
      now,
      "Wake triage interrupted by restart",
    );
  // Pre-recovery-schema runs lack a safe rollback window. Retain their consumption state.
  sql.exec(
    "UPDATE wake_runs SET status='failed',error='Wake interrupted without a recoverable observation window',completed_at=? WHERE status='running' AND batch_id IS NULL",
    now,
  );
}

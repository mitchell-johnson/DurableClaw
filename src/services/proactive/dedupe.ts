import type { SqlExecLike } from "../../durable-objects/assistant/memory";
import type { Env } from "../../types/env";
import type { Signal } from "./types";
export const SIGNAL_DEDUPE_TTL_MS_DEFAULT = 7 * 24 * 60 * 60 * 1000;
export function resolveSignalDedupeTtlMs(
  env: Pick<Env, "WAKE_SIGNAL_DEDUPE_TTL_HOURS">,
): number {
  const raw = env.WAKE_SIGNAL_DEDUPE_TTL_HOURS;
  if (raw) {
    const hours = Number.parseInt(raw, 10);
    if (Number.isInteger(hours) && hours > 0) return hours * 60 * 60 * 1000;
  }
  return SIGNAL_DEDUPE_TTL_MS_DEFAULT;
}
export function sweepExpiredSignals(sql: SqlExecLike, nowMs: number): number {
  const expired = sql
    .exec(
      `SELECT dedupe_key FROM wake_signals_seen WHERE expires_at <= ?`,
      nowMs,
    )
    .toArray();
  sql.exec(`DELETE FROM wake_signals_seen WHERE expires_at <= ?`, nowMs);
  return expired.length;
}
export function filterLiveSignals(
  sql: SqlExecLike,
  signals: Signal[],
): Signal[] {
  const fresh: Signal[] = [];
  for (const signal of signals) {
    const rows = sql
      .exec(
        `SELECT dedupe_key FROM wake_signals_seen WHERE dedupe_key = ?`,
        signal.dedupe_key,
      )
      .toArray();
    if (rows.length === 0) fresh.push(signal);
  }
  return fresh;
}
export function recordSignals(
  sql: SqlExecLike,
  signals: Signal[],
  nowMs: number,
  ttlMs: number,
): void {
  for (const signal of signals) {
    sql.exec(
      `INSERT INTO wake_signals_seen (dedupe_key, first_seen_at, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         first_seen_at = excluded.first_seen_at,
         expires_at = excluded.expires_at`,
      signal.dedupe_key,
      nowMs,
      nowMs + ttlMs,
    );
  }
}

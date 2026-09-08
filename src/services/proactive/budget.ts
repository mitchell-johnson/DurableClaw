import type { SqlExecLike } from "../../durable-objects/assistant/memory";
import type { Env } from "../../types/env";
export const MAX_DAILY_TRIAGE_TURNS_DEFAULT = 20;
export const MAX_DAILY_SUBAGENT_SPAWNS_DEFAULT = 100;
function readPositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}
export interface DurableClawBudgetLimits {
  maxTriageTurns: number;
  maxSubagentSpawns: number;
}
export function resolveBudgetLimits(
  env: Pick<
    Env,
    "WAKE_MAX_DAILY_TRIAGE_TURNS" | "WAKE_MAX_DAILY_SUBAGENT_SPAWNS"
  >,
): DurableClawBudgetLimits {
  return {
    maxTriageTurns:
      readPositiveInt(env.WAKE_MAX_DAILY_TRIAGE_TURNS) ??
      MAX_DAILY_TRIAGE_TURNS_DEFAULT,
    maxSubagentSpawns:
      readPositiveInt(env.WAKE_MAX_DAILY_SUBAGENT_SPAWNS) ??
      MAX_DAILY_SUBAGENT_SPAWNS_DEFAULT,
  };
}
export function dayUtc(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
export interface DailyUsage {
  triage_turns: number;
  subagent_spawns: number;
}
export function readDailyUsage(sql: SqlExecLike, day: string): DailyUsage {
  const rows = sql
    .exec(
      `SELECT triage_turns, subagent_spawns FROM agent_usage WHERE day_utc = ?`,
      day,
    )
    .toArray() as unknown as Array<{
    triage_turns: number;
    subagent_spawns: number;
  }>;
  const row = rows[0];
  return {
    triage_turns: typeof row?.triage_turns === "number" ? row.triage_turns : 0,
    subagent_spawns:
      typeof row?.subagent_spawns === "number" ? row.subagent_spawns : 0,
  };
}
export function bumpDailyUsage(
  sql: SqlExecLike,
  day: string,
  delta: {
    triageTurns?: number;
    subagentSpawns?: number;
  },
): void {
  if (!delta.triageTurns && !delta.subagentSpawns) return;
  const current = readDailyUsage(sql, day);
  const next = {
    triage_turns: current.triage_turns + (delta.triageTurns ?? 0),
    subagent_spawns: current.subagent_spawns + (delta.subagentSpawns ?? 0),
  };
  const existing = sql
    .exec(`SELECT day_utc FROM agent_usage WHERE day_utc = ?`, day)
    .toArray();
  if (existing.length === 0) {
    sql.exec(
      `INSERT INTO agent_usage (day_utc, triage_turns, subagent_spawns) VALUES (?, ?, ?)`,
      day,
      next.triage_turns,
      next.subagent_spawns,
    );
  } else {
    sql.exec(
      `UPDATE agent_usage SET triage_turns = ?, subagent_spawns = ? WHERE day_utc = ?`,
      next.triage_turns,
      next.subagent_spawns,
      day,
    );
  }
}

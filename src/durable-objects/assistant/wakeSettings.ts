export const DEFAULT_WAKE_INTERVAL_MINUTES = 60;
export const WAKE_INTERVAL_MINUTES = [
  10, 15, 20, 30, 45, 60, 120, 240, 720, 1440,
] as const;
export type WakeIntervalMinutes = (typeof WAKE_INTERVAL_MINUTES)[number];
export function isWakeIntervalMinutes(
  value: unknown,
): value is WakeIntervalMinutes {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (WAKE_INTERVAL_MINUTES as readonly number[]).includes(value)
  );
}
export const WAKE_JOB_ID = "wake";
const MINUTE_MS = 60000;
export function computeNextWakeAt(
  nowMs: number,
  intervalMinutes: WakeIntervalMinutes,
): number {
  return nowMs + intervalMinutes * MINUTE_MS;
}
export const WAKE_GRACE_FLOOR_MS = 15 * MINUTE_MS;
export function wakeGraceWindowMs(intervalMinutes: number | null): number {
  if (intervalMinutes === null || !isWakeIntervalMinutes(intervalMinutes)) {
    return WAKE_GRACE_FLOOR_MS;
  }
  return Math.max(WAKE_GRACE_FLOOR_MS, 2 * intervalMinutes * MINUTE_MS);
}
export function isProactiveDisabled(env: {
  PROACTIVE_DISABLED?: string;
}): boolean {
  return env.PROACTIVE_DISABLED === "true";
}
export interface WakeRegistryKey {
  do_name: string;
  user_id: string;
  org_id: string;
}
export interface WakeRegistryStore {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
    };
  };
}
export async function upsertWakeRegistry(
  db: WakeRegistryStore,
  key: WakeRegistryKey,
  nextWakeAt: number,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agent_wake_registry (do_name, user_id, org_id, next_wake_at, enabled, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(do_name) DO UPDATE SET
         user_id = excluded.user_id,
         org_id = excluded.org_id,
         next_wake_at = excluded.next_wake_at,
         enabled = 1,
         updated_at = excluded.updated_at`,
    )
    .bind(key.do_name, key.user_id, key.org_id, nextWakeAt, nowMs)
    .run();
}
export async function disableWakeRegistry(
  db: WakeRegistryStore,
  do_name: string,
  nowMs: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE agent_wake_registry
          SET enabled = 0, next_wake_at = NULL, updated_at = ?
        WHERE do_name = ?`,
    )
    .bind(nowMs, do_name)
    .run();
}
export async function deleteWakeRegistry(
  db: WakeRegistryStore,
  do_name: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM agent_wake_registry WHERE do_name = ?`)
    .bind(do_name)
    .run();
}

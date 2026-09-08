import type { SqlExecLike } from "../../durable-objects/assistant/memory";
export function readObserverCursor(
  sql: SqlExecLike,
  observerName: string,
): string | null {
  const rows = sql
    .exec(
      `SELECT cursor_value FROM observer_cursors WHERE observer_name = ? LIMIT 1`,
      observerName,
    )
    .toArray() as unknown as Array<{
    cursor_value: string;
  }>;
  return rows[0]?.cursor_value ?? null;
}
export function writeObserverCursor(
  sql: SqlExecLike,
  observerName: string,
  cursorValue: string,
  nowMs: number,
): void {
  sql.exec(
    `INSERT INTO observer_cursors (observer_name, cursor_value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(observer_name) DO UPDATE SET
       cursor_value = excluded.cursor_value,
       updated_at = excluded.updated_at`,
    observerName,
    cursorValue,
    nowMs,
  );
}
export function deleteObserverCursor(
  sql: SqlExecLike,
  observerName: string,
): void {
  sql.exec(
    `DELETE FROM observer_cursors WHERE observer_name = ?`,
    observerName,
  );
}

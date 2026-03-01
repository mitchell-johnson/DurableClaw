/**
 * SQLite schema initialization for NanoChatAgent.
 *
 * Creates application-specific tables for group memory and execution logging.
 * The messages table is managed internally by the Agents SDK (cf_agents_state).
 */

/**
 * Initialize the SQLite schema for the NanoChatAgent Durable Object.
 *
 * Tables:
 *   - group_memory: persistent key-value store per conversation group
 *   - execution_log: audit trail of all tool executions
 *
 * Uses IF NOT EXISTS so this is safe to call on every instantiation.
 */
export function initSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS group_memory (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS execution_log (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    )
  `);
}

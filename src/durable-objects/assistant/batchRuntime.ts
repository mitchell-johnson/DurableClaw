/** Durable delivery/cancellation state around the disposable task ledger. */
export const BATCH_RUNTIME_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_page_context (
  conversation_id TEXT PRIMARY KEY,
  context_block TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subagent_batches (
  batch_id TEXT PRIMARY KEY,
  conversation_id TEXT,
  request_id TEXT,
  origin TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_batches_conversation ON subagent_batches(conversation_id, status);
CREATE TABLE IF NOT EXISTS subagent_cancellations (
  task_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

export interface SubagentBatchRecord {
  batch_id: string;
  conversation_id: string | null;
  request_id: string | null;
  origin: string;
  status: "active" | "synthesizing" | "completed" | "cancelled" | "failed";
  created_at: number;
  finished_at: number | null;
}

export const BATCH_RETRY_MS = 30_000;
export const MAX_BATCH_ATTEMPTS = 5;
export const BATCH_RETENTION_MS = 24 * 60 * 60 * 1000;
export const SUBAGENT_CANCEL_JOB_ID = "subagent_cancel";

/**
 * SQLite-backed tool-confirmations store for AssistantAgent (server-side authorization).
 *
 * Implements the `ToolConfirmationCoordinator` contract from
 * `action-library/confirmations` over the owning DO's SQLite storage, so
 * confirmation state survives hibernation and is judged server-side only.
 *
 * Lifecycle: `issue` (preview phase) inserts a `pending` row carrying the
 * tool name and the canonical-args hash; only the session-bound HTTP decision
 * endpoint may flip it `pending -> approved` (CAS); `consume` wins exactly
 * once per record via a guarded UPDATE, so a single approval can power at
 * most one execution. Any mismatch — wrong tool, different arguments, an
 * expired or already-consumed record, or a status that is not `approved` —
 * reads as not-executable and the tool re-runs its preview phase.
 */

import type {
  ToolConfirmationCoordinator,
  ConfirmationIssueArgs,
  ConfirmationVerifyArgs,
} from "../../action-library/confirmations";

/** Maximum life of a pending confirmation. The decider caps this at 10 minutes. */
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

/** Minimal shape both workerd's SqlStorage and the test mocks expose. */
export interface SqlLike {
  exec(sql: string, ...params: unknown[]): { toArray(): unknown[] };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tool_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  args_hash       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  approved_at     INTEGER,
  consumed_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_confirmations_conversation ON tool_confirmations(conversation_id);
CREATE INDEX IF NOT EXISTS idx_confirmations_expiry ON tool_confirmations(expires_at);
`;

/** Idempotent DDL, run by the DO's schema migration to v7. */
export function ensureToolConfirmationsSchema(sql: SqlLike): void {
  sql.exec(SCHEMA_SQL);
}

interface ConfirmationRow {
  confirmation_id: string;
  conversation_id: string;
  tool_name: string;
  args_hash: string;
  status: "pending" | "approved" | "declined";
  created_at: number;
  expires_at: number;
  approved_at: number | null;
  consumed_at: number | null;
}

function readRow(sql: SqlLike, confirmationId: string): ConfirmationRow | null {
  const rows = sql
    .exec(
      "SELECT * FROM tool_confirmations WHERE confirmation_id = ? LIMIT 1",
      confirmationId,
    )
    .toArray() as unknown as ConfirmationRow[];
  return rows[0] ?? null;
}

/** Drop expired records so the table cannot grow without bound. */
function sweepExpired(sql: SqlLike, now: number): void {
  sql.exec("DELETE FROM tool_confirmations WHERE expires_at < ?", now);
}

export function issueToolConfirmation(
  sql: SqlLike,
  args: ConfirmationIssueArgs,
  now: number,
): string {
  sweepExpired(sql, now);
  const confirmationId = crypto.randomUUID();
  sql.exec(
    `INSERT INTO tool_confirmations
       (confirmation_id, conversation_id, tool_name, args_hash, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    confirmationId,
    args.conversationId,
    args.toolName,
    args.argsHash,
    now,
    now + CONFIRMATION_TTL_MS,
  );
  return confirmationId;
}

/**
 * CAS `pending -> approved`. Returns false when the record was already
 * decided (approved/declined), expired, or never existed. This is the ONLY
 * path to `approved`, and it is reachable exclusively from the DO's decision
 * endpoint behind the session-authenticated route.
 */
export function decideToolConfirmation(
  sql: SqlLike,
  confirmationId: string,
  decision: "confirmed" | "declined",
  now: number,
): boolean {
  const row = readRow(sql, confirmationId);
  if (!row) return false;
  if (row.status !== "pending") return false;
  if (row.expires_at <= now) return false;

  const nextStatus = decision === "confirmed" ? "approved" : "declined";
  // Guarded UPDATE: the WHERE clause makes the transition compare-and-swap.
  // A racing caller loses here rather than double-writing. Status values are
  // bound parameters, not interpolated literals.
  sql.exec(
    "UPDATE tool_confirmations SET status = ?, approved_at = ? WHERE confirmation_id = ? AND status = ?",
    nextStatus,
    now,
    confirmationId,
    "pending",
  );
  const after = readRow(sql, confirmationId);
  return after?.status === nextStatus && after.approved_at === now;
}

/**
 * Verify every dimension of the stored record against what the model just
 * presented, WITHOUT consuming. Fails closed on any mismatch.
 */
export function isToolConfirmationExecutable(
  sql: SqlLike,
  args: ConfirmationVerifyArgs,
  now: number,
): boolean {
  const row = readRow(sql, args.confirmationId);
  if (!row) return false;
  // Nullish-safe reads: an unset column may surface as null OR undefined
  // depending on driver/mock, and both must read as "not yet set".
  if ((row.consumed_at ?? null) !== null) return false;
  if (row.status !== "approved" || (row.approved_at ?? null) === null)
    return false;
  if (row.expires_at <= now) return false;
  if (row.conversation_id !== args.conversationId) return false;
  if (row.tool_name !== args.toolName) return false;
  if (row.args_hash !== args.argsHash) return false;
  return true;
}

/**
 * Atomically mark a verified record consumed. The WHERE guard means two
 * concurrent executes race on one UPDATE and at most one sees the row flip;
 * the read-back confirms THIS call won it.
 */
export function consumeToolConfirmation(
  sql: SqlLike,
  confirmationId: string,
  now: number,
): boolean {
  return (
    sql
      .exec(
        "UPDATE tool_confirmations SET consumed_at = ? WHERE confirmation_id = ? AND consumed_at IS NULL AND status = ? AND expires_at > ? RETURNING confirmation_id",
        now,
        confirmationId,
        "approved",
        now,
      )
      .toArray().length === 1
  );
}

/** Bind the pure helpers into the interface confirm tools receive. */
export function makeSqliteConfirmationCoordinator(
  sql: SqlLike,
): ToolConfirmationCoordinator {
  const now = () => Date.now();
  return {
    issue: async (args) => issueToolConfirmation(sql, args, now()),
    isExecutable: async (args: ConfirmationVerifyArgs) =>
      isToolConfirmationExecutable(sql, args, now()),
    consume: async (confirmationId) =>
      consumeToolConfirmation(sql, confirmationId, now()),
  };
}

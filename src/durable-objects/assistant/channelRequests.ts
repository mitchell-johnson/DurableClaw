import type { SqlLike } from "./toolConfirmations";

export function ensureChannelRequests(sql: SqlLike): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS channel_requests (
    request_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
    args_hash TEXT NOT NULL, reply TEXT, created_at INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS channel_requests_created ON channel_requests(created_at);`);
}

/** A pending receipt is deliberately never re-executed after ambiguous failure. */
export function claimChannelRequest(
  sql: SqlLike,
  requestId: string,
  conversationId: string,
  argsHash: string,
):
  | { status: "claimed" }
  | { status: "complete"; text: string }
  | { status: "conflict" } {
  ensureChannelRequests(sql);
  const prior = sql
    .exec("SELECT * FROM channel_requests WHERE request_id=?", requestId)
    .toArray()[0] as
    | { conversation_id: string; args_hash: string; reply: string | null }
    | undefined;
  if (prior) {
    if (
      prior.conversation_id !== conversationId ||
      prior.args_hash !== argsHash ||
      prior.reply === null
    )
      return { status: "conflict" };
    return { status: "complete", text: prior.reply };
  }
  // Keep a bounded receipt window; provider-side deduplication is also required.
  sql.exec(
    "DELETE FROM channel_requests WHERE request_id IN (SELECT request_id FROM channel_requests ORDER BY created_at DESC LIMIT -1 OFFSET 999)",
  );
  sql.exec(
    "INSERT INTO channel_requests(request_id,conversation_id,args_hash,created_at) VALUES (?,?,?,?)",
    requestId,
    conversationId,
    argsHash,
    Date.now(),
  );
  return { status: "claimed" };
}

export function completeChannelRequest(
  sql: SqlLike,
  requestId: string,
  text: string,
): void {
  sql.exec(
    "UPDATE channel_requests SET reply=? WHERE request_id=? AND reply IS NULL",
    text.slice(0, 16000),
    requestId,
  );
}

/** Durable outbox for DurableClaw's deferred model work. No model call waits for inference. */
import {
  createBatch,
  getBatch,
  batchResultText,
  isBatchTerminal,
  batchRequestByteLength,
  MAX_BATCH_REQUEST_BYTES,
  MAX_BATCH_REQUESTS,
  type BatchRequest,
  type BatchEnv,
} from "../../utils/openrouterBatch";
import type { SqlExecLike } from "./memory";
import { logWarn } from "../../telemetry/logger";

export const HOUSEKEEPING_JOB_ID = "housekeeping";
export const HOUSEKEEPING_POLL_MS = 5 * 60 * 1000;
const MAX_PENDING_TASKS = 500;
const MAX_TASK_AGE_MS = 48 * 60 * 60 * 1000;

export const HOUSEKEEPING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS housekeeping_tasks (
  task_id TEXT PRIMARY KEY,
  task_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  conversation_id TEXT,
  payload_json TEXT NOT NULL,
  request_json TEXT NOT NULL,
  batch_id TEXT,
  state TEXT NOT NULL,
  result_text TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  next_run_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_housekeeping_due ON housekeeping_tasks(next_run_at);
CREATE INDEX IF NOT EXISTS idx_housekeeping_conversation ON housekeeping_tasks(conversation_id);
`;

export interface HousekeepingTask {
  task_id: string;
  task_key: string;
  kind: "title" | "raw" | "summary" | "dream";
  conversation_id: string | null;
  payload_json: string;
  request_json: string;
  batch_id: string | null;
  state: "queued" | "submitted" | "ready";
  result_text: string | null;
  attempts: number;
  created_at: number;
  next_run_at: number;
}

type TaskMetadata = Pick<
  HousekeepingTask,
  "task_id" | "state" | "batch_id" | "attempts" | "created_at" | "next_run_at"
>;
const METADATA_COLUMNS =
  "task_id, state, batch_id, attempts, created_at, next_run_at";

/** Synchronous select+insert: a repeated source never creates two local tasks. */
export function enqueueHousekeepingTask(
  sql: SqlExecLike,
  args: {
    key: string;
    kind: HousekeepingTask["kind"];
    conversationId?: string;
    payload: unknown;
    request: Omit<BatchRequest, "customId">;
    now: number;
  },
): string | null {
  const existing = sql
    .exec("SELECT task_id FROM housekeeping_tasks WHERE task_key = ?", args.key)
    .toArray()[0] as { task_id: string } | undefined;
  if (existing) return existing.task_id;
  const count = sql
    .exec("SELECT COUNT(*) AS count FROM housekeeping_tasks")
    .toArray()[0] as { count: number };
  if (count.count >= MAX_PENDING_TASKS) return null;
  const taskId = crypto.randomUUID();
  sql.exec(
    `INSERT INTO housekeeping_tasks
    (task_id, task_key, kind, conversation_id, payload_json, request_json, state, attempts, created_at, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?)`,
    taskId,
    args.key,
    args.kind,
    args.conversationId ?? null,
    JSON.stringify(args.payload),
    JSON.stringify(args.request),
    args.now,
    args.now,
  );
  return taskId;
}

export function nextHousekeepingAt(sql: SqlExecLike): number | null {
  return (
    (
      sql
        .exec(
          "SELECT next_run_at FROM housekeeping_tasks ORDER BY next_run_at LIMIT 1",
        )
        .toArray()[0] as { next_run_at: number } | undefined
    )?.next_run_at ?? null
  );
}

export function cancelHousekeepingTasks(
  sql: SqlExecLike,
  conversationId?: string,
): void {
  // Titles do not contain durable memories, but their source can also be deleted.
  if (conversationId) {
    sql.exec(
      "DELETE FROM housekeeping_tasks WHERE conversation_id = ?",
      conversationId,
    );
    // Cross-conversation insights may reference any deleted conversation.
    sql.exec("DELETE FROM housekeeping_tasks WHERE kind = 'dream'");
  } else {
    sql.exec("DELETE FROM housekeeping_tasks WHERE kind != 'title'");
  }
}

/**
 * One bounded scheduler pass. Persist a recovery deadline and arm the alarm
 * BEFORE external I/O. Provider errors retain the receipt; ready outputs
 * survive failed local writes until the hard 48-hour expiry. A provider accepting a POST whose response is
 * lost can still cause a duplicate bill on retry (the API has no idempotency
 * key); deterministic local task/output IDs prevent duplicate application.
 */
export async function runHousekeepingTasks(args: {
  sql: SqlExecLike;
  env: BatchEnv;
  now: number;
  valid: (task: HousekeepingTask) => boolean;
  apply: (
    task: HousekeepingTask,
    text: string | null,
    stillValid: () => boolean,
  ) => Promise<boolean>;
  discard?: (task: HousekeepingTask) => void;
  arm: (at: number) => Promise<void>;
}): Promise<void> {
  const { sql, now } = args;
  // A full 500-task backlog can contain hundreds of MB of prompts/sources.
  // Inspect scheduling metadata first; only selected tasks load their bodies.
  const rows = sql
    .exec(
      `SELECT ${METADATA_COLUMNS} FROM housekeeping_tasks WHERE next_run_at <= ? ORDER BY next_run_at, created_at, task_id LIMIT 500`,
      now,
    )
    .toArray() as unknown as TaskMetadata[];
  const expired = (task: TaskMetadata) =>
    now - task.created_at >= MAX_TASK_AGE_MS;
  const fallback = (task: TaskMetadata) =>
    expired(task) || (task.state === "queued" && task.attempts >= 3);
  const pending = new Map<string, TaskMetadata>();
  for (const task of rows) {
    if (fallback(task)) task.state = "ready";
    pending.set(task.task_id, task);
  }
  if (!pending.size) return;
  const load = (task: TaskMetadata) =>
    sql
      .exec("SELECT * FROM housekeeping_tasks WHERE task_id = ?", task.task_id)
      .toArray()[0] as unknown as HousekeepingTask | undefined;
  const live = (task: HousekeepingTask) =>
    sql
      .exec(
        "SELECT task_id FROM housekeeping_tasks WHERE task_id = ?",
        task.task_id,
      )
      .toArray().length > 0 && args.valid(task);
  const drop = (task: HousekeepingTask) => {
    args.discard?.(task);
    sql.exec("DELETE FROM housekeeping_tasks WHERE task_id = ?", task.task_id);
    pending.delete(task.task_id);
  };
  const markReady = (task: TaskMetadata, text: string | null) => {
    task.state = "ready";
    sql.exec(
      "UPDATE housekeeping_tasks SET state = 'ready', result_text = ? WHERE task_id = ?",
      text,
      task.task_id,
    );
  };
  const retryAt = now + HOUSEKEEPING_POLL_MS;
  const batchIds = [
    ...new Set(
      [...pending.values()]
        .filter((t) => t.state === "submitted")
        .map((t) => t.batch_id!),
    ),
  ].slice(0, 5);
  const receipts = new Map<string, TaskMetadata[]>();
  for (const batchId of batchIds) {
    // A receipt contains at most MAX_BATCH_REQUESTS tasks. Include siblings
    // whose individual due times differ so one poll collects the whole batch.
    const members = sql
      .exec(
        `SELECT ${METADATA_COLUMNS} FROM housekeeping_tasks WHERE batch_id = ? AND state = 'submitted' ORDER BY next_run_at, created_at, task_id LIMIT ?`,
        batchId,
        MAX_BATCH_REQUESTS,
      )
      .toArray() as unknown as TaskMetadata[];
    for (const task of members) {
      if (fallback(task)) task.state = "ready";
      pending.set(task.task_id, task);
    }
    receipts.set(batchId, members);
  }
  let queued: HousekeepingTask[] = [];
  let requests: BatchRequest[] = [];
  for (const metadata of [...pending.values()]
    .filter((t) => t.state === "queued")
    .slice(0, MAX_BATCH_REQUESTS)) {
    const task = load(metadata);
    if (!task) {
      pending.delete(metadata.task_id);
      continue;
    }
    if (!live(task)) {
      drop(task);
      continue;
    }
    let request: BatchRequest;
    try {
      request = { ...JSON.parse(task.request_json), customId: task.task_id };
      if (
        batchRequestByteLength([request], args.env) > MAX_BATCH_REQUEST_BYTES
      ) {
        // Retrying cannot make one oversized input fit. Use only this task's
        // existing safe fallback; later valid tasks can still be submitted.
        throw new Error("Task exceeds batch request size");
      }
    } catch {
      markReady(metadata, null);
      continue;
    }
    // Stop before the complete UTF-8 body exceeds the HTTP client's cap.
    // Unselected tasks keep their due time and attempts for the next pass.
    if (
      batchRequestByteLength([...requests, request], args.env) >
      MAX_BATCH_REQUEST_BYTES
    )
      break;
    queued.push(task);
    requests.push(request);
  }
  const ready = [...pending.values()]
    .filter((t) => t.state === "ready")
    .slice(0, MAX_BATCH_REQUESTS);
  const selected = new Map<string, TaskMetadata>();
  for (const task of [...queued, ...ready, ...[...receipts.values()].flat()])
    selected.set(task.task_id, pending.get(task.task_id)!);
  let nextAlarm = retryAt;
  for (const task of selected.values()) {
    // A retry must not postpone terminal expiry past the task's age limit.
    const deadline = Math.min(retryAt, task.created_at + MAX_TASK_AGE_MS);
    sql.exec(
      "UPDATE housekeeping_tasks SET next_run_at = ? WHERE task_id = ?",
      deadline,
      task.task_id,
    );
    nextAlarm = Math.min(nextAlarm, deadline);
  }
  await args.arm(nextAlarm);

  // Poll a bounded number of provider batches, once per shared receipt.
  for (const batchId of batchIds) {
    try {
      const batch = await getBatch(args.env, batchId);
      if (!isBatchTerminal(batch.status)) continue;
      for (const task of receipts.get(batchId)!) {
        if (
          !sql
            .exec(
              "SELECT task_id FROM housekeeping_tasks WHERE task_id = ? AND batch_id = ? AND state = 'submitted'",
              task.task_id,
              batchId,
            )
            .toArray().length
        ) {
          pending.delete(task.task_id);
          continue;
        }
        // Persist receipt results using metadata only. Source validity is
        // checked when applying, before any memory/embedding mutation.
        markReady(
          task,
          expired(task) ? null : batchResultText(batch, task.task_id),
        );
      }
    } catch {
      logWarn("DurableClaw housekeeping batch poll failed; receipt retained", {
        "durableclaw.batch.id": batchId,
      });
    }
  }

  if (queued.length && queued.every(live)) {
    for (const task of queued)
      sql.exec(
        "UPDATE housekeeping_tasks SET attempts = ? WHERE task_id = ?",
        task.attempts + 1,
        task.task_id,
      );
    try {
      const batch = await createBatch(args.env, requests);
      for (const task of queued) {
        if (!live(task)) {
          drop(task);
          continue;
        }
        // Some providers can finish before submission returns.
        const terminal = isBatchTerminal(batch.status);
        task.state = terminal ? "ready" : "submitted";
        task.result_text = terminal
          ? batchResultText(batch, task.task_id)
          : null;
        const metadata = pending.get(task.task_id)!;
        metadata.state = task.state;
        metadata.batch_id = batch.id;
        sql.exec(
          "UPDATE housekeeping_tasks SET state = ?, batch_id = ?, result_text = ? WHERE task_id = ?",
          task.state,
          batch.id,
          task.result_text,
          task.task_id,
        );
      }
    } catch {
      logWarn(
        "DurableClaw housekeeping batch submission failed; retry scheduled",
        { "durableclaw.batch.request_count": queued.length },
      );
    }
  }

  // Release queued source payloads before loading results for application.
  queued = [];
  requests = [];

  // A single pass never performs unbounded embedding writes.
  for (const metadata of [...pending.values()]
    .filter((t) => t.state === "ready")
    .slice(0, MAX_BATCH_REQUESTS)) {
    const task = load(metadata);
    if (!task) continue;
    if (!live(task)) {
      drop(task);
      continue;
    }
    const mustRetire = expired(task);
    if (fallback(task)) {
      markReady(metadata, null);
      task.state = "ready";
      task.result_text = null;
    }
    let applied = false;
    try {
      applied = await args.apply(task, task.result_text, () => live(task));
    } catch {
      logWarn(
        mustRetire
          ? "DurableClaw housekeeping expired fallback failed; task retired"
          : "DurableClaw housekeeping result application failed; output retained",
        { "durableclaw.batch.task_kind": task.kind },
      );
    }
    // One final fallback is best effort. Failed vector writes cannot keep an
    // expired row occupying an admission slot forever; discard owns cleanup.
    if (applied || mustRetire) drop(task);
  }
}

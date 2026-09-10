import type { ToolSet } from "ai";
import type { Env } from "../../types";
import type { SqlExecLike } from "../../durable-objects/assistant/memory";
import {
  scheduleJob,
  cancelJobs,
} from "../../durable-objects/assistant/scheduler";
import { defineTool } from "../../action-library/helpers";
import { authorizePrincipal } from "../../auth";
import { sendLinkedNotification } from "../../channels/service";
import type { Signal } from "./types";
import type { WakeProposalInput } from "./outputs";

export const WAKE_DELIVERY_JOB_ID = "wake_delivery";
// Shorter than the messaging adapter's 48-hour claim retention. Inbox delivery
// stays durable even after an external notification becomes stale.
export const MAX_EXTERNAL_NOTIFICATION_AGE_MS = 24 * 3600_000;
export const WAKE_NOTIFICATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS wake_notifications (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  proposals_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_wake_notifications_pending ON wake_notifications(delivered_at,created_at);
`;

/** Plain model text is never permission to interrupt: require a grounded decision. */
export function createWakeNotificationTool(
  signals: Signal[],
  record: (message: string) => void,
): ToolSet {
  const keys = new Set(signals.map((s) => s.dedupe_key));
  let recorded = false;
  return {
    notify_user: defineTool<{ message: string; signal_keys: string[] }>({
      description:
        "Send ONE concise digest to the user's inbox and linked messaging apps, only if an observed event deserves their attention. Explain what changed and why it matters. Do not call for newsletters, routine updates, or a no-news report.",
      properties: {
        message: { type: "string", minLength: 1, maxLength: 4000 },
        signal_keys: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
          description:
            "Keys of the observed signals supporting this notification.",
        },
      },
      required: ["message", "signal_keys"],
      execute: async (input) => {
        if (recorded)
          return "A notification is already selected for this heartbeat.";
        if (
          typeof input.message !== "string" ||
          !input.message.trim() ||
          input.message.length > 4000 ||
          !Array.isArray(input.signal_keys) ||
          input.signal_keys.length === 0 ||
          input.signal_keys.length > 20 ||
          input.signal_keys.some((key) => !keys.has(key))
        )
          return "Provide a concise message supported by keys from the observed signals.";
        record(input.message.trim());
        recorded = true;
        return "Notification selected. It will be delivered after this check completes.";
      },
    }),
  } as ToolSet;
}

/** Call inside the owner's storage transaction with observation settlement. */
export function queueWakeNotification(
  sql: SqlExecLike,
  args: {
    id: string;
    content: string;
    proposals?: WakeProposalInput[];
    now: number;
  },
): void {
  if (!args.content.trim() && !args.proposals?.length) return;
  if (args.content.length > 4000)
    throw new Error("Heartbeat notification too long");
  const proposals = JSON.stringify((args.proposals ?? []).slice(0, 10));
  if (proposals.length > 64000)
    throw new Error("Heartbeat proposals too large");
  sql.exec(
    "DELETE FROM wake_notifications WHERE delivered_at<?",
    args.now - 7 * 86400_000,
  );
  const existing = sql
    .exec("SELECT id FROM wake_notifications WHERE id=?", args.id)
    .toArray().length;
  if (
    !existing &&
    Number(
      (
        sql
          .exec(
            "SELECT COUNT(*) AS count FROM wake_notifications WHERE delivered_at IS NULL",
          )
          .toArray()[0] as { count: number }
      ).count,
    ) >= 100
  )
    throw new Error("Heartbeat notification queue is full");
  sql.exec(
    "INSERT OR IGNORE INTO wake_notifications(id,content,proposals_json,created_at) VALUES(?,?,?,?)",
    args.id,
    args.content.trim(),
    proposals,
    args.now,
  );
  scheduleWakeNotificationDelivery(sql, args.now);
}

export function scheduleWakeNotificationDelivery(
  sql: SqlExecLike,
  now: number,
): void {
  if (
    sql
      .exec(
        "SELECT id FROM wake_notifications WHERE delivered_at IS NULL LIMIT 1",
      )
      .toArray().length
  )
    scheduleJob(sql, {
      job_id: WAKE_DELIVERY_JOB_ID,
      kind: "wake_delivery",
      run_at: now,
      now,
    });
}
export function cancelWakeNotifications(sql: SqlExecLike): void {
  sql.exec("DELETE FROM wake_notifications WHERE delivered_at IS NULL");
  cancelJobs(sql, { job_id: WAKE_DELIVERY_JOB_ID });
}

/** Persist and arm recovery before external I/O. Stable IDs make inbox retries safe;
 * the messaging adapter owns the at-most-once claim around ambiguous sends. */
export async function runWakeNotificationDelivery(args: {
  sql: SqlExecLike;
  env: Env;
  userId: string;
  workspaceId: string;
  shouldSend: () => boolean;
  rearm: () => Promise<void>;
  now: number;
}): Promise<void> {
  if (!args.shouldSend()) {
    cancelWakeNotifications(args.sql);
    return;
  }
  const rows = args.sql
    .exec(
      "SELECT * FROM wake_notifications WHERE delivered_at IS NULL ORDER BY created_at,id LIMIT 5",
    )
    .toArray() as unknown as Array<{
    id: string;
    content: string;
    proposals_json: string;
    created_at: number;
  }>;
  if (!rows.length) {
    cancelJobs(args.sql, { job_id: WAKE_DELIVERY_JOB_ID });
    return;
  }
  scheduleJob(args.sql, {
    job_id: WAKE_DELIVERY_JOB_ID,
    kind: "wake_delivery",
    run_at: args.now + 60_000,
    now: args.now,
  });
  await args.rearm();
  for (const row of rows) {
    const shouldSend = () =>
      args.shouldSend() &&
      args.sql
        .exec(
          "SELECT id FROM wake_notifications WHERE id=? AND delivered_at IS NULL",
          row.id,
        )
        .toArray().length > 0;
    if (!shouldSend()) continue;
    const principal = await authorizePrincipal(
      args.env,
      args.userId,
      args.workspaceId,
    );
    if (!shouldSend()) continue;
    const proposals = JSON.parse(row.proposals_json) as WakeProposalInput[];
    const writes = [
      ...(row.content
        ? [{ id: `heartbeat_${row.id}`, kind: "insight", content: row.content }]
        : []),
      ...proposals.map((p, i) => ({
        id: `heartbeat_${row.id}_proposal_${i}`,
        kind: "proposal",
        content: JSON.stringify(p),
      })),
    ];
    if (writes.length)
      await args.env.CONTROL_DB.batch(
        writes.map((w) =>
          args.env.CONTROL_DB.prepare(
            "INSERT OR IGNORE INTO inbox (id,user_id,workspace_id,kind,content,created_at) VALUES (?,?,?,?,?,?)",
          ).bind(
            w.id,
            args.userId,
            args.workspaceId,
            w.kind,
            w.content,
            row.created_at,
          ),
        ),
      );
    const shouldSendExternally = () =>
      shouldSend() &&
      Date.now() - row.created_at < MAX_EXTERNAL_NOTIFICATION_AGE_MS;
    if (row.content && shouldSendExternally())
      await sendLinkedNotification(args.env, principal, {
        id: row.id,
        text: row.content,
        shouldSend: shouldSendExternally,
      });
    args.sql.exec(
      "UPDATE wake_notifications SET delivered_at=? WHERE id=?",
      Date.now(),
      row.id,
    );
  }
  cancelJobs(args.sql, { job_id: WAKE_DELIVERY_JOB_ID });
  scheduleWakeNotificationDelivery(args.sql, Date.now() + 1000);
}

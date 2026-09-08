import { authorizePrincipal } from "../../auth";
import type { Env } from "../../types";
import type { ToolSet } from "ai";
import type { Signal } from "./types";
import { defineTool } from "../../action-library/helpers";
import { createHash } from "node:crypto";
export interface WakeProposalInput {
  action_type: string;
  subject_entity_type?: string;
  subject_entity_id?: string;
  why: string;
  description: string;
}
export function resolveWakeNotificationCap(env: Env): number {
  const n = Number(env.WAKE_MAX_NOTIFICATIONS_PER_WAKE);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 20) : 5;
}
export function createWakeProposalTool(
  record: (proposal: WakeProposalInput) => void,
): ToolSet {
  return {
    propose_action: defineTool<WakeProposalInput>({
      description:
        "Suggest a follow-up for human review. This saves a proposal to the inbox and does not execute an action.",
      properties: {
        action_type: { type: "string" },
        subject_entity_type: { type: "string" },
        subject_entity_id: { type: "string" },
        why: { type: "string" },
        description: { type: "string" },
      },
      required: ["action_type", "why", "description"],
      execute: async (p) => {
        if (!p.why.trim() || !p.description.trim())
          return "A description and reason are required";
        record(p);
        return "Proposal recorded for human review";
      },
    }),
  };
}
export async function createWakeOutputs(args: {
  signals: Signal[];
  overflowCount: number;
  synthesisText: string | null;
  proposals?: WakeProposalInput[];
  db: D1Database | undefined;
  userId: string;
  organizationId: string;
  env: Env;
  tenantBinding?: string;
  userRole?: string;
  nowMs: number;
}): Promise<{ notifications_created: number; proposals_created: number }> {
  await authorizePrincipal(args.env, args.userId, args.organizationId);
  if (!args.db) throw new Error("Inbox storage unavailable");
  const notifications = args.signals
    .slice(0, resolveWakeNotificationCap(args.env))
    .map((s) => ({ key: s.dedupe_key, content: s.summary }));
  if (args.overflowCount > 0)
    notifications.push({
      key: "overflow:" + args.signals.map((s) => s.dedupe_key).join(","),
      content: `${args.overflowCount} additional changes need review.`,
    });
  if (args.synthesisText)
    notifications.push({
      key: "synthesis:" + args.synthesisText,
      content: args.synthesisText,
    });
  const writes = notifications.map((n) => ({
    kind: "insight",
    key: n.key,
    content: n.content,
  }));
  const proposals = (args.proposals || []).slice(0, 10);
  for (const p of proposals)
    writes.push({
      kind: "proposal",
      key: JSON.stringify(p),
      content: JSON.stringify(p),
    });
  // Stable output IDs make repeat delivery safe; failed writes propagate to the durable owner.
  if (writes.length)
    await args.db.batch(
      writes.map((w) =>
        args
          .db!.prepare(
            "INSERT OR IGNORE INTO inbox (id,user_id,workspace_id,kind,content,created_at) VALUES (?,?,?,?,?,?)",
          )
          .bind(
            createHash("sha256")
              .update(JSON.stringify([args.userId, args.organizationId, w.key]))
              .digest("hex"),
            args.userId,
            args.organizationId,
            w.kind,
            w.content,
            args.nowMs,
          ),
      ),
    );
  return {
    notifications_created: notifications.length,
    proposals_created: proposals.length,
  };
}

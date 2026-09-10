import { validId } from "../utils/validation";
import type {
  MessagingApproval,
  MessagingApprovalEvent,
  MessagingEnv,
  MessagingPlugin,
} from "./plugin";

export interface ApprovalLink {
  id: string;
  user_id: string;
  workspace_id: string;
  plugin_id: string;
  sender_id: string;
  chat_id: string;
  conversation_id: string;
}

const APPROVAL_TTL_MS = 10 * 60_000;
const RETENTION_MS = 48 * 3600_000;
const MAX_APPROVALS = 128;
const MAX_CARDS_PER_REPLY = 8;
const FALLBACK =
  "An action needs approval. Open DurableClaw to review its complete details and approve or decline it.";

async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

const exactLink = (env: MessagingEnv, link: ApprovalLink) =>
  env.CONTROL_DB.prepare(
    "SELECT id FROM messaging_links WHERE id=? AND user_id=? AND workspace_id=? AND plugin_id=? AND sender_id=? AND chat_id=? AND conversation_id=?",
  )
    .bind(
      link.id,
      link.user_id,
      link.workspace_id,
      link.plugin_id,
      link.sender_id,
      link.chat_id,
      link.conversation_id,
    )
    .first();

/** Tokens are retained independently of the link, like delivery claims. */
export async function pruneApprovals(env: MessagingEnv, now: number) {
  await env.CONTROL_DB.prepare(
    "DELETE FROM messaging_approvals WHERE token_hash IN (SELECT token_hash FROM messaging_approvals WHERE retain_until<=? LIMIT 1024)",
  )
    .bind(now)
    .run();
}

/** Persist a claim before sendMessage. A timeout or crash must never mint a
 * replacement button for the same confirmation/link. No preview enters D1. */
export async function sendApprovalCards(
  env: MessagingEnv,
  link: ApprovalLink,
  approvals: MessagingApproval[] | undefined,
  plugin: MessagingPlugin,
): Promise<void> {
  if (!Array.isArray(approvals) || !approvals.length) return;
  let fallback = approvals.length > MAX_CARDS_PER_REPLY;
  for (const approval of approvals.slice(0, MAX_CARDS_PER_REPLY)) {
    const now = Date.now();
    if (
      !approval ||
      !validId(approval.confirmationId) ||
      typeof approval.toolName !== "string" ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(approval.toolName) ||
      typeof approval.preview !== "string" ||
      !approval.preview.trim() ||
      !Number.isSafeInteger(approval.expiresAt) ||
      approval.expiresAt <= now
    ) {
      fallback = true;
      continue;
    }
    const expiresAt = Math.min(approval.expiresAt, now + APPROVAL_TTL_MS);
    const text = `Approval required: ${approval.toolName}\n\n${approval.preview}\n\nApprove only if these exact details are correct. Buttons expire at ${new Date(expiresAt).toISOString()}.`;
    // Do not show an actionable card if any part of the proposed action would
    // be hidden by the provider's text limit or the plugin lacks button support.
    if (!plugin.sendApproval || text.length > 4096) {
      fallback = true;
      continue;
    }
    const token = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    const tokenHash = await digest(token);
    const claim = await env.CONTROL_DB.prepare(
      `INSERT OR IGNORE INTO messaging_approvals(token_hash,confirmation_id,link_id,user_id,workspace_id,plugin_id,sender_id,chat_id,conversation_id,status,created_at,updated_at,expires_at,retain_until)
       SELECT ?,?,id,user_id,workspace_id,plugin_id,sender_id,chat_id,conversation_id,'sending',?,?,?,?
       FROM messaging_links WHERE id=? AND user_id=? AND workspace_id=? AND plugin_id=? AND sender_id=? AND chat_id=? AND conversation_id=?
       AND (SELECT COUNT(*) FROM messaging_approvals WHERE user_id=? AND workspace_id=?)<?`,
    )
      .bind(
        tokenHash,
        approval.confirmationId,
        now,
        now,
        expiresAt,
        now + RETENTION_MS,
        link.id,
        link.user_id,
        link.workspace_id,
        link.plugin_id,
        link.sender_id,
        link.chat_id,
        link.conversation_id,
        link.user_id,
        link.workspace_id,
        MAX_APPROVALS,
      )
      .run();
    if (!claim.meta.changes) {
      const existing = await env.CONTROL_DB.prepare(
        "SELECT status,expires_at FROM messaging_approvals WHERE user_id=? AND workspace_id=? AND link_id=? AND conversation_id=? AND confirmation_id=?",
      )
        .bind(
          link.user_id,
          link.workspace_id,
          link.id,
          link.conversation_id,
          approval.confirmationId,
        )
        .first<{ status: string; expires_at: number }>();
      if (
        !existing ||
        existing.status !== "sent" ||
        existing.expires_at <= Date.now()
      )
        fallback = true;
      continue;
    }
    let status = "unlinked";
    let messageId: string | null = null;
    if ((await exactLink(env, link)) && expiresAt > Date.now()) {
      try {
        const sent = await plugin.sendApproval(env, {
          chatId: link.chat_id,
          text,
          approveData: `dc:a:${token}`,
          declineData: `dc:d:${token}`,
        });
        if (
          typeof sent.messageId !== "string" ||
          !sent.messageId ||
          sent.messageId.length > 128
        )
          throw new Error("Invalid approval delivery receipt");
        messageId = sent.messageId;
        status = "sent";
      } catch {
        // Even an apparently failed send may have reached the provider.
        status = "send_unknown";
        fallback = true;
      }
    }
    await env.CONTROL_DB.prepare(
      "UPDATE messaging_approvals SET status=?,message_id=?,updated_at=? WHERE token_hash=? AND status='sending'",
    )
      .bind(status, messageId, Date.now(), tokenHash)
      .run();
  }
  if (fallback && (await exactLink(env, link)))
    await plugin.send(env, { chatId: link.chat_id, text: FALLBACK });
}

interface ApprovalRow extends ApprovalLink {
  link_id: string;
  confirmation_id: string;
}

/** Claim both the button and its dispatch atomically, binding every authority
 * field to the current link. Opposite decisions and redeliveries race on the
 * same token; only the winner can reach the Durable Object. */
export async function consumeApproval(
  env: MessagingEnv,
  plugin: MessagingPlugin,
  event: MessagingApprovalEvent,
  maxDeliveries: number,
): Promise<{
  link: ApprovalLink;
  requestId: string;
  confirmationId: string;
  decision: "confirmed" | "declined";
} | null> {
  const match = /^dc:([ad]):([A-Za-z0-9_-]{32})$/.exec(event.data);
  if (!match) return null;
  const tokenHash = await digest(match[2]);
  const now = Date.now();
  const requestId = `approval_${tokenHash}`;
  const decision = match[1] === "a" ? "confirmed" : "declined";
  const result = await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT OR IGNORE INTO messaging_deliveries(request_id,event_id,link_id,user_id,workspace_id,plugin_id,status,created_at,updated_at,expires_at)
       SELECT ?,?,a.link_id,a.user_id,a.workspace_id,a.plugin_id,'processing',?,?,?
       FROM messaging_approvals a JOIN messaging_links l ON l.id=a.link_id
       WHERE a.token_hash=? AND a.status='sent' AND a.expires_at>? AND a.plugin_id=? AND a.sender_id=? AND a.chat_id=? AND a.message_id=?
       AND l.user_id=a.user_id AND l.workspace_id=a.workspace_id AND l.plugin_id=a.plugin_id AND l.sender_id=a.sender_id AND l.chat_id=a.chat_id AND l.conversation_id=a.conversation_id
       AND (SELECT COUNT(*) FROM messaging_deliveries WHERE user_id=a.user_id AND workspace_id=a.workspace_id)<?`,
    ).bind(
      requestId,
      `approval:${tokenHash}`,
      now,
      now,
      now + RETENTION_MS,
      tokenHash,
      now,
      plugin.id,
      event.senderId,
      event.chatId,
      event.messageId,
      maxDeliveries,
    ),
    env.CONTROL_DB.prepare(
      `UPDATE messaging_approvals SET status='consumed',decision=?,updated_at=? WHERE token_hash=? AND status='sent' AND expires_at>?
       AND EXISTS(SELECT 1 FROM messaging_deliveries d WHERE d.request_id=? AND d.link_id=messaging_approvals.link_id AND d.user_id=messaging_approvals.user_id AND d.workspace_id=messaging_approvals.workspace_id AND d.plugin_id=messaging_approvals.plugin_id AND d.status='processing')`,
    ).bind(decision, now, tokenHash, now, requestId),
  ]);
  if (!result[1].meta.changes) return null;
  const row = await env.CONTROL_DB.prepare(
    `SELECT a.*, l.id FROM messaging_approvals a JOIN messaging_links l ON l.id=a.link_id
     WHERE a.token_hash=? AND a.status='consumed' AND l.user_id=a.user_id AND l.workspace_id=a.workspace_id AND l.plugin_id=a.plugin_id
     AND l.sender_id=a.sender_id AND l.chat_id=a.chat_id AND l.conversation_id=a.conversation_id`,
  )
    .bind(tokenHash)
    .first<ApprovalRow>();
  if (!row) return null;
  return {
    link: row,
    requestId,
    confirmationId: row.confirmation_id,
    decision,
  };
}

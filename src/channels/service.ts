import { authorizePrincipal } from "../auth";
import type { AgentPrincipal, Env } from "../types";
import {
  boundedJson,
  jsonObject,
  RequestValidationError,
  validId,
} from "../utils/validation";
import {
  boundedReply,
  createMessagingRegistry,
  MessagingError,
  type MessagingDispatch,
  type MessagingEnv,
  type MessagingEvent,
  type MessagingRegistry,
} from "./plugin";
import { telegramPlugin } from "./telegram";

export const messagingRegistry = createMessagingRegistry([telegramPlugin]);
const LINK_TTL_MS = 10 * 60_000;
const MAX_EVENT_AGE_MS = 24 * 3600_000;
const DELIVERY_TTL_MS = 48 * 3600_000;
const MAX_RETAINED_DELIVERIES = 1024;

interface Link {
  id: string;
  user_id: string;
  workspace_id: string;
  plugin_id: string;
  sender_id: string;
  chat_id: string;
  conversation_id: string;
}

interface LinkedRequest extends Link {
  delivery_status: string;
  delivery_updated_at: number;
}

/** Resolve only the link that accepted this request, never a replacement link
 * or a different conversation belonging to the same owner. */
async function linkedRequest(
  env: MessagingEnv,
  principal: AgentPrincipal,
  conversationId: string,
  requestId: string,
): Promise<LinkedRequest | null> {
  if (principal.role !== "owner") return null;
  return env.CONTROL_DB.prepare(
    `SELECT l.*, d.status AS delivery_status, d.updated_at AS delivery_updated_at
     FROM messaging_deliveries d JOIN messaging_links l ON l.id=d.link_id
     WHERE d.request_id=? AND d.user_id=? AND d.workspace_id=? AND d.expires_at>?
       AND l.user_id=d.user_id AND l.workspace_id=d.workspace_id
       AND l.plugin_id=d.plugin_id AND l.conversation_id=?`,
  )
    .bind(
      requestId,
      principal.userId,
      principal.workspaceId,
      Date.now(),
      conversationId,
    )
    .first<LinkedRequest>();
}

export async function sendLinkedTyping(
  env: MessagingEnv,
  principal: AgentPrincipal,
  conversationId: string,
  requestId: string,
  signal: AbortSignal,
  registry: MessagingRegistry = messagingRegistry,
): Promise<boolean> {
  signal.throwIfAborted();
  const link = await linkedRequest(env, principal, conversationId, requestId);
  signal.throwIfAborted();
  const plugin = link ? registry.get(link.plugin_id) : undefined;
  if (!link || !plugin?.sendTyping || !plugin.configured(env)) return false;
  await plugin.sendTyping(env, { chatId: link.chat_id }, signal);
  return true;
}

/** A later, persisted assistant message has its own durable delivery claim.
 * Retry preparation freely, but never repeat an ambiguous sendMessage call. */
export async function sendLinkedReply(
  env: MessagingEnv,
  principal: AgentPrincipal,
  reply: {
    conversationId: string;
    requestId: string;
    messageId: string;
    text: string;
  },
  registry: MessagingRegistry = messagingRegistry,
): Promise<"done" | "pending"> {
  const link = await linkedRequest(
    env,
    principal,
    reply.conversationId,
    reply.requestId,
  );
  const plugin = link ? registry.get(link.plugin_id) : undefined;
  if (!link || !plugin?.configured(env)) return "done";
  // Keep the initial acknowledgment ahead of a quick batch result. A crashed
  // webhook must not hold the result forever (host deadline is 100 seconds).
  if (
    ["processing", "sending"].includes(link.delivery_status) &&
    link.delivery_updated_at > Date.now() - 110_000
  )
    return "pending";
  const digest = await hash(JSON.stringify([reply.requestId, reply.messageId]));
  const requestId = `reply_${digest}`;
  const now = Date.now();
  const claim = await env.CONTROL_DB.prepare(
    "INSERT OR IGNORE INTO messaging_deliveries(request_id,event_id,link_id,user_id,workspace_id,plugin_id,status,created_at,updated_at,expires_at) SELECT ?,?,?,?,?,?,'sending',?,?,? WHERE EXISTS(SELECT 1 FROM messaging_links WHERE id=?) AND (SELECT COUNT(*) FROM messaging_deliveries WHERE user_id=? AND workspace_id=?)<?",
  )
    .bind(
      requestId,
      `reply:${digest}`,
      link.id,
      principal.userId,
      principal.workspaceId,
      plugin.id,
      now,
      now,
      now + DELIVERY_TTL_MS,
      link.id,
      principal.userId,
      principal.workspaceId,
      MAX_RETAINED_DELIVERIES,
    )
    .run();
  if (!claim.meta.changes) return "done";
  let status = "unlinked";
  if (
    await linkedRequest(env, principal, reply.conversationId, reply.requestId)
  ) {
    try {
      await plugin.send(env, {
        chatId: link.chat_id,
        text: boundedReply(reply.text),
      });
      status = "sent";
    } catch {
      status = "send_unknown";
    }
  }
  await env.CONTROL_DB.prepare(
    "UPDATE messaging_deliveries SET status=?,updated_at=? WHERE request_id=?",
  )
    .bind(status, Date.now(), requestId)
    .run();
  return "done";
}

/** Proactive output has no inbound request. Resolve only this owner's current
 * private links, and durably claim each recipient before contacting a provider.
 * A provider timeout is ambiguous and must never cause a second send. */
export async function sendLinkedNotification(
  env: Env,
  principal: AgentPrincipal,
  notification: {
    id: string;
    text: string;
    shouldSend?: () => boolean;
  },
  registry: MessagingRegistry = messagingRegistry,
): Promise<void> {
  if (
    typeof notification.id !== "string" ||
    !notification.id.trim() ||
    notification.id.length > 256 ||
    typeof notification.text !== "string" ||
    !notification.text.trim()
  )
    throw new MessagingError("Invalid notification", 400);
  const enabled = () => notification.shouldSend?.() !== false;
  if (principal.role !== "owner" || !enabled()) return;
  const authorize = async () => {
    const current = await authorizePrincipal(
      env,
      principal.userId,
      principal.workspaceId,
    );
    if (current.role !== "owner")
      throw new MessagingError("Owner access required", 403);
  };
  await authorize();
  if (!enabled()) return;
  const links = await env.CONTROL_DB.prepare(
    "SELECT * FROM messaging_links WHERE user_id=? AND workspace_id=? ORDER BY id LIMIT 101",
  )
    .bind(principal.userId, principal.workspaceId)
    .all<Link>();
  if (!enabled()) return;
  if (links.results.length > 100)
    throw new MessagingError("Too many messaging connections", 503);
  // Bound cleanup work to the owner's retention limit; never evict live claims
  // merely to make room, since doing so could repeat an ambiguous provider send.
  await env.CONTROL_DB.prepare(
    "DELETE FROM messaging_deliveries WHERE request_id IN (SELECT request_id FROM messaging_deliveries WHERE user_id=? AND workspace_id=? AND expires_at<=? LIMIT ?)",
  )
    .bind(
      principal.userId,
      principal.workspaceId,
      Date.now(),
      MAX_RETAINED_DELIVERIES,
    )
    .run();
  if (!enabled()) return;
  for (const link of links.results) {
    const plugin = registry.get(link.plugin_id);
    if (!plugin?.configured(env)) continue;
    const currentLink = () =>
      env.CONTROL_DB.prepare(
        "SELECT id FROM messaging_links WHERE id=? AND user_id=? AND workspace_id=? AND plugin_id=? AND sender_id=? AND chat_id=? AND conversation_id=?",
      )
        .bind(
          link.id,
          principal.userId,
          principal.workspaceId,
          plugin.id,
          link.sender_id,
          link.chat_id,
          link.conversation_id,
        )
        .first();
    const eventDigest = await hash(
      JSON.stringify([
        principal.userId,
        principal.workspaceId,
        notification.id,
        plugin.id,
      ]),
    );
    if (!enabled()) return;
    // Event deduplication survives unlink/relink; the claim still identifies
    // the exact link we resolved and may never retarget a replacement recipient.
    const digest = await hash(JSON.stringify([eventDigest, link.id]));
    if (!enabled()) return;
    const requestId = `notification_${digest}`;
    const eventId = `notification:${eventDigest}`;
    const now = Date.now();
    const claim = await env.CONTROL_DB.prepare(
      "INSERT OR IGNORE INTO messaging_deliveries(request_id,event_id,link_id,user_id,workspace_id,plugin_id,status,created_at,updated_at,expires_at) SELECT ?,?,id,user_id,workspace_id,plugin_id,'sending',?,?,? FROM messaging_links WHERE id=? AND user_id=? AND workspace_id=? AND plugin_id=? AND sender_id=? AND chat_id=? AND conversation_id=? AND (SELECT COUNT(*) FROM messaging_deliveries WHERE user_id=? AND workspace_id=?)<?",
    )
      .bind(
        requestId,
        eventId,
        now,
        now,
        now + DELIVERY_TTL_MS,
        link.id,
        principal.userId,
        principal.workspaceId,
        plugin.id,
        link.sender_id,
        link.chat_id,
        link.conversation_id,
        principal.userId,
        principal.workspaceId,
        MAX_RETAINED_DELIVERIES,
      )
      .run();
    if (!enabled()) return;
    if (!claim.meta.changes) {
      const existing = await env.CONTROL_DB.prepare(
        "SELECT request_id FROM messaging_deliveries WHERE plugin_id=? AND event_id=? AND user_id=? AND workspace_id=?",
      )
        .bind(plugin.id, eventId, principal.userId, principal.workspaceId)
        .first();
      if (!enabled()) return;
      if (existing) continue;
      const linked = await currentLink();
      if (!enabled()) return;
      if (!linked) continue;
      throw new MessagingError("Messaging delivery capacity reached", 503);
    }
    let status = "unlinked";
    let sendStarted = false;
    try {
      await authorize();
      if (!enabled()) return;
      const linked = await currentLink();
      if (!enabled()) return;
      if (linked && plugin.configured(env) && enabled()) {
        sendStarted = true;
        await plugin.send(env, {
          chatId: link.chat_id,
          text: boundedReply(notification.text),
        });
        status = "sent";
      }
    } catch (error) {
      if (!sendStarted) {
        // Authority/storage preflight failed without contacting the provider;
        // allow the durable job to retry preparation after recovery.
        await env.CONTROL_DB.prepare(
          "DELETE FROM messaging_deliveries WHERE request_id=? AND user_id=? AND workspace_id=? AND link_id=? AND status='sending'",
        )
          .bind(requestId, principal.userId, principal.workspaceId, link.id)
          .run();
        throw error;
      }
      status = "send_unknown";
    }
    await env.CONTROL_DB.prepare(
      "UPDATE messaging_deliveries SET status=?,updated_at=? WHERE request_id=? AND user_id=? AND workspace_id=? AND link_id=?",
    )
      .bind(
        status,
        Date.now(),
        requestId,
        principal.userId,
        principal.workspaceId,
        link.id,
      )
      .run();
    if (!enabled()) return;
  }
}

async function hash(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function failure(error: unknown): Response {
  if (
    error instanceof MessagingError ||
    error instanceof RequestValidationError
  )
    return response({ error: error.message }, error.status);
  if (error instanceof SyntaxError)
    return response({ error: "Invalid JSON" }, 400);
  return response({ error: "Messaging unavailable" }, 503);
}

async function prune(env: MessagingEnv, now: number): Promise<void> {
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "DELETE FROM messaging_link_codes WHERE expires_at<=?",
    ).bind(now),
    env.CONTROL_DB.prepare(
      "DELETE FROM messaging_deliveries WHERE expires_at<=?",
    ).bind(now),
  ]);
}

/** Requires an authenticated, same-origin owner request at the host router. */
export async function handleMessagingOwnerRequest(
  request: Request,
  env: MessagingEnv,
  principal: AgentPrincipal,
  registry: MessagingRegistry = messagingRegistry,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/messaging/")) return null;
  if (principal.role !== "owner")
    return response({ error: "Owner access required" }, 403);
  try {
    if (path === "/api/messaging/plugins" && request.method === "GET")
      return response({
        plugins: registry.list().map((plugin) => ({
          id: plugin.id,
          label: plugin.label,
          configured: plugin.configured(env),
        })),
      });
    if (path === "/api/messaging/links" && request.method === "GET") {
      const links = await env.CONTROL_DB.prepare(
        "SELECT id,plugin_id AS pluginId,sender_id AS senderId,chat_id AS chatId,conversation_id AS conversationId,created_at AS createdAt FROM messaging_links WHERE user_id=? AND workspace_id=? ORDER BY created_at DESC LIMIT 100",
      )
        .bind(principal.userId, principal.workspaceId)
        .all();
      return response({ links: links.results });
    }
    if (path === "/api/messaging/deliveries" && request.method === "GET") {
      await prune(env, Date.now());
      const deliveries = await env.CONTROL_DB.prepare(
        "SELECT request_id AS requestId,plugin_id AS pluginId,link_id AS linkId,status,created_at AS createdAt,updated_at AS updatedAt FROM messaging_deliveries WHERE user_id=? AND workspace_id=? ORDER BY created_at DESC LIMIT 50",
      )
        .bind(principal.userId, principal.workspaceId)
        .all();
      return response({ deliveries: deliveries.results });
    }
    if (path === "/api/messaging/link-codes" && request.method === "POST") {
      const body = jsonObject(await boundedJson(request, 2048));
      const plugin =
        typeof body.pluginId === "string"
          ? registry.get(body.pluginId)
          : undefined;
      if (!plugin || !validId(body.conversationId))
        return response({ error: "Invalid plugin or conversation ID" }, 400);
      if (!plugin.configured(env))
        return response({ error: "Messaging plugin is not configured" }, 503);
      const existing = await env.CONTROL_DB.prepare(
        "SELECT id FROM messaging_links WHERE user_id=? AND workspace_id=? AND plugin_id=?",
      )
        .bind(principal.userId, principal.workspaceId, plugin.id)
        .first();
      if (existing)
        return response({ error: "Unlink the existing connection first" }, 409);
      const now = Date.now();
      const code = btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))),
      )
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
      const expiresAt = now + LINK_TTL_MS;
      await prune(env, now);
      await env.CONTROL_DB.prepare(
        "INSERT INTO messaging_link_codes(token_hash,user_id,workspace_id,plugin_id,conversation_id,expires_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,workspace_id,plugin_id) DO UPDATE SET token_hash=excluded.token_hash,conversation_id=excluded.conversation_id,expires_at=excluded.expires_at",
      )
        .bind(
          await hash(code),
          principal.userId,
          principal.workspaceId,
          plugin.id,
          body.conversationId,
          expiresAt,
        )
        .run();
      return response(
        {
          pluginId: plugin.id,
          code,
          expiresAt,
          instruction: `Send /start ${code} in a private chat with the bot.`,
        },
        201,
      );
    }
    const unlink = /^\/api\/messaging\/links\/([a-zA-Z0-9_-]{1,128})$/.exec(
      path,
    );
    if (unlink && request.method === "DELETE") {
      const deleted = await env.CONTROL_DB.prepare(
        "DELETE FROM messaging_links WHERE id=? AND user_id=? AND workspace_id=? RETURNING id",
      )
        .bind(unlink[1], principal.userId, principal.workspaceId)
        .first();
      return deleted
        ? response({ unlinked: true })
        : response({ error: "Connection not found" }, 404);
    }
    return response({ error: "Messaging route not found" }, 404);
  } catch (error) {
    return failure(error);
  }
}

async function redeem(
  env: MessagingEnv,
  pluginId: string,
  event: MessagingEvent,
  code: string,
  now: number,
): Promise<Link | null> {
  const id = crypto.randomUUID();
  const tokenHash = await hash(code);
  // D1 batches are transactional. The code is consumed only if this insertion
  // succeeds; provider identities and owner/provider pairs are globally unique.
  const result = await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT OR IGNORE INTO messaging_links(id,user_id,workspace_id,plugin_id,sender_id,chat_id,conversation_id,created_at) SELECT ?,user_id,workspace_id,plugin_id,?,?,conversation_id,? FROM messaging_link_codes WHERE token_hash=? AND plugin_id=? AND expires_at>?",
    ).bind(id, event.senderId, event.chatId, now, tokenHash, pluginId, now),
    env.CONTROL_DB.prepare(
      "DELETE FROM messaging_link_codes WHERE token_hash=? AND EXISTS(SELECT 1 FROM messaging_links WHERE id=?)",
    ).bind(tokenHash, id),
  ]);
  if (!result[0].meta.changes) return null;
  return env.CONTROL_DB.prepare("SELECT * FROM messaging_links WHERE id=?")
    .bind(id)
    .first<Link>();
}

function validEvent(event: MessagingEvent, now: number): boolean {
  return (
    [event.eventId, event.senderId, event.chatId].every(
      (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 128,
    ) &&
    typeof event.content === "string" &&
    event.content.trim().length > 0 &&
    event.content.length <= 4096 &&
    Number.isSafeInteger(event.occurredAt) &&
    event.occurredAt >= now - MAX_EVENT_AGE_MS &&
    event.occurredAt <= now + 5 * 60_000
  );
}

/** Provider-authenticated ingress. The durable claim happens before all agent
 * work and outbound sends; retries never repeat either ambiguous operation. */
export async function handleMessagingWebhook(
  request: Request,
  env: MessagingEnv,
  dispatch: MessagingDispatch,
  registry: MessagingRegistry = messagingRegistry,
): Promise<Response> {
  const path = /^\/api\/messaging\/webhooks\/([a-z][a-z0-9-]{0,31})$/.exec(
    new URL(request.url).pathname,
  );
  const plugin = path ? registry.get(path[1]) : undefined;
  if (!plugin) return response({ error: "Messaging plugin not found" }, 404);
  if (request.method !== "POST")
    return response({ error: "POST required" }, 405);
  try {
    const event = await plugin.receive(request, env);
    const now = Date.now();
    if (!event || !validEvent(event, now)) return response({ ok: true });
    const start = /^\/start(?:\s+([A-Za-z0-9_-]{32}))?\s*$/.exec(event.content);
    let link: Link | null;
    if (event.content.startsWith("/start")) {
      if (!start?.[1]) return response({ ok: true });
      link = await redeem(env, plugin.id, event, start[1], now);
    } else {
      link = await env.CONTROL_DB.prepare(
        "SELECT * FROM messaging_links WHERE plugin_id=? AND sender_id=? AND chat_id=?",
      )
        .bind(plugin.id, event.senderId, event.chatId)
        .first<Link>();
    }
    if (!link) return response({ ok: true });
    await prune(env, now);
    const requestId = `msg_${await hash(JSON.stringify([plugin.id, event.eventId]))}`;
    // Do not evict live dedupe records at the cap; reject new work instead.
    const claimed = await env.CONTROL_DB.prepare(
      "INSERT OR IGNORE INTO messaging_deliveries(request_id,event_id,link_id,user_id,workspace_id,plugin_id,status,created_at,updated_at,expires_at) SELECT ?,?,?,?,?,?,'processing',?,?,? WHERE EXISTS(SELECT 1 FROM messaging_links WHERE id=?) AND (SELECT COUNT(*) FROM messaging_deliveries WHERE user_id=? AND workspace_id=?)<?",
    )
      .bind(
        requestId,
        event.eventId,
        link.id,
        link.user_id,
        link.workspace_id,
        plugin.id,
        now,
        now,
        now + DELIVERY_TTL_MS,
        link.id,
        link.user_id,
        link.workspace_id,
        MAX_RETAINED_DELIVERIES,
      )
      .run();
    if (!claimed.meta.changes) return response({ ok: true });
    const status = async (value: string) => {
      await env.CONTROL_DB.prepare(
        "UPDATE messaging_deliveries SET status=?,updated_at=? WHERE request_id=?",
      )
        .bind(value, Date.now(), requestId)
        .run();
    };
    let text =
      "Connected to DurableClaw. Send a message to talk to your agent. Approve actions only in the DurableClaw app.";
    if (!start) {
      try {
        const result = await dispatch(
          {
            userId: link.user_id,
            workspaceId: link.workspace_id,
            role: "owner",
          },
          {
            conversationId: link.conversation_id,
            requestId,
            content: event.content,
          },
        );
        text = boundedReply(result.text);
      } catch {
        await status("dispatch_unknown");
        return response({ ok: true });
      }
    }
    const stillLinked = await env.CONTROL_DB.prepare(
      "SELECT id FROM messaging_links WHERE id=?",
    )
      .bind(link.id)
      .first();
    if (!stillLinked) {
      await status("unlinked");
      return response({ ok: true });
    }
    await status("sending");
    try {
      await plugin.send(env, { chatId: link.chat_id, text });
    } catch {
      await status("send_unknown");
      return response({ ok: true });
    }
    await status("sent");
    return response({ ok: true });
  } catch (error) {
    return failure(error);
  }
}

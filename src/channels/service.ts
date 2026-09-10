import type { AgentPrincipal } from "../types";
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

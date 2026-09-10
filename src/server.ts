export { NanoChatAgent } from "./durable-objects/NanoChatAgent";
export { ResearchSubagent } from "./durable-objects/ResearchSubagent";
export { IdentityDO } from "./identity/IdentityDO";
import type { Env, AgentPrincipal } from "./types";
import { authenticate, authorizePrincipal } from "./auth";
import { accessConfigured } from "./access";
import {
  authenticateNative,
  identityStub,
  nativeAuthConfigured,
  routeNativeAuth,
} from "./nativeAuth";
import {
  boundedJson,
  validId,
  validMemoryId,
  RequestValidationError,
} from "./utils/validation";
import { doName } from "./durable-objects/assistant/principal";
import { createInternalAuthHeaders } from "./utils/internalAuth";
import { reconcileWakes } from "./scheduled/wakeReconciler";
import {
  handleMessagingOwnerRequest,
  handleMessagingWebhook,
} from "./channels/service";
import { routeDeviceOwner, routeDevicePublic } from "./devices/routes";
import {
  isOAuthCallbackRelay,
  oauthCallbackRelay,
  routeConnectorOwner,
} from "./connectors/routes";

const TICKET_TTL_MS = 30_000;
async function ticketHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
}
function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return (
    request.headers.get("sec-fetch-site") !== "cross-site" &&
    (!origin || origin === new URL(request.url).origin)
  );
}
async function signedHeaders(
  p: AgentPrincipal,
  env: Env,
  identitySessionId?: string,
) {
  return createInternalAuthHeaders(
    {
      userId: p.userId,
      organizationId: p.workspaceId,
      tenantBinding: p.workspaceId,
      role: p.role,
      ...(identitySessionId ? { identitySessionId } : {}),
    },
    env.INTERNAL_AUTH_SECRET,
  );
}
async function ownerStub(env: Env, p: AgentPrincipal) {
  const stub = env.NANO_CHAT_AGENT.get(
    env.NANO_CHAT_AGENT.idFromName(doName(p.userId, p.workspaceId)),
  );
  const response = await stub.fetch("https://agent.internal/init", {
    method: "POST",
    headers: await signedHeaders(p, env),
    body: "{}",
  });
  if (!response.ok) throw new Error("Agent initialization failed");
  await response.body?.cancel();
  return stub;
}
async function routeRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (
    request.headers.has("upgrade") &&
    (url.pathname !== "/api/agent/connect" ||
      request.method !== "GET" ||
      request.headers.get("upgrade")?.toLowerCase() !== "websocket")
  )
    return Response.json(
      { error: "Unsupported upgrade route" },
      { status: 400 },
    );
  if (url.pathname === "/api/health")
    return Response.json({ status: "ok", service: "durable-claw" });
  if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/agents/"))
    return env.ASSETS.fetch(request);
  if (isOAuthCallbackRelay(request)) return oauthCallbackRelay(request);
  // Access returns here as a top-level navigation from the identity provider.
  const accessReturn =
    url.pathname === "/api/auth/access" && request.method === "GET";
  if (!accessReturn && !sameOrigin(request))
    return Response.json({ error: "Origin rejected" }, { status: 403 });
  try {
    const authResponse = await routeNativeAuth(request, env);
    if (authResponse) return authResponse;
    if (url.pathname.startsWith("/api/messaging/webhooks/")) {
      return handleMessagingWebhook(request, env, async (owner, message) => {
        const principal = await authorizePrincipal(
          env,
          owner.userId,
          owner.workspaceId,
        );
        if (principal.role !== "owner") throw new Error("Owner required");
        const stub = await ownerStub(env, principal);
        const response = await stub.fetch(
          "https://agent.internal/channel-message",
          {
            method: "POST",
            headers: await signedHeaders(principal, env),
            body: JSON.stringify(message),
            signal: AbortSignal.timeout(100000),
          },
        );
        if (!response.ok) throw new Error("Channel turn unavailable");
        const reply = await response.json<{ text: string }>();
        await authorizePrincipal(env, owner.userId, owner.workspaceId);
        return reply;
      });
    }
    const deviceResponse = await routeDevicePublic(
      request,
      env,
      async (principal) => {
        const stub = await ownerStub(env, principal);
        const response = await stub.fetch(
          "https://agent.internal/device-policy",
          {
            headers: await signedHeaders(principal, env),
            signal: AbortSignal.timeout(5000),
          },
        );
        return (
          response.ok &&
          (await response.json<{ allowed: boolean }>()).allowed === true
        );
      },
    );
    if (deviceResponse) return deviceResponse;
    let p: AgentPrincipal | null = null;
    let identitySessionId: string | undefined;
    if (
      url.pathname === "/api/agent/connect" &&
      request.headers.get("Upgrade")?.toLowerCase() === "websocket"
    ) {
      const token = url.searchParams.get("ticket");
      const conversation = url.searchParams.get("conversation_id");
      if (!token || token.length > 128 || !validId(conversation))
        return Response.json(
          { error: "Invalid socket ticket" },
          { status: 401 },
        );
      const redeemed = await env.CONTROL_DB.prepare(
        "DELETE FROM socket_tickets WHERE token_hash=? AND conversation_id=? AND expires_at>? RETURNING user_id,workspace_id",
      )
        .bind(await ticketHash(token), conversation, Date.now())
        .first<{ user_id: string; workspace_id: string }>();
      if (!redeemed)
        return Response.json(
          { error: "Socket ticket expired or consumed" },
          { status: 401 },
        );
      p = await authorizePrincipal(
        env,
        redeemed.user_id,
        redeemed.workspace_id,
      );
      if (nativeAuthConfigured(env)) {
        const reference = await identityStub(env).sessionReference(
          new Request(request.url, {
            headers: { cookie: request.headers.get("cookie") || "" },
          }),
        );
        if (reference) identitySessionId = reference.id;
        else
          return Response.json(
            { error: "Current session required" },
            { status: 401 },
          );
      }
    } else p = await authenticate(request, env);
    if (!p)
      return Response.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    if (
      (accessConfigured(env) || nativeAuthConfigured(env)) &&
      !["GET", "HEAD"].includes(request.method) &&
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      return Response.json(
        { error: "JSON content type required" },
        { status: 415 },
      );
    if (url.pathname === "/api/session" && request.method === "GET")
      return Response.json({
        authenticated: true,
        auth_mode: env.AUTH
          ? "service"
          : (await authenticateNative(request, env))
            ? "native"
            : accessConfigured(env)
              ? "access"
              : "token",
        principal: p,
      });
    const ownerDeviceResponse = await routeDeviceOwner(request, env, p);
    if (ownerDeviceResponse) return ownerDeviceResponse;
    const connectorResponse = await routeConnectorOwner(request, env, p);
    if (connectorResponse) return connectorResponse;
    const messagingResponse = await handleMessagingOwnerRequest(
      request,
      env,
      p,
    );
    if (messagingResponse) return messagingResponse;
    if (url.pathname === "/api/socket-ticket" && request.method === "POST") {
      const data = (await boundedJson(request)) as {
        conversation_id?: unknown;
      };
      if (!validId(data.conversation_id))
        return Response.json(
          { error: "Invalid conversation ID" },
          { status: 400 },
        );
      await env.CONTROL_DB.prepare(
        "DELETE FROM socket_tickets WHERE expires_at<=?",
      )
        .bind(Date.now())
        .run();
      const token = crypto.randomUUID() + crypto.randomUUID();
      await env.CONTROL_DB.prepare(
        "INSERT INTO socket_tickets (token_hash,user_id,workspace_id,conversation_id,expires_at) VALUES (?,?,?,?,?)",
      )
        .bind(
          await ticketHash(token),
          p.userId,
          p.workspaceId,
          data.conversation_id,
          Date.now() + TICKET_TTL_MS,
        )
        .run();
      return Response.json(
        { ticket: token },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (url.pathname === "/api/legacy/import" && request.method === "POST") {
      // Old unauthenticated sessions have no ownership record. Only the explicitly configured single-owner installation can adopt them.
      if (env.AUTH || p.userId !== "owner" || p.workspaceId !== "default")
        return Response.json(
          { error: "Legacy import requires single-owner mode" },
          { status: 403 },
        );
      const data = (await boundedJson(request)) as {
        session_id?: unknown;
        after?: unknown;
      };
      if (!validId(data.session_id) || data.session_id.length > 100)
        return Response.json(
          { error: "Invalid legacy session" },
          { status: 400 },
        );
      const after =
        Number.isSafeInteger(data.after) && Number(data.after) >= 0
          ? Number(data.after)
          : 0;
      const old = env.NANO_CHAT_AGENT.get(
        env.NANO_CHAT_AGENT.idFromName(data.session_id),
      );
      const response = await old.fetch(
        "https://agent.internal/legacy-export?after=" + after,
        { headers: await signedHeaders(p, env) },
      );
      if (!response.ok) throw new Error("Legacy export failed");
      const page = await response.json();
      const target = await ownerStub(env, p);
      const imported = await target.fetch(
        "https://agent.internal/legacy-import",
        {
          method: "POST",
          headers: await signedHeaders(p, env),
          body: JSON.stringify({ session: data.session_id, page }),
        },
      );
      return Response.json(
        {
          ...((await imported.json()) as object),
          next_cursor: (page as { next_cursor: number | null }).next_cursor,
        },
        { status: imported.status },
      );
    }
    if (url.pathname === "/api/events" && request.method === "POST") {
      const data = (await boundedJson(request)) as {
        kind?: unknown;
        resource_id?: unknown;
        summary?: unknown;
        salience?: unknown;
      };
      if (
        typeof data.kind !== "string" ||
        data.kind.length > 64 ||
        typeof data.resource_id !== "string" ||
        data.resource_id.length > 512 ||
        typeof data.summary !== "string" ||
        data.summary.length > 4000
      )
        return Response.json({ error: "Invalid event" }, { status: 400 });
      await env.CONTROL_DB.prepare(
        "INSERT INTO workspace_events (user_id,workspace_id,kind,resource_id,summary,salience,occurred_at) VALUES (?,?,?,?,?,?,?)",
      )
        .bind(
          p.userId,
          p.workspaceId,
          data.kind,
          data.resource_id,
          data.summary,
          ["low", "medium", "high"].includes(String(data.salience))
            ? String(data.salience)
            : "medium",
          Date.now(),
        )
        .run();
      return Response.json({ accepted: true }, { status: 202 });
    }
    if (url.pathname === "/api/inbox" && request.method === "GET") {
      const items = await env.CONTROL_DB.prepare(
        "SELECT id,kind,content,created_at,read_at FROM inbox WHERE user_id=? AND workspace_id=? ORDER BY created_at DESC LIMIT 100",
      )
        .bind(p.userId, p.workspaceId)
        .all();
      return Response.json({ items: items.results });
    }
    if (url.pathname.startsWith("/api/agent/")) {
      const path = url.pathname.slice("/api/agent".length);
      const allowed =
        /^\/(init|persona|connect|conversations(?:\/[a-zA-Z0-9_-]{1,128}(?:\/messages|\/confirmations\/[a-zA-Z0-9_-]{1,128})?)?|memories(?:\/(?:forget-all|[a-zA-Z0-9_-]{1,128}))?|activity\/wakes(?:\/[a-zA-Z0-9_-]{1,128})?)$/;
      const memorySegment = path.match(/^\/memories\/([^/]+)$/)?.[1];
      let memoryPath: string | undefined;
      if (memorySegment) {
        try {
          const memoryId = decodeURIComponent(memorySegment);
          if (validMemoryId(memoryId))
            memoryPath = "/memories/" + encodeURIComponent(memoryId);
        } catch {
          /* Invalid encodings are not routes. */
        }
      }
      if (!allowed.test(path) && !memoryPath)
        return Response.json({ error: "Not found" }, { status: 404 });
      const stub = await ownerStub(env, p);
      const headers = new Headers(
        await signedHeaders(p, env, identitySessionId),
      );
      if (request.headers.get("Upgrade")?.toLowerCase() === "websocket")
        headers.set("Upgrade", "websocket");
      const target = new URL("https://agent.internal" + (memoryPath ?? path));
      for (const key of [
        "conversation_id",
        "limit",
        "cursor",
        "before",
        "type",
        "offset",
      ]) {
        const v = url.searchParams.get(key);
        if (v !== null) target.searchParams.set(key, v);
      }
      // These routes have no DELETE payload. At the edge an empty HTTP body
      // may still be a ReadableStream, so body presence cannot identify it.
      const body = ["GET", "HEAD", "DELETE"].includes(request.method)
        ? undefined
        : JSON.stringify(await boundedJson(request));
      return stub.fetch(
        new Request(target, { method: request.method, headers, body }),
      );
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RequestValidationError
            ? error.message
            : error instanceof SyntaxError
              ? "Invalid JSON"
              : "Request failed",
      },
      {
        status:
          error instanceof RequestValidationError
            ? error.status
            : error instanceof SyntaxError
              ? 400
              : 500,
      },
    );
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await routeRequest(request, env);
    const path = new URL(request.url).pathname;
    // Upgrade responses own a WebSocket and must be forwarded intact.
    if (
      response.status === 101 ||
      (!path.startsWith("/api/") && !path.startsWith("/agents/"))
    )
      return response;
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Referrer-Policy", "no-referrer");
    if (!isOAuthCallbackRelay(request))
      headers.set(
        "Content-Security-Policy",
        "default-src 'none'; frame-ancestors 'none'",
      );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(reconcileWakes(env));
  },
} satisfies ExportedHandler<Env>;

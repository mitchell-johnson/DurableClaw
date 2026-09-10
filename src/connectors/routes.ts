import type { AgentPrincipal, Env } from "../types";
import { boundedJson, RequestValidationError } from "../utils/validation";
import {
  callConnectorService,
  connectionId,
  ConnectorError,
  connectorsConfigured,
  listServiceConnections,
  currentConnectorOwner,
} from "./client";
import { PUBLIC_GOOGLE_SERVICES } from "../../services/connectors/src/google-metadata";
import { safePath, workspacePrefix } from "../storage/workspace";
import { connectorRegistry } from "./gmail";
import { strictObject } from "./plugin";

const CALLBACK = "/api/connectors/google/callback";
export function isOAuthCallbackRelay(request: Request): boolean {
  return request.method === "GET" && new URL(request.url).pathname === CALLBACK;
}
function callbackData(value: unknown): {
  state: string;
  code?: string;
  error?: string;
} {
  const data = strictObject(value, ["state", "code", "error"]);
  if (
    typeof data.state !== "string" ||
    !data.state ||
    data.state.length > 512 ||
    (typeof data.code !== "string" && typeof data.error !== "string") ||
    (data.code !== undefined &&
      (typeof data.code !== "string" ||
        !data.code ||
        data.code.length > 8192)) ||
    (data.error !== undefined &&
      (typeof data.error !== "string" || data.code !== undefined))
  )
    throw new ConnectorError("Invalid OAuth callback", 400);
  return {
    state: data.state,
    ...(data.error === undefined
      ? { code: data.code as string }
      : { error: "access_denied" }),
  };
}
/** Public callback only relays the authorization code to its original opener.
 * State redemption/token exchange happens on an authenticated POST from that
 * opener. Nothing here grants access or chooses an owner from query parameters. */
export function oauthCallbackRelay(request: Request): Response {
  const url = new URL(request.url);
  try {
    if (
      ["state", "code", "error"].some(
        (key) => url.searchParams.getAll(key).length > 1,
      )
    )
      throw new Error("Duplicate callback field");
    const data = callbackData(
      Object.fromEntries(
        ["state", "code", "error"]
          .filter((key) => url.searchParams.has(key))
          .map((key) => [key, url.searchParams.get(key)]),
      ),
    );
    const nonce = crypto.randomUUID().replaceAll("-", "");
    const json = JSON.stringify({ type: "durableclaw:oauth", ...data })
      .replaceAll("<", "\\u003c")
      .replaceAll("\u2028", "\\u2028")
      .replaceAll("\u2029", "\\u2029");
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Google connection</title><body><p>Return to DurableClaw to finish connecting Google Workspace.</p><script nonce="${nonce}">history.replaceState(null,"",${JSON.stringify(CALLBACK)});if(window.opener){window.opener.postMessage(${json},${JSON.stringify(url.origin)});window.close();}</script></body></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "x-frame-options": "DENY",
          "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
          "cross-origin-opener-policy": "unsafe-none",
        },
      },
    );
  } catch {
    return new Response(
      "Invalid OAuth callback. Close this window and try connecting again.",
      {
        status: 400,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      },
    );
  }
}
export async function routeConnectorOwner(
  request: Request,
  env: Env,
  principal: AgentPrincipal,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    url.pathname !== "/api/connectors" &&
    !url.pathname.startsWith("/api/connectors/")
  )
    return null;
  try {
    if (principal.role !== "owner")
      throw new ConnectorError("Owner access required", 403);
    if (url.pathname === "/api/connectors" && request.method === "GET") {
      const configured = connectorsConfigured(env);
      const [connections, capabilities] = configured
        ? await Promise.all([
            listServiceConnections(env, principal, request.signal),
            callConnectorService(env, principal, "/v1/capabilities", {
              signal: request.signal,
            }),
          ])
        : [[], null];
      const delegation =
        typeof capabilities === "object" &&
        capabilities !== null &&
        "google_workspace_delegation" in capabilities &&
        capabilities.google_workspace_delegation === true;
      const maps =
        typeof capabilities === "object" &&
        capabilities !== null &&
        "google_maps" in capabilities &&
        capabilities.google_maps === true;
      return Response.json({
        configured,
        plugins: connectorRegistry
          .list()
          .map(({ id, label, description }) => ({ id, label, description })),
        services: PUBLIC_GOOGLE_SERVICES.map((item) => ({
          id: item.service,
          label: item.service === "gmail" ? "Gmail" : item.apis.join(", "),
          scopes: item.scopes,
          authorization: item.authorization,
          available:
            item.authorization === "workspace-delegation"
              ? delegation
              : item.authorization === "api-key"
                ? maps
                : true,
          description:
            item.service === "keep"
              ? delegation
                ? "Google Keep uses administrator-approved Workspace delegation for your verified domain account."
                : "The workspace operator must configure Google Keep delegation."
              : item.service === "maps" && !maps
                ? "The workspace operator must configure Google Maps access."
                : item.note,
          requires_workspace: ["admin", "keep", "chat", "groups"].includes(
            item.service,
          ),
        })),
        connections,
      });
    }
    if (
      [
        "/api/connectors/gmail/connect",
        "/api/connectors/google/connect",
      ].includes(url.pathname) &&
      request.method === "POST"
    ) {
      const google = url.pathname === "/api/connectors/google/connect";
      const body = strictObject(
        await boundedJson(request, 4096),
        google ? ["services"] : [],
      );
      if (
        google &&
        (!Array.isArray(body.services) ||
          !body.services.length ||
          body.services.length > 64 ||
          body.services.some(
            (id) =>
              typeof id !== "string" ||
              !PUBLIC_GOOGLE_SERVICES.some((item) => item.service === id),
          ))
      )
        throw new ConnectorError("Select valid Google services", 400);
      const response = (await callConnectorService(
        env,
        principal,
        "/v1/oauth/start",
        {
          method: "POST",
          body: google
            ? { provider: "google", services: body.services }
            : { provider: "gmail" },
          signal: request.signal,
        },
      )) as { authorization_url?: unknown; expires_at?: unknown };
      const target =
        typeof response?.authorization_url === "string" &&
        response.authorization_url.length <= 8192
          ? new URL(response.authorization_url)
          : null;
      if (
        !target ||
        target.origin !== "https://accounts.google.com" ||
        target.pathname !== "/o/oauth2/v2/auth" ||
        target.username ||
        target.password ||
        target.hash ||
        !target.searchParams.get("state") ||
        typeof response.expires_at !== "number" ||
        !Number.isFinite(response.expires_at)
      )
        throw new ConnectorError(
          "Connector returned an invalid authorization URL",
        );
      return Response.json({
        authorization_url: target.href,
        expires_at: response.expires_at,
      });
    }
    if (url.pathname === CALLBACK && request.method === "POST") {
      const data = callbackData(await boundedJson(request, 10000));
      const result = (await callConnectorService(
        env,
        principal,
        "/v1/oauth/callback",
        { method: "POST", body: data, signal: request.signal },
      )) as { connected?: unknown; connection_id?: unknown };
      if (result?.connected !== true || !connectionId(result.connection_id))
        throw new ConnectorError("Google connection did not complete");
      return Response.json({
        connected: true,
        connection_id: result.connection_id,
      });
    }
    const artifact = url.pathname.match(
      /^\/api\/connectors\/artifacts\/([^/]+)\/(.+)$/,
    );
    if (request.method === "GET" && artifact && connectionId(artifact[1])) {
      await currentConnectorOwner(env, principal);
      const name = safePath(decodeURIComponent(artifact[2]));
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(name))
        throw new ConnectorError("Invalid artifact name", 400);
      const object = await env.WORKSPACE.get(
        workspacePrefix(principal.userId, principal.workspaceId) +
          `connector-artifacts/${artifact[1]}/${name}`,
      );
      if (!object) throw new ConnectorError("Artifact unavailable", 404);
      if (object.size > 4 * 1024 * 1024) {
        await object.body.cancel();
        throw new ConnectorError("Artifact exceeds download limit", 413);
      }
      try {
        await currentConnectorOwner(env, principal);
      } catch (error) {
        await object.body.cancel();
        throw error;
      }
      return new Response(object.body, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${name.split("/").at(-1)}"`,
          "cache-control": "no-store",
        },
      });
    }
    const id = url.pathname.match(/^\/api\/connectors\/([^/]+)$/)?.[1];
    if (request.method === "DELETE" && connectionId(id)) {
      const result = (await callConnectorService(
        env,
        principal,
        `/v1/connections/${id}`,
        { method: "DELETE", signal: request.signal },
      )) as { disconnected?: unknown; revoked?: unknown };
      if (result?.disconnected !== true || typeof result.revoked !== "boolean")
        throw new ConnectorError("Disconnect did not complete");
      return Response.json({ disconnected: true, revoked: result.revoked });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof ConnectorError
            ? error.message
            : "Invalid connector request",
      },
      {
        status:
          error instanceof ConnectorError
            ? error.status
            : error instanceof RequestValidationError
              ? error.status
              : 400,
      },
    );
  }
}

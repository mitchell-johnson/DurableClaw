import type { Env, AgentPrincipal } from "./types";
import { validId } from "./utils/validation";
import { accessConfigured, accessSettings, authenticateAccess } from "./access";
import {
  authenticateNative,
  identityStub,
  nativeAuthConfigured,
} from "./nativeAuth";
export async function constantTimeEqual(
  a: string,
  b: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("durableclaw-token-comparison"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(a),
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    new TextEncoder().encode(b),
  );
}
function principal(value: unknown): AgentPrincipal | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<AgentPrincipal>;
  return validId(p.userId) &&
    validId(p.workspaceId) &&
    typeof p.role === "string" &&
    p.role.length < 64
    ? (p as AgentPrincipal)
    : null;
}
export async function authenticate(
  request: Request,
  env: Env,
): Promise<AgentPrincipal | null> {
  if (env.AUTH) {
    const response = await env.AUTH.fetch(
      new Request("https://auth.internal/authenticate", {
        method: "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: request.headers.get("authorization") || "",
          cookie: request.headers.get("cookie") || "",
          "cf-access-jwt-assertion":
            request.headers.get("cf-access-jwt-assertion") || "",
        },
      }),
    );
    return response.ok ? principal(await response.json()) : null;
  }
  if (nativeAuthConfigured(env)) {
    const session = await authenticateNative(request, env);
    if (session) return session;
    return accessConfigured(env) ? authenticateAccess(request, env) : null;
  }
  if (accessConfigured(env)) return authenticateAccess(request, env);
  const token = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  return token &&
    env.AGENT_TOKEN &&
    (await constantTimeEqual(token, env.AGENT_TOKEN))
    ? { userId: "owner", workspaceId: "default", role: "owner" }
    : null;
}
export async function authorizePrincipal(
  env: Env,
  userId: string,
  workspaceId: string,
): Promise<AgentPrincipal> {
  if (env.AUTH) {
    const response = await env.AUTH.fetch("https://auth.internal/authorize", {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, workspaceId }),
    });
    const p = response.ok ? principal(await response.json()) : null;
    if (!p || p.userId !== userId || p.workspaceId !== workspaceId)
      throw new Error("Current authority unavailable");
    return p;
  }
  if (accessConfigured(env) && !nativeAuthConfigured(env)) accessSettings(env);
  if (nativeAuthConfigured(env)) identityStub(env);
  if (
    (!nativeAuthConfigured(env) &&
      !accessConfigured(env) &&
      !env.AGENT_TOKEN) ||
    userId !== "owner" ||
    workspaceId !== "default"
  )
    throw new Error("Current authority unavailable");
  return { userId, workspaceId, role: "owner" };
}

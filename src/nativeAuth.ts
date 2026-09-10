import type { AgentPrincipal, Env } from "./types";
import { accessConfigured, authenticateAccessEvidence } from "./access";

export function nativeAuthConfigured(env: Env): boolean {
  return Boolean(env.AUTH_ORIGIN || env.AUTH_SECRET);
}

export function identityStub(env: Env) {
  const origin = new URL(env.AUTH_ORIGIN || "https://invalid.invalid");
  if (
    !env.AUTH_ORIGIN ||
    origin.origin !== env.AUTH_ORIGIN ||
    origin.protocol !== "https:" ||
    !env.AUTH_SECRET ||
    env.AUTH_SECRET.length < 32 ||
    !env.IDENTITY ||
    !env.ACCESS_OWNER_EMAIL
  )
    throw new Error("Native authentication is not configured");
  return env.IDENTITY.get(env.IDENTITY.idFromName("owner/default"));
}

export async function authenticateNative(
  request: Request,
  env: Env,
): Promise<AgentPrincipal | null> {
  if (!nativeAuthConfigured(env)) return null;
  if (new URL(request.url).origin !== env.AUTH_ORIGIN) return null;
  return identityStub(env).session(
    new Request(request.url, {
      headers: { cookie: request.headers.get("cookie") || "" },
    }),
  );
}

export async function routeNativeAuth(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/auth/")) return null;
  if (url.pathname === "/api/auth/options" && request.method === "GET") {
    return Response.json({
      enabled: nativeAuthConfigured(env),
      accessRecovery: nativeAuthConfigured(env) && accessConfigured(env),
    });
  }
  if (!nativeAuthConfigured(env))
    return Response.json({ error: "Not found" }, { status: 404 });
  if (url.origin !== env.AUTH_ORIGIN)
    return Response.json({ error: "Origin rejected" }, { status: 403 });
  const stub = identityStub(env);
  if (url.pathname === "/api/auth/access" && request.method === "GET") {
    const evidence = await authenticateAccessEvidence(request, env);
    if (!evidence || evidence.principal.role !== "owner")
      return Response.json(
        { error: "Verified owner sign-in required" },
        { status: 401 },
      );
    return stub.bootstrapAccess(
      new Request(request.url, {
        headers: {
          "user-agent": request.headers.get("user-agent") || "",
          "cf-connecting-ip":
            request.headers.get("cf-connecting-ip") || "unknown",
        },
      }),
      {
        issuedAt: evidence.issuedAt,
        expiresAt: evidence.expiresAt,
        authenticatedAt: evidence.authenticatedAt,
      },
    );
  }
  return stub.fetch(request);
}

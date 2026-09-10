import { createRemoteJWKSet, jwtVerify, customFetch } from "jose";
import type { Env, AgentPrincipal } from "./types";

/** Partial configuration must fail closed instead of re-enabling bearer auth. */
export function accessConfigured(env: Env): boolean {
  return Boolean(
    env.ACCESS_TEAM_DOMAIN || env.ACCESS_AUD || env.ACCESS_OWNER_EMAIL,
  );
}

export function accessSettings(env: Env) {
  const issuer = env.ACCESS_TEAM_DOMAIN?.replace(/\/$/, "");
  if (
    !issuer ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) ||
    !env.ACCESS_AUD?.trim() ||
    !env.ACCESS_OWNER_EMAIL?.trim() ||
    env.ACCESS_OWNER_EMAIL.length > 254
  ) {
    throw new Error("Access configuration is incomplete");
  }
  return {
    issuer,
    audience: env.ACCESS_AUD,
    email: env.ACCESS_OWNER_EMAIL.trim().toLowerCase(),
  };
}

// Only public verification keys are cached. No identity or request state is shared.
let cachedKeys:
  { issuer: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;
export async function authenticateAccess(
  request: Request,
  env: Env,
): Promise<AgentPrincipal | null> {
  return (await authenticateAccessEvidence(request, env))?.principal ?? null;
}

export interface AccessEvidence {
  principal: AgentPrincipal;
  issuedAt: number;
  expiresAt: number;
  authenticatedAt: number | null;
}

/** Issuance is not proof of a new IdP login. Preserve both clocks separately. */
export async function authenticateAccessEvidence(
  request: Request,
  env: Env,
): Promise<AccessEvidence | null> {
  try {
    const settings = accessSettings(env);
    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token || token.length > 16384) {
      return null;
    }
    if (cachedKeys?.issuer !== settings.issuer) {
      cachedKeys = {
        issuer: settings.issuer,
        keys: createRemoteJWKSet(
          new URL(settings.issuer + "/cdn-cgi/access/certs"),
          {
            timeoutDuration: 5000,
            cacheMaxAge: 5 * 60 * 1000,
            // Workerd supports manual/follow only. jose rejects every non-200
            // JWKS response, so redirects are rejected without following them.
            [customFetch]: (input, init) =>
              fetch(input, { ...init, redirect: "manual" }),
          },
        ),
      };
    }
    const { payload } = await jwtVerify(token, cachedKeys.keys, {
      issuer: settings.issuer,
      audience: settings.audience,
      algorithms: ["RS256"],
      requiredClaims: ["iss", "aud", "exp", "iat", "sub", "email"],
      clockTolerance: 5,
    });
    if (
      typeof payload.email !== "string" ||
      payload.email.toLowerCase() !== settings.email ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.iat! <= 0 ||
      payload.iat! * 1000 > Date.now() + 5000 ||
      payload.exp! <= payload.iat!
    ) {
      return null;
    }
    const authTime = payload.auth_time;
    return {
      principal: { userId: "owner", workspaceId: "default", role: "owner" },
      issuedAt: payload.iat! * 1000,
      expiresAt: payload.exp! * 1000,
      authenticatedAt:
        typeof authTime === "number" &&
        Number.isSafeInteger(authTime) &&
        authTime > 0 &&
        authTime <= payload.iat!
          ? authTime * 1000
          : null,
    };
  } catch {
    return null;
  }
}

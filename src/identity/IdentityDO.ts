import { DurableObject } from "cloudflare:workers";
import { APIError } from "better-auth/api";
import type { Env } from "../env";
import {
  BOOTSTRAP_PATH,
  createIdentityAuth,
  identityConfig,
  OWNER_ID,
} from "./auth";
import { migrateIdentity } from "./schema";
import {
  boundedJson,
  consumeRateLimits,
  enrollmentCompleted,
  freshAuthority,
  recoveryAuthority,
  validAccessEvidence,
  type AccessEvidence,
} from "./security";

const READ_ROUTES = new Set([
  "/get-session",
  "/security",
  "/passkey/list-user-passkeys",
  "/passkey/generate-register-options",
  "/passkey/generate-authenticate-options",
]);
const WRITE_ROUTES = new Set([
  "/sign-in/email",
  "/sign-out",
  "/change-password",
  "/set-password",
  "/recover-password",
  "/passkey/verify-registration",
  "/passkey/verify-authentication",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
]);
const FRESH_ROUTES = new Set([
  "/change-password",
  "/set-password",
  "/recover-password",
  "/passkey/generate-register-options",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
]);
const PRIVATE_READ_ROUTES = new Set([
  "/security",
  "/passkey/list-user-passkeys",
]);
export interface IdentityPrincipal {
  userId: "owner";
  workspaceId: "default";
  role: "owner";
}

function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export class IdentityDO extends DurableObject<Env> {
  private readonly config;
  private readonly identity;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = identityConfig(env);
    ctx.blockConcurrencyWhile(async () => {
      migrateIdentity(ctx.storage);
      if ((await ctx.storage.getAlarm()) === null)
        await ctx.storage.setAlarm(Date.now() + 3_600_000);
    });
    this.identity = createIdentityAuth(ctx.storage, this.config);
  }

  private async ownerSession(request: Request) {
    if (new URL(request.url).origin !== this.config.origin) return null;
    const session = await this.identity.auth.api.getSession({
      headers: request.headers,
      query: { disableCookieCache: true },
    });
    if (
      !session ||
      session.user.id !== OWNER_ID ||
      session.user.email !== this.config.email ||
      !session.user.emailVerified
    )
      return null;
    return session;
  }

  /** Binding-only identity lookup; root never trusts identity supplied by clients. */
  async session(request: Request): Promise<IdentityPrincipal | null> {
    return (await this.ownerSession(request))
      ? { userId: "owner", workspaceId: "default", role: "owner" }
      : null;
  }

  /** Private binding metadata for a signed WebSocket attachment, never a token. */
  async sessionReference(
    request: Request,
  ): Promise<{ id: string; expiresAt: number } | null> {
    const current = await this.ownerSession(request);
    if (!current) return null;
    return {
      id: current.session.id,
      expiresAt: new Date(current.session.expiresAt).getTime(),
    };
  }

  /** Revalidate a previously authenticated reference; not an HTTP login API. */
  async sessionActive(id: string): Promise<boolean> {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id))
      return false;
    return (
      this.ctx.storage.sql
        .exec(
          `SELECT 1 FROM identity_session s
           JOIN identity_user u ON u.id = s.user_id
           WHERE s.id = ? AND s.user_id = ? AND s.expires_at > ?
             AND u.email = ? AND u.email_verified = 1 LIMIT 1`,
          id,
          OWNER_ID,
          Date.now(),
          this.config.email,
        )
        .toArray().length === 1
    );
  }

  /** Root must verify Access issuer, audience and immutable owner before calling. */
  async bootstrapAccess(
    request: Request,
    evidence: AccessEvidence,
  ): Promise<Response> {
    if (new URL(request.url).origin !== this.config.origin)
      return json({ error: "Invalid origin" }, 403);
    if (!validAccessEvidence(evidence))
      return json({ error: "Invalid Access evidence" }, 403);
    if (!this.limit(request, "bootstrap", 10))
      return json({ error: "Try again later" }, 429);
    const headers = new Headers(request.headers);
    headers.set("origin", this.config.origin);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    const internal = new Request(
      `${this.config.origin}/api/auth${BOOTSTRAP_PATH}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          issuedAt: evidence.issuedAt,
          expiresAt: evidence.expiresAt,
          authenticatedAt: evidence.authenticatedAt,
        }),
      },
    );
    return this.dispatch(internal, true);
  }

  private limit(request: Request, category: string, maximum: number): boolean {
    // This header is supplied by Cloudflare and preserved only by the root Worker.
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    return consumeRateLimits(
      this.ctx.storage,
      [`${category}:ip:${ip.slice(0, 64)}`, `${category}:owner`],
      maximum,
      300_000,
    );
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (
        url.origin !== this.config.origin ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        return json({ error: "Invalid origin" }, 403);
      const path = url.pathname.startsWith("/api/auth/")
        ? url.pathname.slice("/api/auth".length)
        : "";
      if (
        !(request.method === "GET" && READ_ROUTES.has(path)) &&
        !(request.method === "POST" && WRITE_ROUTES.has(path))
      )
        return json({ error: "Not found" }, 404);
      if (
        request.method === "POST" &&
        request.headers.get("origin") !== this.config.origin
      )
        return json({ error: "Same origin required" }, 403);
      if (
        request.method === "POST" &&
        request.headers
          .get("content-type")
          ?.split(";")[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        return json({ error: "JSON required" }, 415);
      const category =
        path === "/sign-in/email"
          ? "password"
          : path.includes("verify-")
            ? "verification"
            : request.method === "POST"
              ? "settings"
              : "read";
      if (
        !this.limit(
          request,
          category,
          category === "password" ? 10 : category === "read" ? 120 : 30,
        )
      )
        return json({ error: "Try again later" }, 429);

      let forwarded = request;
      if (request.method === "POST") {
        const body = await boundedJson(request);
        if (
          path === "/sign-in/email" &&
          (typeof body.email !== "string" ||
            body.email.length > 254 ||
            typeof body.password !== "string" ||
            body.password.length < 15 ||
            body.password.length > 128)
        )
          return json({ error: "Invalid email or password" }, 401);
        if (path === "/change-password") body.revokeOtherSessions = true;
        if (path === "/passkey/verify-registration") body.createSession = true;
        forwarded = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(body),
        });
      }
      const execute = async () => {
        let currentToken: string | undefined;
        if (FRESH_ROUTES.has(path) || PRIVATE_READ_ROUTES.has(path)) {
          const session = await this.ownerSession(forwarded);
          if (!session) return json({ error: "Unauthorized" }, 401);
          currentToken = session.session.token;
          if (
            FRESH_ROUTES.has(path) &&
            !freshAuthority(
              session.session,
              enrollmentCompleted(this.ctx.storage),
            )
          )
            return json(
              {
                code: "FRESH_SESSION_REQUIRED",
                error: "Sign in again to change security settings",
              },
              403,
            );
          if (path === "/security") return this.security(session);
        }
        const response = await this.dispatch(forwarded, false);
        if (path === "/passkey/delete-passkey" && response.ok && currentToken) {
          this.ctx.storage.sql.exec(
            "DELETE FROM identity_session WHERE user_id = ? AND token != ?",
            OWNER_ID,
            currentToken,
          );
        }
        return response;
      };
      return request.method === "POST" || path.includes("generate-")
        ? await this.identity.transaction(execute)
        : await execute();
    } catch (error) {
      if (error instanceof Response) return error;
      if (error instanceof APIError)
        return json(
          { error: error.body?.message || "Invalid request" },
          error.statusCode,
        );
      return json({ error: "Authentication is unavailable" }, 503);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM identity_session WHERE expires_at <= ?",
        now,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM identity_verification WHERE expires_at <= ?",
        now,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM identity_rate_limit WHERE reset_at <= ?",
        now,
      );
    });
    await this.ctx.storage.setAlarm(now + 3_600_000);
  }

  private async security(
    session: NonNullable<Awaited<ReturnType<IdentityDO["ownerSession"]>>>,
  ) {
    const context = await this.identity.auth.$context;
    const credential =
      await context.internalAdapter.findCredentialAccount(OWNER_ID);
    const passkeys = this.ctx.storage.sql
      .exec<{ id: string; name: string | null; createdAt: number | null }>(
        "SELECT id,name,created_at AS createdAt FROM identity_passkey WHERE user_id = ? ORDER BY created_at",
        OWNER_ID,
      )
      .toArray();
    const enrolled = enrollmentCompleted(this.ctx.storage);
    const fresh = freshAuthority(session.session, enrolled);
    return json({
      email: this.config.email,
      passwordSet: Boolean(credential?.password),
      passkeys: passkeys.map((key) => ({
        ...key,
        createdAt: key.createdAt ? new Date(key.createdAt).toISOString() : null,
      })),
      fresh,
      canRecover: recoveryAuthority(session.session, enrolled),
      enrollmentPending: !enrolled,
    });
  }

  private async dispatch(
    request: Request,
    bootstrap: boolean,
  ): Promise<Response> {
    const run = async () => {
      const response = await this.identity.auth.handler(request);
      if (response.status >= 500)
        throw json({ error: "Authentication is unavailable" }, 503);
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      if (bootstrap && response.status >= 300 && response.status < 400)
        return new Response(null, { status: 303, headers });
      if (headers.get("content-type")?.includes("application/json")) {
        const data = (await response.json()) as Record<string, unknown> | null;
        if (data && typeof data === "object") {
          // Upstream 1.7.3 hardcodes "preferred" in authentication options.
          // The afterVerification hook independently enforces the signed UV bit.
          if (
            new URL(request.url).pathname ===
              "/api/auth/passkey/generate-authenticate-options" &&
            response.ok
          )
            data.userVerification = "required";
          // Session credentials stay in HttpOnly cookies, never in browser JSON.
          delete data.token;
          if (data.session && typeof data.session === "object") {
            const session = data.session as Record<string, unknown>;
            delete session.token;
            delete session.ipAddress;
            delete session.userAgent;
          }
        }
        headers.delete("content-length");
        return new Response(JSON.stringify(data), {
          status: response.status,
          headers,
        });
      }
      return new Response(response.body, { status: response.status, headers });
    };
    return bootstrap ? this.identity.transaction(run) : run();
  }
}

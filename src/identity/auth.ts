import { betterAuth, type GenericEndpointContext } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  freshSessionMiddleware,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { passkey } from "@better-auth/passkey";
import { z } from "zod";
import { createIdentityAdapter } from "./adapter";
import {
  accessSessionProof,
  completeEnrollment,
  enrollmentCompleted,
  recoveryAuthority,
  requireUserVerification,
  validAccessEvidence,
} from "./security";

export const OWNER_ID = "owner";
export const BOOTSTRAP_PATH = "/__access-bootstrap";
export interface IdentityConfig {
  origin: string;
  secret: string;
  email: string;
}

export function identityConfig(env: {
  AUTH_ORIGIN?: string;
  AUTH_SECRET?: string;
  ACCESS_OWNER_EMAIL?: string;
}): IdentityConfig {
  const url = new URL(env.AUTH_ORIGIN ?? "invalid:");
  if (
    url.protocol !== "https:" ||
    url.origin !== env.AUTH_ORIGIN ||
    url.username ||
    url.password ||
    (env.AUTH_SECRET?.length ?? 0) < 32
  ) {
    throw new Error("Native authentication configuration is invalid");
  }
  const email = env.ACCESS_OWNER_EMAIL?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Owner identity is not configured");
  return { origin: url.origin, secret: env.AUTH_SECRET!, email };
}

async function replacePassword(
  ctx: GenericEndpointContext,
  password: string,
  recovery: boolean,
  storage: DurableObjectStorage,
) {
  const session = ctx.context.session;
  if (!session || session.user.id !== OWNER_ID)
    throw new APIError("UNAUTHORIZED");
  if (
    recovery &&
    !recoveryAuthority(session.session, enrollmentCompleted(storage))
  ) {
    throw new APIError("FORBIDDEN", {
      code: "FRESH_RECOVERY_REQUIRED",
      message:
        "Use a passkey or recent upstream reauthentication to recover your password.",
    });
  }
  const account =
    await ctx.context.internalAdapter.findCredentialAccount(OWNER_ID);
  if (!recovery && account?.password)
    throw new APIError("BAD_REQUEST", { message: "Password already set." });
  const passwordHash = await ctx.context.password.hash(password);
  if (account)
    await ctx.context.internalAdapter.updateAccount(account.id, {
      password: passwordHash,
    });
  else
    await ctx.context.internalAdapter.linkAccount({
      userId: OWNER_ID,
      providerId: "credential",
      accountId: OWNER_ID,
      password: passwordHash,
    });
  await ctx.context.internalAdapter.deleteUserSessions(OWNER_ID);
  // Recovery proves control once; it must not continuously renew Access recovery.
  const replacement = await ctx.context.internalAdapter.createSession(
    OWNER_ID,
    false,
    { authMethod: "password" },
    true,
  );
  await setSessionCookie(ctx, { session: replacement, user: session.user });
  return ctx.json({ status: true });
}

export function createIdentityAuth(
  storage: DurableObjectStorage,
  config: IdentityConfig,
) {
  const adapter = createIdentityAdapter(storage);
  const passwordBody = z
    .object({ newPassword: z.string().min(15).max(128) })
    .strict();
  const auth = betterAuth({
    appName: "DurableClaw",
    baseURL: config.origin,
    basePath: "/api/auth",
    secret: config.secret,
    trustedOrigins: [config.origin],
    database: adapter.database,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true,
      minPasswordLength: 15,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
    },
    session: {
      expiresIn: 86_400,
      freshAge: 300,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        authMethod: {
          type: "string",
          required: true,
          defaultValue: "password",
          input: false,
        },
        authProof: {
          type: "string",
          required: true,
          defaultValue: "none",
          input: false,
        },
      },
    },
    account: { accountLinking: { enabled: false } },
    user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    advanced: {
      // Disable the automatic __Secure- prefix so the explicit __Host- name
      // receives browser prefix enforcement. Secure stays mandatory below.
      useSecureCookies: false,
      cookiePrefix: "durableclaw",
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      },
      cookies: {
        session_token: { name: "__Host-durableclaw.session_token" },
        "durableclaw-passkey": { name: "__Host-durableclaw.passkey_challenge" },
      },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    // Atomic limits are enforced in IdentityDO before parsing/hash verification.
    rateLimit: { enabled: false },
    logger: { disabled: true },
    telemetry: { enabled: false },
    databaseHooks: {
      session: {
        create: {
          before: async (value, context) => {
            if (value.userId !== OWNER_ID) return false;
            const path = context?.path;
            const authMethod =
              path === BOOTSTRAP_PATH
                ? "access"
                : path === "/passkey/verify-authentication" ||
                    path === "/passkey/verify-registration"
                  ? "passkey"
                  : "password";
            return {
              data: {
                ...value,
                authMethod,
                authProof: authMethod === "access" ? value.authProof : "native",
              },
            };
          },
          after: async (value) => {
            if (
              value.authMethod === "password" ||
              value.authMethod === "passkey"
            )
              completeEnrollment(storage);
          },
        },
      },
    },
    plugins: [
      passkey({
        rpID: new URL(config.origin).hostname,
        rpName: "DurableClaw",
        origin: config.origin,
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
        advanced: { webAuthnChallengeCookie: "durableclaw-passkey" },
        registration: {
          requireSession: true,
          afterVerification: async ({ verification, user }) => {
            requireUserVerification(
              verification.registrationInfo?.userVerified,
            );
            if (user.id !== OWNER_ID) throw new APIError("FORBIDDEN");
          },
        },
        authentication: {
          afterVerification: async ({ verification }) => {
            requireUserVerification(
              verification.authenticationInfo.userVerified,
            );
          },
        },
      }),
      {
        id: "durableclaw-owner",
        endpoints: {
          bootstrapOwner: createAuthEndpoint(
            BOOTSTRAP_PATH,
            {
              method: "POST",
              body: z
                .object({
                  issuedAt: z.number(),
                  expiresAt: z.number(),
                  authenticatedAt: z.number().nullable(),
                })
                .strict(),
            },
            async (ctx) => {
              // Only IdentityDO.bootstrapAccess can reach this endpoint.
              if (!validAccessEvidence(ctx.body))
                throw new APIError("FORBIDDEN");
              let owner =
                await ctx.context.internalAdapter.findUserById(OWNER_ID);
              if (!owner) {
                owner = await ctx.context.adapter.create({
                  model: "user",
                  forceAllowId: true,
                  data: {
                    id: OWNER_ID,
                    name: "Owner",
                    email: config.email,
                    emailVerified: true,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                  },
                });
              }
              if (
                !owner ||
                owner.email !== config.email ||
                !owner.emailVerified
              )
                throw new APIError("FORBIDDEN");
              const session = await ctx.context.internalAdapter.createSession(
                OWNER_ID,
                false,
                {
                  authMethod: "access",
                  ...accessSessionProof(ctx.body, enrollmentCompleted(storage)),
                  expiresAt: new Date(
                    Math.min(Date.now() + 86_400_000, ctx.body.expiresAt),
                  ),
                },
                true,
              );
              await setSessionCookie(ctx, { session, user: owner }, false, {
                maxAge: Math.max(
                  1,
                  Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
                ),
              });
              return ctx.redirect("/");
            },
          ),
          setOwnerPassword: createAuthEndpoint(
            "/set-password",
            {
              method: "POST",
              body: passwordBody,
              use: [freshSessionMiddleware],
            },
            (ctx) => replacePassword(ctx, ctx.body.newPassword, false, storage),
          ),
          recoverOwnerPassword: createAuthEndpoint(
            "/recover-password",
            {
              method: "POST",
              body: passwordBody,
              use: [freshSessionMiddleware],
            },
            (ctx) => replacePassword(ctx, ctx.body.newPassword, true, storage),
          ),
        },
      },
    ],
  });
  return { auth, transaction: adapter.transaction };
}

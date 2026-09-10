import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { authenticate, authorizePrincipal } from "../src/auth";
import type { Env } from "../src/types";

const issuer = "https://test-team.cloudflareaccess.com";
const env = {
  ACCESS_TEAM_DOMAIN: issuer,
  ACCESS_AUD: "test-app-audience",
  ACCESS_OWNER_EMAIL: "owner@example.invalid",
  AGENT_TOKEN: "legacy-token-must-not-work",
} as Env;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => {
  keys = await generateKeyPair("RS256");
});
afterEach(() => vi.unstubAllGlobals());
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ email: env.ACCESS_OWNER_EMAIL, ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "key-1" })
    .setIssuer(String(overrides.iss ?? issuer))
    .setAudience(String(overrides.aud ?? env.ACCESS_AUD))
    .setSubject("access-owner-subject")
    .setIssuedAt()
    .setExpirationTime((overrides.exp as number | string) ?? "5m")
    .sign(keys.privateKey);
}
async function authenticateToken(jwt: string, settings = env) {
  const jwk = await exportJWK(keys.publicKey);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) => {
      expect(String(url)).toBe(issuer + "/cdn-cgi/access/certs");
      return Response.json({ keys: [{ ...jwk, kid: "key-1", alg: "RS256" }] });
    }),
  );
  return authenticate(
    new Request("https://app.example.invalid/api/session", {
      headers: { "cf-access-jwt-assertion": jwt },
    }),
    settings,
  );
}
describe("Cloudflare Access owner authentication", () => {
  it("maps a verified application token to the existing owner", async () => {
    expect(await authenticateToken(await token())).toEqual({
      userId: "owner",
      workspaceId: "default",
      role: "owner",
    });
  });
  it.each([
    { aud: "another-app" },
    { iss: "https://attacker.cloudflareaccess.com" },
    { exp: 1 },
    { email: "someone-else@example.invalid" },
  ])("rejects mismatched or expired claims %j", async (claims) => {
    expect(await authenticateToken(await token(claims))).toBeNull();
  });
  it("rejects a forged signature", async () => {
    const jwt = await token();
    expect(
      await authenticateToken(jwt.slice(0, -20) + "A".repeat(20)),
    ).toBeNull();
  });
  it("requires expiration even with a valid signature", async () => {
    const jwt = await new SignJWT({ email: env.ACCESS_OWNER_EMAIL })
      .setProtectedHeader({ alg: "RS256", kid: "key-1" })
      .setIssuer(issuer)
      .setAudience(env.ACCESS_AUD!)
      .setSubject("owner")
      .setIssuedAt()
      .sign(keys.privateKey);
    expect(await authenticateToken(jwt)).toBeNull();
  });
  it("never falls back to the legacy token when Access is configured or incomplete", async () => {
    const request = new Request("https://app.example.invalid/api/session", {
      headers: { authorization: "Bearer legacy-token-must-not-work" },
    });
    expect(await authenticate(request, env)).toBeNull();
    expect(
      await authenticate(request, {
        AGENT_TOKEN: env.AGENT_TOKEN,
        ACCESS_AUD: "partial",
      } as Env),
    ).toBeNull();
  });
  it("fails closed on malformed issuer config and live authority removal", async () => {
    expect(
      await authenticateToken(await token(), {
        ...env,
        ACCESS_TEAM_DOMAIN: "http://localhost",
      }),
    ).toBeNull();
    await expect(
      authorizePrincipal(env, "owner", "default"),
    ).resolves.toMatchObject({ role: "owner" });
    await expect(
      authorizePrincipal(
        { ...env, ACCESS_OWNER_EMAIL: "" },
        "owner",
        "default",
      ),
    ).rejects.toThrow();
    await expect(
      authorizePrincipal(env, "other-user", "default"),
    ).rejects.toThrow();
  });
});

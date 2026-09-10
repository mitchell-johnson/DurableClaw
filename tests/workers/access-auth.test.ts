import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { authenticateAccess } from "../../src/access";
import type { Env } from "../../src/types";

let privateKey: CryptoKey;
let jwks: { keys: Record<string, unknown>[] };
const audience = "test-access-application";
const email = "owner@example.test";
const owner = { userId: "owner", workspaceId: "default", role: "owner" };

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  jwks = {
    keys: [
      {
        ...(await exportJWK(pair.publicKey)),
        kid: "test-key",
        alg: "RS256",
        use: "sig",
      },
    ],
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function assertion(
  issuer: string,
  claims: Record<string, unknown> = {},
  tokenAudience = audience,
) {
  return new SignJWT({ email, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(tokenAudience)
    .setSubject("test-owner-id")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
}

function settings(issuer: string): Env {
  return {
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUD: audience,
    ACCESS_OWNER_EMAIL: email,
  } as Env;
}

describe("Access verification on workerd", () => {
  it("verifies real RS256 owner assertions and reuses only public verification keys", async () => {
    const issuer = "https://access-owner-test.cloudflareaccess.com";
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        // Keep native Request validation: a plain Response stub hides unsupported
        // request options such as redirect:"error" in workerd.
        const request = new Request(input, init);
        expect(request.url).toBe(issuer + "/cdn-cgi/access/certs");
        expect(request.method).toBe("GET");
        expect(request.redirect).toBe("manual");
        expect(request.signal).toBeInstanceOf(AbortSignal);
        expect(request.headers.has("authorization")).toBe(false);
        expect(request.headers.has("cf-access-jwt-assertion")).toBe(false);
        return Response.json(jwks);
      });
    const request = new Request(
      "https://app.example.test/api/agent/conversations",
      {
        headers: { "cf-access-jwt-assertion": await assertion(issuer) },
      },
    );
    expect(await authenticateAccess(request, settings(issuer))).toEqual(owner);
    const second = new Request(request.url, {
      headers: { "cf-access-jwt-assertion": await assertion(issuer) },
    });
    expect(await authenticateAccess(second, settings(issuer))).toEqual(owner);
    const nonOwner = new Request(request.url, {
      headers: {
        "cf-access-jwt-assertion": await assertion(issuer, {
          email: "someone-else@example.test",
        }),
      },
    });
    expect(await authenticateAccess(nonOwner, settings(issuer))).toBeNull();
    const wrongAudience = new Request(request.url, {
      headers: {
        "cf-access-jwt-assertion": await assertion(
          issuer,
          {},
          "another-application",
        ),
      },
    });
    expect(
      await authenticateAccess(wrongAudience, settings(issuer)),
    ).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([301, 302, 307, 308])(
    "rejects a %i JWKS redirect without following it",
    async (status) => {
      const issuer = `https://access-redirect-${status}.cloudflareaccess.com`;
      const fetcher = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const request = new Request(input, init);
          expect(request.url).toBe(issuer + "/cdn-cgi/access/certs");
          expect(request.redirect).toBe("manual");
          return new Response(null, {
            status,
            headers: { location: "https://unexpected.example.test/keys" },
          });
        });
      const request = new Request(
        "https://app.example.test/api/agent/conversations",
        {
          headers: { "cf-access-jwt-assertion": await assertion(issuer) },
        },
      );
      expect(await authenticateAccess(request, settings(issuer))).toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
});

import { describe, expect, it, vi } from "vitest";
import server from "../src/server";
import { authenticate, authorizePrincipal } from "../src/auth";
import type { Env } from "../src/types";
import * as access from "../src/access";

const origin = "https://identity.example.test";
const owner = { userId: "owner", workspaceId: "default", role: "owner" };
function setup() {
  const stub = {
    session: vi.fn(async () => null as typeof owner | null),
    fetch: vi.fn(async () => new Response(null, { status: 404 })),
    bootstrapAccess: vi.fn(),
  };
  const env = {
    AUTH_ORIGIN: origin,
    AUTH_SECRET: "unit-test-secret-that-is-at-least-32-bytes",
    ACCESS_OWNER_EMAIL: "owner@example.test",
    IDENTITY: { idFromName: vi.fn((name) => name), get: vi.fn(() => stub) },
    AGENT_TOKEN: "old-token-that-must-not-bypass-native-auth",
  } as unknown as Env;
  return { stub, env };
}
describe("native authentication at the outer Worker", () => {
  it("rejects upgrade attempts on alternate allowlisted routes before proxying", async () => {
    const { env, stub } = setup();
    stub.session.mockResolvedValue(owner);
    for (const path of [
      "/api/agent/init",
      "/api/agent/persona",
      "/api/agent/conversations",
      "/api/auth/access",
    ]) {
      const response = await server.fetch(
        new Request(origin + path + "?conversation_id=forged", {
          headers: { Upgrade: "websocket", cookie: "test-cookie" },
        }),
        env,
      );
      expect(response.status).toBe(400);
    }
    expect(stub.session).not.toHaveBeenCalled();
  });
  it("does not accept Access authority in place of a native socket session", async () => {
    const { env, stub } = setup();
    const verifiedAccess = vi
      .spyOn(access, "authenticateAccess")
      .mockResolvedValue(owner);
    Object.assign(stub, { sessionReference: async () => null });
    const target = {
      fetch: vi.fn(async () => new Response(null, { status: 200 })),
    };
    Object.assign(env, {
      CONTROL_DB: {
        prepare: () => ({
          bind: () => ({
            first: async () => ({ user_id: "owner", workspace_id: "default" }),
          }),
        }),
      },
      NANO_CHAT_AGENT: {
        idFromName: (name: string) => name,
        get: () => target,
      },
      INTERNAL_AUTH_SECRET: "test-internal-key",
    });
    try {
      const response = await server.fetch(
        new Request(
          origin + "/api/agent/connect?conversation_id=test&ticket=test-ticket",
          {
            headers: {
              Upgrade: "websocket",
              "cf-access-jwt-assertion": "verified-by-test-adapter",
            },
          },
        ),
        env,
      );
      expect(response.status).toBe(401);
      expect(target.fetch).not.toHaveBeenCalled();
    } finally {
      verifiedAccess.mockRestore();
    }
  });
  it("does not fall back to an old bearer token in a native installation", async () => {
    const { env } = setup();
    expect(
      await authenticate(
        new Request(origin + "/api/session", {
          headers: { authorization: `Bearer ${env.AGENT_TOKEN}` },
        }),
        env,
      ),
    ).toBeNull();
  });
  it("returns only the verified owner and identifies native cookie login", async () => {
    const { env, stub } = setup();
    stub.session.mockResolvedValue(owner);
    const response = await server.fetch(
      new Request(origin + "/api/session", {
        headers: { cookie: "test-cookie" },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: true,
      auth_mode: "native",
      principal: owner,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("never bootstraps from a forged Access assertion", async () => {
    const { env, stub } = setup();
    const response = await server.fetch(
      new Request(origin + "/api/auth/access", {
        headers: { "cf-access-jwt-assertion": "forged" },
      }),
      env,
    );
    expect(response.status).toBe(401);
    expect(stub.bootstrapAccess).not.toHaveBeenCalled();
  });
  it("rejects a different host before consulting identity storage", async () => {
    const { env, stub } = setup();
    const response = await server.fetch(
      new Request("https://attacker.test/api/auth/sign-in/email", {
        method: "POST",
        body: "{}",
        headers: {
          origin: "https://attacker.test",
          "content-type": "application/json",
        },
      }),
      env,
    );
    expect(response.status).toBe(403);
    expect(stub.fetch).not.toHaveBeenCalled();
  });
  it("preserves owner-only background authority", async () => {
    const { env } = setup();
    expect(await authorizePrincipal(env, "owner", "default")).toEqual(owner);
    await expect(
      authorizePrincipal(env, "someone-else", "default"),
    ).rejects.toThrow();
    await expect(
      authorizePrincipal(env, "owner", "another-workspace"),
    ).rejects.toThrow();
  });
});

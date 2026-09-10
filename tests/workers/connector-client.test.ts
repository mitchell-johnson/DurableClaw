import { describe, expect, it } from "vitest";
import { callConnectorService } from "../../src/connectors/client";
import type { Env } from "../../src/types";

describe("connector client on workerd", () => {
  it("constructs a supported signed service request and rejects redirect responses", async () => {
    const owner = { userId: "owner", workspaceId: "default", role: "owner" };
    let request: Request | undefined;
    const env = {
      AGENT_TOKEN: "test",
      CONNECTOR_AUTH_SECRET: "test-auth-secret-at-least-32-bytes",
      CONNECTORS: {
        fetch: async (value: Request) => {
          request = value;
          return Response.json({ connections: [] });
        },
      },
    } as unknown as Env;
    expect(await callConnectorService(env, owner, "/v1/connections")).toEqual({
      connections: [],
    });
    expect(request?.headers.get("X-Internal-Signature")).toMatch(
      /^[a-f0-9]{64}$/,
    );
    env.CONNECTORS = {
      fetch: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://example.com" },
        }),
    } as unknown as Fetcher;
    await expect(
      callConnectorService(env, owner, "/v1/connections"),
    ).rejects.toThrow("unavailable");
  });
});

import { describe, expect, it } from "vitest";
import server from "../src/server";

describe("owner session boundary", () => {
  it("returns authenticated owner identity without credentials", async () => {
    const response = await server.fetch(
      new Request("https://app.invalid/api/session", {
        headers: { authorization: "Bearer secret" },
      }),
      { AGENT_TOKEN: "secret" } as any,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authenticated: true,
      auth_mode: "token",
      principal: { userId: "owner", workspaceId: "default", role: "owner" },
    });
  });
  it("rejects cross-site Fetch requests even if Origin is absent", async () => {
    const response = await server.fetch(
      new Request("https://app.invalid/api/session", {
        headers: {
          authorization: "Bearer secret",
          "sec-fetch-site": "cross-site",
        },
      }),
      { AGENT_TOKEN: "secret" } as any,
    );
    expect(response.status).toBe(403);
  });
  it("does not expose internal message or device policy endpoints through the proxy", async () => {
    for (const path of ["channel-message", "device-policy"]) {
      const response = await server.fetch(
        new Request("https://app.invalid/api/agent/" + path, {
          headers: { authorization: "Bearer secret" },
        }),
        { AGENT_TOKEN: "secret" } as any,
      );
      expect(response.status).toBe(404);
    }
  });
});

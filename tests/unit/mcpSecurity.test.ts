import { describe, it, expect, vi } from "vitest";
import { callMCPTool } from "../../src/durable-objects/assistant/mcpClient";
import {
  encryptCredentials,
  decryptCredentials,
} from "../../src/durable-objects/assistant/mcpCrypto";
const input = {
  env: {} as any,
  server: { name: "example", url: "https://mcp.example.org/tools" },
  tool_name: "read",
  tool_args: {},
};

describe("MCP trust boundary", () => {
  it.each([
    "https://localhost./mcp",
    "https://100.64.0.1",
    "https://[::ffff:127.0.0.1]",
    "https://host.internal",
    "https://user:password@mcp.example.org",
    "https://mcp.example.org/#token",
  ])("rejects unsafe URL %s before any fetch", async (url) => {
    const fetchImpl = vi.fn();
    await expect(
      callMCPTool({ ...input, server: { ...input.server, url }, fetchImpl }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("disallows redirects so credentials cannot follow an approved URL to an internal host", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      if (request.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "initialize"
            ? { protocolVersion: "2025-11-25" }
            : {},
      });
    });
    await callMCPTool({
      ...input,
      decryptedHeaders: { Authorization: "Bearer test-token" },
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("manual");
  });
  it("caps chunked response bytes and excludes upstream secrets from errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("x".repeat(1_000_001)));
    await expect(callMCPTool({ ...input, fetchImpl })).rejects.toThrow(
      "size limit",
    );
    fetchImpl.mockResolvedValue(
      new Response("Bearer upstream-secret", { status: 403 }),
    );
    await expect(callMCPTool({ ...input, fetchImpl })).rejects.toThrow(
      /^MCP server returned 403$/,
    );
  });
  it("rejects malformed headers before encryption and rejects ciphertext under another key", async () => {
    const env = { MCP_CREDENTIALS_SECRET: "test-key-material-only" };
    const scope = {
      userId: "owner",
      workspaceId: "default",
      serverName: "example",
      serverUrl: "https://mcp.example.invalid",
    };
    await expect(
      encryptCredentials(
        env,
        {
          Authorization: "first\r\nInjected: second",
        },
        scope,
      ),
    ).rejects.toThrow("valid string headers");
    const other = { MCP_CREDENTIALS_SECRET: "other-key-material-only" };
    await expect(
      decryptCredentials(
        other,
        await encryptCredentials(
          env,
          { Authorization: "Bearer example" },
          scope,
        ),
        scope,
      ),
    ).rejects.toThrow();
  });
});

describe("MCP Streamable HTTP sessions", () => {
  it("negotiates a session, notifies initialization, reads SSE results and closes the session", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === "DELETE") {
        calls.push("DELETE");
        return new Response(null, { status: 204 });
      }
      const request = JSON.parse(String(init.body));
      calls.push(request.method);
      if (request.method === "initialize")
        return Response.json(
          {
            jsonrpc: "2.0",
            id: request.id,
            result: { protocolVersion: "2025-11-25" },
          },
          { headers: { "MCP-Session-Id": "session-a" } },
        );
      expect(init.headers).toMatchObject({
        "MCP-Session-Id": "session-a",
        "MCP-Protocol-Version": "2025-11-25",
        Accept: "application/json, text/event-stream",
      });
      if (request.method === "notifications/initialized") {
        expect(request.id).toBeUndefined();
        return new Response(null, { status: 202 });
      }
      return new Response(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "complete" }] } })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    expect(await callMCPTool({ ...input, fetchImpl })).toEqual({
      content: [{ type: "text", text: "complete" }],
    });
    expect(calls).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "DELETE",
    ]);
  });
  it("does not replay a potentially completed tool when its response stream ends early", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      if (request.method === "initialize")
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: { protocolVersion: "2025-11-25" },
        });
      if (request.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      calls++;
      return new Response(
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n',
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    await expect(callMCPTool({ ...input, fetchImpl })).rejects.toThrow(
      "ended before",
    );
    expect(calls).toBe(1);
  });
});

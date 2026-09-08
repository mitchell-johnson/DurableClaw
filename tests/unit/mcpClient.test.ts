/**
 * unit tests for `durable-objects/assistant/mcpClient.ts`.
 *
 * The client sits on top of `fetch` and a JSON-RPC 2.0 protocol; tests stub
 * `fetchImpl` so we can assert the wire shape and force timeouts/error paths.
 */

import { describe, it, expect, vi } from "vitest";
import {
  discoverMCPTools,
  callMCPTool,
  isPrivateOrInternalHost,
} from "../../src/durable-objects/assistant/mcpClient";
import type { Env } from "../../src/types";

const env = {} as Env;

/**
 * Build a fetch stub that returns successive responses for sequential calls.
 * If the test makes more requests than provided responses, the stub returns
 * a 500 (which will throw downstream — catches accidental extra calls).
 */
function fetchStub(responses: Array<{ status?: number; body: unknown }>) {
  let i = 0;
  return vi.fn(async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    if (request.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    if (
      request.method === "initialize" &&
      (responses[i]?.body as any)?.result?.protocolVersion === undefined &&
      (responses[i]?.status ?? 200) === 200
    ) {
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: { protocolVersion: "2025-11-25" },
      });
    }
    const r = responses[i++] ?? {
      status: 500,
      body: { error: "no more stub responses" },
    };
    return new Response(
      JSON.stringify({ ...(r.body as object), id: request.id }),
      {
        status: r.status ?? 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  });
}

describe("mcpClient.discoverMCPTools", () => {
  it("runs initialize + tools/list and returns the normalized catalog", async () => {
    const fetchImpl = fetchStub([
      {
        body: {
          jsonrpc: "2.0",
          id: "1",
          result: { protocolVersion: "2025-03-26", capabilities: {} },
        },
      },
      {
        body: {
          jsonrpc: "2.0",
          id: "2",
          result: {
            tools: [
              {
                name: "get_weather",
                description: "Look up weather",
                inputSchema: { type: "object" },
              },
              { name: "noop" },
              // entries without a name must be skipped:
              { description: "phantom tool with no name" },
            ],
          },
        },
      },
    ]);

    const tools = await discoverMCPTools({
      env,
      server: { name: "weather", url: "https://mcp.example/test" },
      fetchImpl,
    });

    expect(tools).toEqual([
      {
        name: "get_weather",
        description: "Look up weather",
        inputSchema: { type: "object" },
      },
      { name: "noop", description: undefined, inputSchema: undefined },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects http:// URLs (HTTPS-only transport)", async () => {
    await expect(
      discoverMCPTools({
        env,
        server: { name: "evil", url: "http://internal.local:8080" },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/https/);
  });

  it("honours the timeout via AbortController", async () => {
    // fetchImpl that resolves only when the signal aborts — i.e. the
    // client's timeout fires before the server response.
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal) {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }
      });
    });

    await expect(
      discoverMCPTools({
        env,
        server: { name: "slow", url: "https://mcp.example/slow" },
        fetchImpl,
        timeoutMs: 10,
      }),
    ).rejects.toThrow();
  });

  it("throws on non-2xx upstream", async () => {
    const fetchImpl = fetchStub([
      { status: 503, body: { error: "service down" } },
    ]);
    await expect(
      discoverMCPTools({
        env,
        server: { name: "broken", url: "https://mcp.example/broken" },
        fetchImpl,
      }),
    ).rejects.toThrow(/503/);
  });
});

describe("mcpClient.callMCPTool", () => {
  it("runs tools/call with the right args and returns the result", async () => {
    const fetchImpl = fetchStub([
      {
        body: {
          jsonrpc: "2.0",
          id: "1",
          result: { content: [{ type: "text", text: "sunny, 22C" }] },
        },
      },
    ]);

    const result = await callMCPTool({
      env,
      server: { name: "weather", url: "https://mcp.example/test" },
      tool_name: "get_weather",
      tool_args: { city: "Example City" },
      fetchImpl,
    });

    expect(result).toEqual({ content: [{ type: "text", text: "sunny, 22C" }] });

    // Inspect the wire body — JSON-RPC envelope with method 'tools/call'.
    const callInit = fetchImpl.mock.calls[2][1] as RequestInit;
    const bodyText = String(callInit.body);
    const parsed = JSON.parse(bodyText);
    expect(parsed.method).toBe("tools/call");
    expect(parsed.params).toEqual({
      name: "get_weather",
      arguments: { city: "Example City" },
    });
  });
});

// SSRF guard. A persona's MCP server URL is user-controlled, and the
// worker POSTs the persona's decrypted credential headers to it. Block literal
// private / loopback / link-local / metadata targets.
describe("mcpClient.isPrivateOrInternalHost", () => {
  const privateHosts = [
    "127.0.0.1", // loopback
    "10.0.0.1", // 10/8
    "172.16.0.1", // 172.16/12 low
    "172.31.255.254", // 172.16/12 high
    "192.168.1.1", // 192.168/16
    "169.254.0.1", // link-local
    "169.254.169.254", // cloud metadata endpoint
    "0.0.0.0", // "this host"
    "localhost", // resolves loopback
    "foo.localhost", // .localhost suffix
    "metadata.google.internal", // GCP metadata hostname
    "[::1]", // IPv6 loopback (bracketed, as URL.hostname returns it)
    "[fd00::1]", // fc00::/7 unique-local
    "[fe80::1]", // fe80::/10 link-local
    "[::ffff:192.168.1.1]", // IPv4-mapped IPv6 to a private v4
    "[::ffff:c0a8:101]", // same, normalized hex form
  ];

  const publicHosts = [
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1", // just outside 172.16/12
    "172.15.0.1", // just below 172.16/12
    "93.184.216.34",
    "mcp.example.com",
    "api.example.org",
    "[2001:4860:4860::8888]", // public IPv6 (Google DNS)
    "[::ffff:8.8.8.8]", // IPv4-mapped to a public v4
  ];

  it.each(privateHosts)("blocks %s", (host) => {
    expect(isPrivateOrInternalHost(host)).toBe(true);
  });

  it.each(publicHosts)("allows %s", (host) => {
    expect(isPrivateOrInternalHost(host)).toBe(false);
  });
});

describe("mcpClient SSRF rejection (discovery + call)", () => {
  const env = {} as Env;

  it("discoverMCPTools rejects a metadata-endpoint URL without fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(
      discoverMCPTools({
        env,
        server: {
          name: "evil",
          url: "https://169.254.169.254/latest/meta-data",
        },
        decryptedHeaders: { authorization: "Bearer secret" },
        fetchImpl,
      }),
    ).rejects.toThrow(/private or internal/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("callMCPTool rejects an RFC1918 URL without fetching", async () => {
    const fetchImpl = vi.fn();
    await expect(
      callMCPTool({
        env,
        server: { name: "evil", url: "https://10.0.0.5/mcp" },
        decryptedHeaders: { authorization: "Bearer secret" },
        tool_name: "x",
        tool_args: {},
        fetchImpl,
      }),
    ).rejects.toThrow(/private or internal/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

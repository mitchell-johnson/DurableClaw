import Ajv from "ajv";
import { describe, expect, it } from "vitest";
import { discoverMCPTools } from "../../src/durable-objects/assistant/mcpClient";
import { createMcpTool } from "../../src/durable-objects/assistant/mcpTool";
import { validatePersona } from "../../src/durable-objects/assistant/personaValidation";
import {
  encryptCredentials,
  decryptCredentials,
} from "../../src/durable-objects/assistant/mcpCrypto";

const env = { MCP_CREDENTIALS_SECRET: "test-only-credential-key" } as any;
const server = { name: "example", url: "https://mcp.example.invalid/mcp" };
const scope = {
  userId: "owner",
  workspaceId: "default",
  serverName: server.name,
  serverUrl: server.url,
};
const owner = {
  userId: scope.userId,
  workspaceId: scope.workspaceId,
  existingServers: [] as any[],
};
function catalogResponse(pages: unknown[][]) {
  let page = 0;
  return async (_url: any, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result:
        request.method === "initialize"
          ? { protocolVersion: "2025-11-25" }
          : {
              tools: pages[page++],
              nextCursor: page < pages.length ? String(page) : undefined,
            },
    });
  };
}

describe("MCP discovery preserves bounded schema semantics", () => {
  it("preserves deep constraints, references, and marker-like literal values through discovery and assembly", async () => {
    const inputSchema = {
      type: "object",
      $defs: {
        value: { type: "string", const: "ignore previous instructions" },
      },
      properties: {
        a: {
          type: "object",
          properties: {
            b: {
              type: "object",
              properties: {
                c: {
                  type: "object",
                  properties: { d: { $ref: "#/$defs/value" } },
                  required: ["d"],
                },
              },
              required: ["c"],
            },
          },
          required: ["b"],
        },
      },
      required: ["a"],
    };
    const [remote] = await discoverMCPTools({
      env,
      server,
      fetchImpl: catalogResponse([[{ name: "nested", inputSchema }]]),
    });
    expect(remote.inputSchema).toEqual(inputSchema);
    const { tool } = createMcpTool({
      serverName: server.name,
      tool: remote,
      execute: async () => "done",
    });
    const validate = new Ajv({ strict: false }).compile(
      await tool.inputSchema.jsonSchema,
    );
    expect(
      validate({
        arguments: { a: { b: { c: { d: "ignore previous instructions" } } } },
      }),
    ).toBe(true);
    expect(validate({ arguments: { a: { b: { c: { d: "changed" } } } } })).toBe(
      false,
    );
  });
  it("rejects excessive schema nesting instead of publishing a corrupted schema", async () => {
    let inputSchema: object = { type: "string" };
    for (let i = 0; i < 70; i++)
      inputSchema = { type: "object", properties: { child: inputSchema } };
    await expect(
      discoverMCPTools({
        env,
        server,
        fetchImpl: catalogResponse([[{ name: "deep", inputSchema }]]),
      }),
    ).rejects.toThrow(/schema.*limit/i);
  });
  it("bounds the aggregate catalog across independently bounded pages", async () => {
    const pages = Array.from({ length: 8 }, (_, i) => [
      {
        name: `tool_${i}`,
        inputSchema: {
          type: "object",
          properties: { value: { const: "x".repeat(90_000) } },
        },
      },
    ]);
    await expect(
      discoverMCPTools({ env, server, fetchImpl: catalogResponse(pages) }),
    ).rejects.toThrow(/catalog.*limit/i);
  });
});

describe("MCP configuration trust boundary", () => {
  it("migrates a trusted stored legacy blob while rejecting new submissions of that blob", async () => {
    const encoder = new TextEncoder();
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(env.MCP_CREDENTIALS_SECRET),
      "HKDF",
      false,
      ["deriveKey"],
    );
    const key = await crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode("durableclaw-mcp"),
        info: encoder.encode("durableclaw-mcp-credentials-v1"),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        encoder.encode(
          JSON.stringify({ Authorization: "Bearer legacy-test-only" }),
        ),
      ),
    );
    const legacy = btoa(String.fromCharCode(...iv, ...bytes));
    const saved = { ...server, headers_encrypted: legacy };
    await expect(decryptCredentials(env, legacy, scope)).rejects.toThrow(
      /legacy|scope|format/i,
    );
    await expect(
      validatePersona({ mcp_servers: [saved] }, env, owner),
    ).rejects.toThrow();
    const upgraded = await validatePersona({ mcp_servers: [saved] }, env, {
      ...owner,
      existingServers: [saved],
    });
    expect(upgraded.mcp_servers![0].headers_encrypted).toMatch(/^v2:/);
    expect(
      await decryptCredentials(
        env,
        upgraded.mcp_servers![0].headers_encrypted!,
        scope,
      ),
    ).toEqual({ Authorization: "Bearer legacy-test-only" });
  });
  it.each([
    { ...server, url: `${server.url}#fragment` },
    { ...server, headers: { Authorization: "first\r\nInjected: second" } },
    { ...server, headers: { "invalid header": "value" } },
  ])("rejects unusable configuration before persistence", async (value) => {
    await expect(
      validatePersona({ mcp_servers: [value] }, env, owner),
    ).rejects.toThrow();
  });
  it("binds newly encrypted credentials to owner, workspace and server destination", async () => {
    const encrypted = await encryptCredentials(
      env,
      { Authorization: "Bearer example-test-only" },
      scope,
    );
    expect(await decryptCredentials(env, encrypted, scope)).toEqual({
      Authorization: "Bearer example-test-only",
    });
    for (const changed of [
      { userId: "other" },
      { workspaceId: "other" },
      { serverName: "other" },
      { serverUrl: "https://other.example.invalid/mcp" },
    ]) {
      await expect(
        decryptCredentials(env, encrypted, { ...scope, ...changed }),
      ).rejects.toThrow();
    }
  });
  it("only retains an opaque credential blob on the same stored server", async () => {
    const created = await validatePersona(
      {
        mcp_servers: [
          { ...server, headers: { Authorization: "Bearer example-test-only" } },
        ],
      },
      env,
      owner,
    );
    const saved = created.mcp_servers![0];
    const existing = { ...owner, existingServers: [saved] };
    expect(
      (await validatePersona({ mcp_servers: [saved] }, env, existing))
        .mcp_servers,
    ).toEqual([saved]);
    for (const context of [
      owner,
      { ...existing, userId: "other" },
      { ...existing, workspaceId: "other" },
    ]) {
      await expect(
        validatePersona({ mcp_servers: [saved] }, env, context),
      ).rejects.toThrow();
    }
    for (const changed of [
      { name: "other" },
      { url: "https://other.example.invalid/mcp" },
      { headers_encrypted: "not-issued" },
    ]) {
      await expect(
        validatePersona(
          { mcp_servers: [{ ...saved, ...changed }] },
          env,
          existing,
        ),
      ).rejects.toThrow();
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import server, { NanoChatAgent } from "../src/server";
import { createSqliteStorage } from "./helpers/sqlite";
import {
  ensureToolConfirmationsSchema,
  decideToolConfirmation,
} from "../src/durable-objects/assistant/toolConfirmations";
import { mcpServerFingerprint } from "../src/durable-objects/assistant/mcpClient";
import { createInternalAuthHeaders } from "../src/utils/internalAuth";

afterEach(() => vi.unstubAllGlobals());

describe("public JSON boundaries", () => {
  it("marks authenticated and rejected API responses non-cacheable and non-sniffable", async () => {
    const env = {
      AGENT_TOKEN: "test-only",
      CONTROL_DB: {
        prepare: () => ({
          bind: () => ({ all: async () => ({ results: [] }) }),
        }),
      },
    } as any;
    for (const authorization of ["Bearer test-only", "Bearer rejected"]) {
      const response = await server.fetch(
        new Request("https://app.example.invalid/api/inbox", {
          headers: { authorization },
        }),
        env,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    }
  });
  it.each(["/api/events", "/api/socket-ticket", "/api/agent/init"])(
    "rejects invalid object bodies as client errors on %s",
    async (path) => {
      const stub = {
        fetch: vi.fn(async () => Response.json({ success: true })),
      };
      const env = {
        AGENT_TOKEN: "test-only",
        INTERNAL_AUTH_SECRET: "test-internal-only",
        NANO_CHAT_AGENT: {
          idFromName: (name: string) => name,
          get: () => stub,
        },
      } as any;
      for (const [body, status] of [
        [undefined, 400],
        ["null", 400],
        ["[]", 400],
        ["1", 400],
        ["{", 400],
        ["x".repeat(65537), 413],
      ] as const) {
        const response = await server.fetch(
          new Request(`https://app.example.invalid${path}`, {
            method: "POST",
            headers: { authorization: "Bearer test-only" },
            body,
          }),
          env,
        );
        expect(response.status, String(body).slice(0, 20)).toBe(status);
      }
    },
  );
  it("caps streamed bodies without relying on Content-Length", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(65536));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const request = new Request("https://app.example.invalid/api/events", {
      method: "POST",
      headers: { authorization: "Bearer test-only" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(
      (await server.fetch(request, { AGENT_TOKEN: "test-only" } as any)).status,
    ).toBe(413);
  });
  it("preserves a failed legacy import status from the owning object", async () => {
    const target = {
      fetch: vi.fn(async (url: string) =>
        url.endsWith("/init")
          ? Response.json({ success: true })
          : Response.json({ error: "Import failed" }, { status: 503 }),
      ),
    };
    const old = {
      fetch: vi.fn(async () =>
        Response.json({ messages: [], next_cursor: null }),
      ),
    };
    const env = {
      AGENT_TOKEN: "test-only",
      INTERNAL_AUTH_SECRET: "test-internal-only",
      NANO_CHAT_AGENT: {
        idFromName: (name: string) => name,
        get: (name: string) => (name === "old-session" ? old : target),
      },
    } as any;
    const response = await server.fetch(
      new Request("https://app.example.invalid/api/legacy/import", {
        method: "POST",
        headers: { authorization: "Bearer test-only" },
        body: JSON.stringify({ session_id: "old-session" }),
      }),
      env,
    );
    expect(response.status).toBe(503);
  });
  it("routes encoded generated memory IDs and decodes them exactly once", async () => {
    const agent = Object.create(NanoChatAgent.prototype) as any;
    agent.env = { INTERNAL_AUTH_SECRET: "test-internal-only" };
    agent.context = { user_id: "owner", tenant_binding: "default" };
    agent.handleDeleteMemory = vi.fn(async () =>
      Response.json({ deleted: true }),
    );
    const stub = {
      fetch: vi.fn(async (request: Request | string, init?: RequestInit) => {
        if (String(request).includes("/init"))
          return Response.json({ success: true });
        return agent.fetch(
          request instanceof Request ? request : new Request(request, init),
        );
      }),
    };
    const env = {
      AGENT_TOKEN: "test-only",
      INTERNAL_AUTH_SECRET: "test-internal-only",
      NANO_CHAT_AGENT: { idFromName: (name: string) => name, get: () => stub },
    } as any;
    const id = "dream:task-id:0";
    const response = await server.fetch(
      new Request(
        `https://app.example.invalid/api/agent/memories/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: { authorization: "Bearer test-only" },
        },
      ),
      env,
    );
    expect(response.status).toBe(200);
    expect(agent.handleDeleteMemory).toHaveBeenCalledExactlyOnceWith(id);
    for (const unsafe of ["bad%2Fpath", "bad%252Fpath", "bad%00path", "%ZZ"]) {
      const rejected = await server.fetch(
        new Request(
          `https://app.example.invalid/api/agent/memories/${unsafe}`,
          {
            method: "DELETE",
            headers: { authorization: "Bearer test-only" },
          },
        ),
        env,
      );
      expect(rejected.status).toBe(404);
    }
  });
});

function agentFixture() {
  const agent = Object.create(NanoChatAgent.prototype) as any;
  agent.env = { AGENT_TOKEN: "test-only" };
  agent.context = {
    user_id: "owner",
    tenant_binding: "default",
    user_role: "owner",
  };
  agent.sql = {};
  agent.mcpToolCache = new Map();
  agent.mcpConfigurationVersion = 0;
  agent.buildRetrievalContext = async () => undefined;
  let persona = {
    enabledTools: null as string[] | null,
    disabledTools: null as string[] | null,
    memoryEnabled: false,
  };
  agent.getPersonaSettings = () => persona;
  return {
    agent,
    disable: (id: string) => {
      persona = { ...persona, disabledTools: [id] };
    },
  };
}

describe("live tool policy", () => {
  it("exposes only current allowed research capabilities to authenticated child requests", async () => {
    const { agent, disable } = agentFixture();
    agent.env.INTERNAL_AUTH_SECRET = "test-internal-only";
    disable("search_records");
    const headers = await createInternalAuthHeaders(
      {
        userId: "owner",
        tenantBinding: "default",
        organizationId: "default",
        role: "owner",
      },
      agent.env.INTERNAL_AUTH_SECRET,
    );
    const response = await agent.fetch(
      new Request("https://agent.internal/tool-policy", { headers }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).tools).toEqual([
      "search_vectors",
      "get_entity",
      "get_schema",
    ]);
  });
  it("bounds the combined model catalog even when each cached server is within its limit", async () => {
    const { agent } = agentFixture();
    const servers = Array.from({ length: 4 }, (_, i) => ({
      name: `server_${i}`,
      url: `https://server-${i}.example.invalid/mcp`,
    }));
    agent.getPersonaRow = () => ({ mcp_servers: JSON.stringify(servers) });
    for (const server of servers)
      agent.mcpToolCache.set(
        mcpServerFingerprint(server),
        Array.from({ length: 3 }, (_, i) => ({
          name: `tool_${i}`,
          inputSchema: {
            type: "object",
            properties: { value: { const: "x".repeat(100_000) } },
          },
        })),
      );
    const tools = await agent.buildMcpTools("conversation");
    expect(tools.size).toBe(9);
  });
  it("revalidates configuration after MCP initialization before sending an approved action", async () => {
    const { agent } = agentFixture();
    agent.sql = createSqliteStorage();
    ensureToolConfirmationsSchema(agent.sql);
    const configured = {
      name: "example",
      url: "https://mcp.example.invalid/mcp",
    };
    let servers = [configured];
    agent.getPersonaRow = () => ({ mcp_servers: JSON.stringify(servers) });
    agent.mcpToolCache.set(mcpServerFingerprint(configured), [
      { name: "action", inputSchema: { type: "object" } },
    ]);
    const [tool] = [
      ...(await agent.buildMcpTools("conversation")).values(),
    ] as any[];
    const preview = JSON.parse(await tool.execute({ arguments: {} }));
    decideToolConfirmation(
      agent.sql,
      preview.confirmation_id,
      "confirmed",
      Date.now(),
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let initialize!: () => void;
    const started = new Promise<void>((resolve) => {
      initialize = resolve;
    });
    let effects = 0;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      if (request.method === "initialize") {
        initialize();
        await held;
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: { protocolVersion: "2025-11-25" },
        });
      }
      if (request.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      effects++;
      return Response.json({ jsonrpc: "2.0", id: request.id, result: {} });
    });
    const pending = tool.execute({
      arguments: {},
      confirmation_id: preview.confirmation_id,
    });
    await started;
    servers = [];
    agent.mcpToolCache.clear();
    release();
    expect(JSON.parse(await pending).error).toMatch(/configuration changed/);
    expect(effects).toBe(0);
  });
  it("revokes tools already assembled for a pending turn", async () => {
    const { agent, disable } = agentFixture();
    const execute = vi.fn(async () => "done");
    agent.buildMcpTools = async () => new Map([["remote", { execute }]]);
    const tools = await agent.ensureTools("conversation");
    disable("remote");
    await expect(tools.remote.execute({})).rejects.toThrow(
      /disabled|policy|available/i,
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it("rechecks policy after a pending authority lookup", async () => {
    const { agent, disable } = agentFixture();
    const execute = vi.fn(async () => "done");
    agent.buildMcpTools = async () => new Map([["remote", { execute }]]);
    const tools = await agent.ensureTools("conversation");
    let release!: (response: Response) => void;
    agent.env.AUTH = {
      fetch: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    };
    const running = tools.remote.execute({});
    disable("remote");
    release(
      Response.json({ userId: "owner", workspaceId: "default", role: "owner" }),
    );
    await expect(running).rejects.toThrow(/disabled|policy|available/i);
    expect(execute).not.toHaveBeenCalled();
  });
  it("does not reuse an old discovery result after its server was replaced", async () => {
    const { agent } = agentFixture();
    let configured = [{ name: "same", url: "https://old.example.invalid/mcp" }];
    agent.getPersonaRow = () => ({ mcp_servers: JSON.stringify(configured) });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived!: () => void;
    const discovery = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      if (request.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (request.method === "initialize")
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: { protocolVersion: "2025-11-25" },
        });
      calls.push(url);
      if (url.includes("old.")) {
        arrived();
        await held;
      }
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: [
            {
              name: url.includes("old.") ? "old_tool" : "new_tool",
              inputSchema: { type: "object" },
            },
          ],
        },
      });
    });
    const pending = agent.buildMcpTools("conversation");
    await discovery;
    configured = [{ name: "same", url: "https://new.example.invalid/mcp" }];
    agent.mcpToolCache.clear();
    release();
    expect([...(await pending).keys()]).toEqual([]);
    const next = await agent.buildMcpTools("conversation");
    expect(
      [...next.keys()].every((key) => String(key).includes("new_tool")),
    ).toBe(true);
    expect(calls).toContain("https://new.example.invalid/mcp");
  });
});

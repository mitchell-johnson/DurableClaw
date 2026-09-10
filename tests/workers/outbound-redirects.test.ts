import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramPlugin } from "../../src/channels/telegram";
import {
  createBatch,
  getBatch,
  runPinnedHousekeeping,
} from "../../src/utils/openrouterBatch";
import {
  callMCPTool,
  discoverMCPTools,
} from "../../src/durable-objects/assistant/mcpClient";
import type { Env } from "../../src/types";

const telegramEnv = {
  TELEGRAM_BOT_TOKEN: "12345:test_only_bot_token",
  TELEGRAM_WEBHOOK_SECRET: "test_webhook_secret_at_least_32_characters",
} as Env;
const batchEnv = {
  OPENROUTER_API_KEY: "test-only-api-key",
  BATCH_MODEL: "test/model:batch",
};
const batchRequest = { customId: "task", system: "System", prompt: "Prompt" };
const mcpArgs = {
  env: {} as Env,
  server: { name: "test", url: "https://mcp.example.test/rpc" },
  decryptedHeaders: { Authorization: "Bearer test-only-mcp-token" },
};

afterEach(() => vi.restoreAllMocks());

function upstream(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    // Validate the callers' real options with workerd, before returning any mock
    // response. Plain Response stubs hide unsupported redirect modes.
    const request = new Request(input, init);
    requests.push(request);
    expect(request.redirect).toBe("manual");
    return handler(request);
  });
  return requests;
}

describe("outbound requests on workerd", () => {
  it("documents the runtime's unsupported error redirect mode", async () => {
    expect(
      () => new Request("https://example.test", { redirect: "error" }),
    ).toThrow("Invalid redirect value");
    await expect(
      fetch("data:text/plain,local-only", { redirect: "error" }),
    ).rejects.toThrow("Invalid redirect value");
    expect(
      new Request("https://example.test", { redirect: "manual" }).redirect,
    ).toBe("manual");
  });

  it("delivers a bounded Telegram response through native Request construction", async () => {
    const requests = upstream(async (request) => {
      expect(request.url).toBe(
        "https://api.telegram.org/bot12345:test_only_bot_token/sendMessage",
      );
      expect(request.method).toBe("POST");
      expect(await request.json()).toMatchObject({
        chat_id: "123",
        text: "Hello",
      });
      return Response.json({ ok: true, result: { message_id: 1 } });
    });
    await expect(
      telegramPlugin.send(telegramEnv, { chatId: "123", text: "Hello" }),
    ).resolves.toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it("supports Telegram typing with native abort signals and Request options", async () => {
    const requests = upstream(async (request) => {
      expect(request.url).toBe(
        "https://api.telegram.org/bot12345:test_only_bot_token/sendChatAction",
      );
      expect(await request.json()).toEqual({
        chat_id: "123",
        action: "typing",
      });
      return Response.json({ ok: true, result: true });
    });
    const controller = new AbortController();
    await telegramPlugin.sendTyping!(
      telegramEnv,
      { chatId: "123" },
      controller.signal,
    );
    expect(requests).toHaveLength(1);
    controller.abort();
    expect(requests[0].signal.aborted).toBe(true);
  });

  it("creates and reads OpenRouter batches with the configured credential", async () => {
    const requests = upstream((request) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer test-only-api-key",
      );
      expect(request.url).toBe(
        request.method === "POST"
          ? "https://openrouter.ai/api/beta/batches"
          : "https://openrouter.ai/api/beta/batches/batch_1",
      );
      return Response.json({ id: "batch_1", status: "in_progress" });
    });
    expect(await createBatch(batchEnv, [batchRequest])).toMatchObject({
      id: "batch_1",
    });
    expect(await getBatch(batchEnv, "batch_1")).toMatchObject({
      status: "in_progress",
    });
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET"]);
  });

  it("runs provider-pinned housekeeping without weakening provider routing", async () => {
    upstream(async (request) => {
      expect(request.url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(await request.json()).toMatchObject({
        provider: { only: ["test/provider"], allow_fallbacks: false },
        stream: false,
      });
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "Completed" },
          },
        ],
      });
    });
    expect(
      await runPinnedHousekeeping(
        { ...batchEnv, OPENROUTER_PROVIDER: "test/provider" },
        batchRequest,
      ),
    ).toBe("Completed");
  });

  for (const operation of [
    "Telegram",
    "batch creation",
    "batch lookup",
    "pinned housekeeping",
  ] as const)
    it(`rejects ${operation} redirects without exposing credentials or response bodies`, async () => {
      const requests = upstream(
        () =>
          new Response("private upstream body", {
            status: 307,
            headers: { location: "https://redirect-target.example.test/steal" },
          }),
      );
      const call =
        operation === "Telegram"
          ? telegramPlugin.send(telegramEnv, { chatId: "123", text: "Hello" })
          : operation === "batch creation"
            ? createBatch(batchEnv, [batchRequest])
            : operation === "batch lookup"
              ? getBatch(batchEnv, "batch_1")
              : runPinnedHousekeeping(
                  { ...batchEnv, OPENROUTER_PROVIDER: "test/provider" },
                  batchRequest,
                );
      const error = await call.then(
        () => null,
        (error) => error as Error,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toMatch(
        operation === "Telegram" ? /Telegram delivery failed/ : /HTTP 307/,
      );
      expect(error!.message).not.toMatch(
        /test-only|test_only|private upstream|redirect-target/,
      );
      expect(requests).toHaveLength(1);
    });

  it("discovers MCP tools and retires the authenticated session", async () => {
    const methods: string[] = [];
    const requests = upstream(async (request) => {
      expect(request.url).toBe(mcpArgs.server.url);
      expect(request.headers.get("authorization")).toBe(
        "Bearer test-only-mcp-token",
      );
      if (request.method === "DELETE") {
        expect(request.headers.get("mcp-session-id")).toBe("session");
        methods.push("DELETE");
        return new Response(null, { status: 204 });
      }
      const body = (await request.json()) as { id?: string; method: string };
      methods.push(body.method);
      if (body.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      return Response.json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result:
            body.method === "initialize"
              ? { protocolVersion: "2025-11-25" }
              : { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
        },
        { headers: { "MCP-Session-Id": "session" } },
      );
    });
    expect(await discoverMCPTools(mcpArgs)).toMatchObject([{ name: "echo" }]);
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "DELETE",
    ]);
    expect(requests).toHaveLength(4);
  });

  it("rejects an MCP tool redirect once and does not follow cleanup redirects", async () => {
    const methods: string[] = [];
    const requests = upstream(async (request) => {
      expect(request.url).toBe(mcpArgs.server.url);
      if (request.method === "DELETE") {
        methods.push("DELETE");
        return new Response(null, {
          status: 302,
          headers: { location: "https://redirect-target.example.test/delete" },
        });
      }
      const body = (await request.json()) as { id?: string; method: string };
      methods.push(body.method);
      if (body.method === "initialize")
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-11-25" },
          },
          { headers: { "MCP-Session-Id": "session" } },
        );
      if (body.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      return new Response("secret", {
        status: 308,
        headers: { location: "https://redirect-target.example.test/call" },
      });
    });
    await expect(
      callMCPTool({ ...mcpArgs, tool_name: "echo", tool_args: {} }),
    ).rejects.toThrow("MCP server returned 308");
    expect(methods).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "DELETE",
    ]);
    expect(requests).toHaveLength(4);
  });
});

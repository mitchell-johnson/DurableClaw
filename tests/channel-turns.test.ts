import { afterEach, describe, expect, it, vi } from "vitest";
import { NanoChatAgent } from "../src/durable-objects/NanoChatAgent";
import { createSqliteStorage } from "./helpers/sqlite";
import { createInternalAuthHeaders } from "../src/utils/internalAuth";
import { defineConfirmTool } from "../src/action-library/helpers";
import { makeSqliteConfirmationCoordinator } from "../src/durable-objects/assistant/toolConfirmations";
import { issueToolConfirmation } from "../src/durable-objects/assistant/toolConfirmations";
afterEach(() => vi.unstubAllGlobals());

async function fixture(sql = createSqliteStorage()) {
  let initialized!: Promise<unknown>;
  const state = {
    storage: {
      sql,
      transactionSync: (f: () => unknown) => f(),
      setAlarm: async () => {},
    },
    blockConcurrencyWhile: (f: () => Promise<unknown>) => {
      initialized = f();
    },
    getWebSockets: () => [],
    waitUntil: () => {},
  };
  const env = {
    AGENT_TOKEN: "test-owner",
    INTERNAL_AUTH_SECRET: "test-internal",
  };
  const agent = new NanoChatAgent(state as any, env as any) as any;
  await initialized;
  agent.persistContext({
    user_id: "owner",
    user_name: "Owner",
    organization_id: "default",
    organization_name: "Default",
    tenant_binding: "default",
    user_role: "owner",
  });
  agent.restoreContextFromSql();
  agent.handleUserMessage = vi.fn(async () => "Agent reply");
  const headers = await createInternalAuthHeaders(
    {
      userId: "owner",
      tenantBinding: "default",
      organizationId: "default",
      role: "owner",
    },
    env.INTERNAL_AUTH_SECRET,
  );
  const send = (data: object) =>
    agent.fetch(
      new Request("https://agent.internal/channel-message", {
        method: "POST",
        headers,
        body: JSON.stringify(data),
      }),
    );
  return { agent, sql, env, send };
}
const message = {
  conversationId: "linked-conversation",
  requestId: "provider-update-1",
  content: "Hello from Telegram",
};
describe("internal messaging turn bridge", () => {
  it("does not let a downgraded owner approve an existing shell request", async () => {
    const f = await fixture();
    f.agent.ensureConversationRow(message.conversationId);
    const id = issueToolConfirmation(
      f.sql,
      {
        conversationId: message.conversationId,
        toolName: "run_device_bash",
        argsHash: "args",
      },
      Date.now(),
    );
    f.agent.env.AUTH = {
      fetch: async () =>
        Response.json({
          userId: "owner",
          workspaceId: "default",
          role: "reader",
        }),
    };
    const decision = await f.agent.handleConfirmationDecision(
      message.conversationId,
      id,
      new Request("https://agent.internal/decision", {
        method: "POST",
        body: JSON.stringify({ decision: "confirmed" }),
      }),
    );
    expect(decision.status).toBe(403);
    expect(
      f.sql
        .exec(
          "SELECT status FROM tool_confirmations WHERE confirmation_id=?",
          id,
        )
        .toArray()[0].status,
    ).toBe("pending");
  });
  it("runs the actual turn engine and preserves a pending approval for the web app", async () => {
    const f = await fixture();
    f.agent.handleUserMessage = (
      NanoChatAgent.prototype as any
    ).handleUserMessage;
    f.agent.env.OPENROUTER_API_KEY = "test-only-model-key";
    f.agent.env.CHAT_MODEL = "test-model";
    f.agent.getPersonaSettings = () => ({ memoryEnabled: false });
    f.agent.ensureSystemPrompt = async () => "System";
    f.agent.generateConversationTitle = async () => {};
    const execute = vi.fn(async () => "should require approval");
    f.agent.ensureTools = async () => ({
      reviewed_action: defineConfirmTool(
        "reviewed_action",
        {
          description: "An action requiring approval",
          properties: { command: { type: "string" } },
          required: ["command"],
          buildPreview: (input: { command: string }) => input.command,
          execute,
        },
        {
          conversationId: message.conversationId,
          confirmations: makeSqliteConfirmationCoordinator(f.sql),
        },
      ),
    });
    const chunks =
      [
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "tool-1",
                    type: "function",
                    function: {
                      name: "reviewed_action",
                      arguments: JSON.stringify({ command: "pwd" }),
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]
        .map(
          (chunk) =>
            `data: ${JSON.stringify({ id: "completion", created: 0, model: "test-model", ...chunk })}\n\n`,
        )
        .join("") + "data: [DONE]\n\n";
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(chunks, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const response = await f.send(message);
    expect(response.status).toBe(200);
    expect((await response.json()).text).toContain(
      "Approval is required in the DurableClaw web app",
    );
    expect(execute).not.toHaveBeenCalled();
    const confirmations = f.sql
      .exec("SELECT status FROM tool_confirmations")
      .toArray();
    expect(confirmations).toEqual([{ status: "pending" }]);
    expect(
      JSON.stringify(f.agent.loadRecentMessageRows(message.conversationId)),
    ).toContain("needs_confirmation");
  });
  it.each(["busy", "rate-limited"])(
    "retains a distinct message rejected before start when %s",
    async (reason) => {
      const f = await fixture();
      f.agent.ensureConversationRow(message.conversationId);
      if (reason === "busy")
        f.agent.processingConversations.add(message.conversationId);
      else f.agent.lastMessageAt.set(message.conversationId, Date.now());
      const response = await f.send(message);
      expect(response.status).toBe(200);
      expect((await response.json()).text).toMatch(
        /saved.*not.*executed|not.*started/i,
      );
      expect(f.agent.handleUserMessage).not.toHaveBeenCalled();
      expect(
        JSON.stringify(f.agent.loadRecentMessageRows(message.conversationId)),
      ).toContain(message.content);
      await f.send(message);
      expect(
        f.agent
          .loadRecentMessageRows(message.conversationId)
          .filter((row: any) => row.role === "user"),
      ).toHaveLength(1);
    },
  );
  it("terminates browser streaming when a messaging turn reaches its deadline", async () => {
    const f = await fixture();
    f.agent.handleUserMessage = (
      NanoChatAgent.prototype as any
    ).handleUserMessage;
    f.agent.ensureConversationRow(message.conversationId);
    f.agent.getPersonaSettings = () => ({ memoryEnabled: false });
    let release!: () => void;
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    f.agent.ensureSystemPrompt = async () => {
      reached();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "System";
    };
    f.agent.ensureTools = async () => ({});
    const frames: any[] = [];
    f.agent.sendToConversation = (_conversation: string, frame: any) =>
      frames.push(frame);
    const running = f.agent.handleUserMessage(
      null,
      message.conversationId,
      message.content,
      undefined,
      message.requestId,
      20,
    );
    await started;
    try {
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(frames).toContainEqual(
        expect.objectContaining({
          type: "assistant_end",
          request_id: message.requestId,
          stopped: true,
        }),
      );
      expect(
        JSON.stringify(f.agent.loadRecentMessageRows(message.conversationId)),
      ).toContain("Stopped");
    } finally {
      release();
      await running;
    }
  });
  it("uses the existing conversation engine and retains the response across restart", async () => {
    const first = await fixture();
    const response = await first.send(message);
    expect(response.status).toBe(200);
    expect((await response.json()).text).toBe("Agent reply");
    expect(first.agent.handleUserMessage).toHaveBeenCalledOnce();
    const second = await fixture(first.sql);
    expect((await (await second.send(message)).json()).text).toBe(
      "Agent reply",
    );
    expect(second.agent.handleUserMessage).not.toHaveBeenCalled();
  });
  it("rejects changed content for a reused request identity", async () => {
    const f = await fixture();
    await f.send(message);
    expect(
      (await f.send({ ...message, content: "different command" })).status,
    ).toBe(409);
    expect(f.agent.handleUserMessage).toHaveBeenCalledOnce();
  });
  it("does not start duplicate or concurrent delivery while a turn is running", async () => {
    const f = await fixture();
    let release!: (s: string) => void;
    f.agent.handleUserMessage = vi.fn(
      () =>
        new Promise<string>((r) => {
          release = r;
        }),
    );
    const running = f.send(message);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const duplicate = await f.send(message);
    expect(duplicate.status).toBe(409);
    release("done");
    await running;
    expect(f.agent.handleUserMessage).toHaveBeenCalledOnce();
  });
  it("validates content and denies stale owner authority", async () => {
    const f = await fixture();
    expect(
      (await f.send({ ...message, content: "x".repeat(32001) })).status,
    ).toBe(400);
    f.env.AGENT_TOKEN = "";
    expect((await f.send(message)).status).toBe(403);
    expect(f.agent.handleUserMessage).not.toHaveBeenCalled();
  });
  it("requires the internal signed envelope", async () => {
    const f = await fixture();
    expect(
      (
        await f.agent.fetch(
          new Request("https://agent.internal/channel-message", {
            method: "POST",
            body: JSON.stringify(message),
          }),
        )
      ).status,
    ).toBe(401);
  });
});

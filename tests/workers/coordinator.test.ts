import { beforeAll, describe, expect, it } from "vitest";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import { NanoChatAgent } from "../../src/durable-objects/NanoChatAgent";
import { createInternalAuthHeaders } from "../../src/utils/internalAuth";
import { issueToolConfirmation } from "../../src/durable-objects/assistant/toolConfirmations";
import migration from "../../migrations/0001_control.sql?raw";
const runtime = env as any;
const auth = {
  authorization: "Bearer test-only-token",
  "content-type": "application/json",
};
beforeAll(async () => {
  for (const sql of migration.split(";").filter((s) => s.trim()))
    await runtime.CONTROL_DB.prepare(sql).run();
});
async function headers(userId = "owner", workspace = "default") {
  return createInternalAuthHeaders(
    {
      userId,
      organizationId: workspace,
      tenantBinding: workspace,
      role: "owner",
    },
    "test-only-internal-secret",
  );
}
function fresh() {
  return runtime.NANO_CHAT_AGENT.get(
    runtime.NANO_CHAT_AGENT.idFromName(crypto.randomUUID()),
  );
}
async function init(stub: any, conversation: string) {
  return stub.fetch("https://agent/init", {
    method: "POST",
    headers: await headers(),
    body: JSON.stringify({ conversation_id: conversation }),
  });
}

describe("assembled coordinator on native storage", () => {
  it("persists owner and history across reconstruction and rejects another signed owner", async () => {
    const stub = fresh();
    expect((await init(stub, "history")).status).toBe(200);
    const value = await runInDurableObject(
      stub,
      async (agent: any, state: DurableObjectState) => {
        agent.appendMessage({
          conversationId: "history",
          role: "user",
          content: "Preserve this question",
        });
        const restored = new NanoChatAgent(state, env as any);
        const response = await restored.fetch(
          new Request("https://agent/conversations/history/messages", {
            headers: await headers(),
          }),
        );
        return {
          body: await response.json(),
          version: state.storage.sql
            .exec("SELECT version FROM schema_meta")
            .one().version,
        };
      },
    );
    expect(JSON.stringify(value.body)).toContain("Preserve this question");
    expect(value.version).toBe(11);
    expect(
      (
        await stub.fetch("https://agent/conversations", {
          headers: await headers("other"),
        })
      ).status,
    ).toBe(401);
  });
  it("binds confirmation decisions to the issuing conversation", async () => {
    const stub = fresh();
    await init(stub, "one");
    await init(stub, "two");
    const id = await runInDurableObject(
      stub,
      (_agent: any, state: DurableObjectState) =>
        issueToolConfirmation(
          state.storage.sql,
          { conversationId: "one", toolName: "write_file", argsHash: "hash" },
          Date.now(),
        ),
    );
    const wrong = await stub.fetch(
      `https://agent/conversations/two/confirmations/${id}`,
      {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ decision: "confirmed" }),
      },
    );
    expect(wrong.status).toBe(404);
    const right = await stub.fetch(
      `https://agent/conversations/one/confirmations/${id}`,
      {
        method: "POST",
        headers: await headers(),
        body: JSON.stringify({ decision: "confirmed" }),
      },
    );
    expect(right.status).toBe(200);
  });
  it.each([false, true])(
    "allows DELETE with an empty streamed body: %s",
    async (streamed) => {
      const conversation = "delete-" + crypto.randomUUID();
      await SELF.fetch("https://example.test/api/agent/init", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ conversation_id: conversation }),
      });
      expect(
        (
          await SELF.fetch(
            `https://example.test/api/agent/conversations/${conversation}`,
            {
              method: "DELETE",
              headers: auth,
              ...(streamed
                ? {
                    body: new ReadableStream({
                      start(controller) {
                        controller.close();
                      },
                    }),
                  }
                : {}),
            },
          )
        ).status,
      ).toBe(200);
      const missing = await SELF.fetch(
        "https://example.test/api/agent/memories/missing",
        { method: "DELETE", headers: auth },
      );
      expect(missing.status).not.toBe(500);
    },
  );
  it("uses scoped single-use socket tickets and rejects caller-selected internal callbacks", async () => {
    const rejected = await SELF.fetch(
      "https://example.test/api/agent/subagent-result",
      { method: "POST", headers: auth, body: "{}" },
    );
    expect(rejected.status).toBe(404);
    const issued = await SELF.fetch("https://example.test/api/socket-ticket", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ conversation_id: "socket" }),
    });
    const { ticket } = (await issued.json()) as { ticket: string };
    const first = await SELF.fetch(
      `https://example.test/api/agent/connect?conversation_id=socket&ticket=${ticket}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(first.status).toBe(101);
    first.webSocket!.accept();
    first.webSocket!.close();
    expect(
      (
        await SELF.fetch(
          `https://example.test/api/agent/connect?conversation_id=socket&ticket=${ticket}`,
          { headers: { Upgrade: "websocket" } },
        )
      ).status,
    ).toBe(401);
  });
  it.each(["clear", "cancel", "message"])(
    "rejects revoked %s frames before changing history or cancellation",
    async (command) => {
      const stub = fresh();
      await init(stub, "revoked");
      const result = await runInDurableObject(
        stub,
        async (_agent: any, state: DurableObjectState) => {
          const agent = new NanoChatAgent(state, {
            ...env,
            AUTH: { fetch: async () => new Response(null, { status: 403 }) },
          } as any) as any;
          await agent.fetch(
            new Request("https://agent/init", {
              method: "POST",
              headers: await headers(),
              body: JSON.stringify({ conversation_id: "revoked" }),
            }),
          );
          agent.appendMessage({
            conversationId: "revoked",
            role: "user",
            content: "Keep me",
          });
          let closes = 0;
          let cancellations = 0;
          agent.handleCancelTurn = () => cancellations++;
          const socket = {
            deserializeAttachment: () => ({ conversation_id: "revoked" }),
            send: () => {},
            close: () => closes++,
          };
          await agent.webSocketMessage(
            socket,
            JSON.stringify({
              type: command,
              content: "Unauthorized turn",
              request_id: "revoked-request",
            }),
          );
          return {
            count: state.storage.sql
              .exec(
                "SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?",
                "revoked",
              )
              .one().count,
            closes,
            cancellations,
          };
        },
      );
      expect(result.count).toBe(1);
      expect(result.closes).toBe(1);
      expect(result.cancellations).toBe(0);
    },
  );
});

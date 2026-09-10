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
  it("closes idle browser sessions on cancellation without cancelling a different active request", async () => {
    const stub = fresh();
    await init(stub, "browser-stop");
    await runInDurableObject(stub, async (agent: any) => {
      const closed: string[] = [];
      agent.browserSessions = {
        close: async (id: string) => {
          closed.push(id);
        },
      };
      const controller = new AbortController();
      agent.activeTurns.set("browser-stop", {
        requestId: "current",
        controller,
      });
      agent.handleCancelTurn("browser-stop", "old", true);
      expect(closed).toEqual([]);
      expect(controller.signal.aborted).toBe(false);
      agent.handleCancelTurn("browser-stop", "current", true);
      expect(controller.signal.aborted).toBe(true);
      expect(closed).toEqual(["browser-stop"]);
      agent.handleCancelTurn("browser-stop", undefined, true);
      expect(closed).toEqual(["browser-stop", "browser-stop"]);
    });
  });

  it("registers conversation-scoped browser tools and closes them on deletion", async () => {
    const stub = fresh();
    await init(stub, "browser-one");
    await init(stub, "browser-two");
    await runInDurableObject(stub, async (agent: any) => {
      const initial = await agent.ensureTools("browser-one");
      expect(initial.browser_navigate).toBeUndefined();
      const navigated: string[] = [];
      const closed: string[] = [];
      agent.browserSessions = {
        navigate: async (id: string) => {
          navigated.push(id);
          return { title: id };
        },
        close: async (id: string) => {
          closed.push(id);
          return { closed: true };
        },
      };
      const one = await agent.ensureTools("browser-one");
      const two = await agent.ensureTools("browser-two");
      const options = { toolCallId: "browse", messages: [] };
      await one.browser_navigate.execute(
        { url: "https://example.com" },
        options,
      );
      await two.browser_navigate.execute(
        { url: "https://example.com" },
        options,
      );
      expect(navigated).toEqual(["browser-one", "browser-two"]);
      expect(agent.allowedResearchToolIds()).not.toContain("browser_act");
      expect(agent.handleDeleteConversation("browser-one").status).toBe(200);
      expect(closed).toEqual(["browser-one"]);
    });
  });

  it("recovers a settled batch after reconstruction and preserves its reply for a disconnected client", async () => {
    const stub = fresh();
    await init(stub, "research");
    const result = await runInDurableObject(
      stub,
      async (agent: any, state: DurableObjectState) => {
        // No provider/network work is needed to test durable completion delivery.
        agent.pumpDispatch = async () => 0;
        const { batch_id } = await agent.spawnSubagentBatch({
          origin: "chat",
          conversation_id: "research",
          request_id: "original",
          tasks: [{ goal: "Count to 10", tier: "background" }],
        });
        state.storage.sql.exec(
          "UPDATE subagent_tasks SET status='done', result_json=?",
          JSON.stringify({ text: "1, 2, 3, 4, 5, 6, 7, 8, 9, 10" }),
        );
        // Reconstruct against native SQLite and await its constructor work.
        // Direct method calls inside this test do not pass through workerd's
        // normal event/input gate, so capture the initialization explicitly.
        let initialized!: Promise<unknown>;
        const restoredState = {
          storage: state.storage,
          blockConcurrencyWhile: (callback: () => Promise<unknown>) =>
            (initialized = callback()),
          getWebSockets: () => [],
          waitUntil: (promise: Promise<unknown>) => state.waitUntil(promise),
        };
        const restored = new NanoChatAgent(
          restoredState as any,
          env as any,
        ) as any;
        await initialized;
        const frames: any[] = [];
        restored.sendToConversation = (_conversation: string, frame: any) =>
          frames.push(frame);
        await restored.alarm();
        const firstFrames = [...frames];
        await restored.runBatchSynthesis(batch_id);
        const history = await restored.fetch(
          new Request("https://agent/conversations/research/messages", {
            headers: await headers(),
          }),
        );
        const rows = state.storage.sql
          .exec(
            "SELECT message_id, content FROM messages WHERE conversation_id='research'",
          )
          .toArray();
        await state.storage.deleteAlarm();
        return {
          batch_id,
          frames,
          firstFrames,
          rows,
          history: await history.json(),
        };
      },
    );
    expect(result.frames).toEqual(result.firstFrames);
    expect(result.frames.map((frame: any) => frame.type)).toEqual([
      "assistant_start",
      "assistant_delta",
      "assistant_end",
      "assistant_message",
      "subagent_batch",
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].message_id).toBe(`batch_${result.batch_id}`);
    expect(JSON.stringify(result.history)).toContain(
      "1, 2, 3, 4, 5, 6, 7, 8, 9, 10",
    );
  });
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
    expect(value.version).toBe(12);
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

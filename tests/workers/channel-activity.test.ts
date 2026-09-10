import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { NanoChatAgent } from "../../src/durable-objects/NanoChatAgent";
import migration from "../../migrations/0002_messaging.sql?raw";

const runtime = env as any;
beforeAll(async () => {
  for (const sql of migration
    .replace(/--.*$/gm, "")
    .split(";")
    .filter((s) => s.trim()))
    await runtime.CONTROL_DB.prepare(sql).run();
});
afterEach(() => vi.restoreAllMocks());

describe("Telegram activity and result recovery on native Cloudflare storage", () => {
  it("restores a typing batch and sends all 20 results once via the original D1 link", async () => {
    const requestId = crypto.randomUUID();
    const linkId = crypto.randomUUID();
    const now = Date.now();
    await runtime.CONTROL_DB.prepare(
      "INSERT INTO messaging_links VALUES (?, 'owner', 'default', 'telegram', '42', '42', 'conversation', ?)",
    )
      .bind(linkId, now)
      .run();
    await runtime.CONTROL_DB.prepare(
      "INSERT INTO messaging_deliveries VALUES (?, ?, ?, 'owner', 'default', 'telegram', 'sent', ?, ?, ?)",
    )
      .bind(requestId, requestId, linkId, now, now, now + 3600_000)
      .run();
    const actions: Record<string, any>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.redirect).toBe("manual");
      expect(request.url).toMatch(
        /^https:\/\/api.telegram.org\/bot12345:test_only_bot_token\/(sendChatAction|sendMessage)$/,
      );
      actions.push(await request.json());
      return Response.json({ ok: true, result: true });
    });
    const stub = runtime.NANO_CHAT_AGENT.get(
      runtime.NANO_CHAT_AGENT.idFromName(crypto.randomUUID()),
    );
    await runInDurableObject(
      stub,
      async (_original: any, state: DurableObjectState) => {
        const background: Promise<unknown>[] = [];
        const configured = {
          ...runtime,
          TELEGRAM_BOT_TOKEN: "12345:test_only_bot_token",
          TELEGRAM_WEBHOOK_SECRET: "test_webhook_secret_at_least_32_characters",
        };
        const construct = async () => {
          let initialized!: Promise<unknown>;
          const agent = new NanoChatAgent(
            {
              storage: state.storage,
              blockConcurrencyWhile: (f: () => Promise<unknown>) => {
                initialized = f();
              },
              getWebSockets: () => [],
              waitUntil: (work: Promise<unknown>) => background.push(work),
            } as any,
            configured,
          ) as any;
          await initialized;
          agent.pumpDispatch = async () => 0;
          return agent;
        };
        const drain = async () => {
          while (background.length) await Promise.all(background.splice(0));
        };
        const agent = await construct();
        agent.persistContext({
          user_id: "owner",
          user_name: "Owner",
          user_role: "owner",
          organization_id: "default",
          organization_name: "Default",
          tenant_binding: "default",
        });
        agent.restoreContextFromSql();
        agent.ensureConversationRow("conversation");
        const { batch_id } = await agent.spawnSubagentBatch({
          origin: "chat",
          conversation_id: "conversation",
          request_id: requestId,
          tasks: Array.from({ length: 20 }, (_, i) => ({
            goal: `Agent ${i + 1}: count to 10`,
            tier: "background",
          })),
        });
        agent.channelActivity.start("conversation", requestId);
        await drain();
        expect(actions).toEqual([{ chat_id: "42", action: "typing" }]);
        const restored = await construct();
        const typingJob = state.storage.sql
          .exec("SELECT * FROM scheduled_jobs WHERE kind='channel_typing'")
          .one();
        await restored.channelActivity.run(typingJob);
        expect(actions).toHaveLength(2);
        state.storage.sql.exec(
          "UPDATE subagent_tasks SET status='done',result_json=?",
          JSON.stringify({ text: "1, 2, 3, 4, 5, 6, 7, 8, 9, 10" }),
        );
        await restored.runBatchSynthesis(batch_id);
        expect(
          state.storage.sql
            .exec("SELECT * FROM scheduled_jobs WHERE kind='channel_typing'")
            .toArray(),
        ).toEqual([]);
        expect(
          state.storage.sql
            .exec("SELECT * FROM scheduled_jobs WHERE kind='channel_reply'")
            .toArray(),
        ).toHaveLength(1);
        const delivery = await construct();
        await delivery.alarm();
        expect(actions).toHaveLength(3);
        expect(actions[2].chat_id).toBe("42");
        expect(
          actions[2].text.match(/1, 2, 3, 4, 5, 6, 7, 8, 9, 10/g),
        ).toHaveLength(20);
        delivery.sendSubagentReply(
          "conversation",
          batch_id,
          requestId,
          `batch_${batch_id}`,
          actions[2].text,
        );
        await delivery.alarm();
        expect(actions).toHaveLength(3);
        expect(
          state.storage.sql
            .exec(
              "SELECT * FROM scheduled_jobs WHERE kind IN ('channel_typing','channel_reply')",
            )
            .toArray(),
        ).toEqual([]);
        await drain();
        await state.storage.deleteAlarm();
      },
    );
    const deliveries = await runtime.CONTROL_DB.prepare(
      "SELECT status FROM messaging_deliveries WHERE request_id LIKE 'reply_%'",
    ).all();
    expect(deliveries.results).toEqual([{ status: "sent" }]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { NanoChatAgent } from "../src/durable-objects/NanoChatAgent";
import { createSqliteStorage } from "./helpers/sqlite";
import { createMessagingDb } from "./helpers/messagingDb";
import { createInternalAuthHeaders } from "../src/utils/internalAuth";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(
  sql = createSqliteStorage(),
  control = createMessagingDb(),
) {
  let initialized!: Promise<unknown>;
  const background: Promise<unknown>[] = [];
  const state = {
    storage: {
      sql,
      transactionSync: (f: () => unknown) => f(),
      setAlarm: vi.fn(async () => {}),
    },
    blockConcurrencyWhile: (f: () => Promise<unknown>) => {
      initialized = f();
    },
    getWebSockets: () => [],
    waitUntil: (work: Promise<unknown>) => background.push(work),
  };
  const env = {
    AGENT_TOKEN: "test-owner",
    INTERNAL_AUTH_SECRET: "test-internal",
    TELEGRAM_BOT_TOKEN: "123456:abcdefghijk",
    TELEGRAM_WEBHOOK_SECRET: "0123456789abcdef0123456789abcdef",
    CONTROL_DB: control.db,
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
  agent.ensureConversationRow("conversation");
  agent.pumpDispatch = async () => 0;
  agent.getPersonaSettings = () => ({ memoryEnabled: false });
  agent.generateConversationTitle = async () => {};
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) =>
    Response.json({ ok: true, result: true }),
  );
  vi.stubGlobal("fetch", fetcher);
  const drain = async () => {
    while (background.length) await Promise.all(background.splice(0));
  };
  const jobs = (kind: string) =>
    sql.exec("SELECT * FROM scheduled_jobs WHERE kind=?", kind).toArray();
  const turn = (requestId = "request") => {
    const value = {
      requestId,
      controller: new AbortController(),
      text: "",
      persistedText: "",
      stopped: false,
      messageId: crypto.randomUUID(),
    };
    agent.activeTurns.set("conversation", value);
    return value;
  };
  const batch = (count = 1, requestId = "request") =>
    agent.spawnSubagentBatch({
      origin: "chat",
      conversation_id: "conversation",
      request_id: requestId,
      tasks: Array.from({ length: count }, (_, i) => ({
        goal: `Agent ${i + 1}: count to 10`,
        tier: "background",
      })),
    });
  const send = async (requestId = "request") =>
    agent.fetch(
      new Request("https://agent.internal/channel-message", {
        method: "POST",
        headers: await createInternalAuthHeaders(
          {
            userId: "owner",
            tenantBinding: "default",
            organizationId: "default",
            role: "owner",
          },
          env.INTERNAL_AUTH_SECRET,
        ),
        body: JSON.stringify({
          conversationId: "conversation",
          requestId,
          content: "Count to 10",
        }),
      }),
    );
  return {
    agent,
    sql,
    control,
    env,
    state,
    fetcher,
    jobs,
    turn,
    drain,
    batch,
    send,
  };
}

describe("Telegram coordinator activity and later replies", () => {
  it("starts before a slow real turn completes, refreshes, and stops after generation fails", async () => {
    const f = await fixture();
    const started = deferred();
    const release = deferred();
    f.agent.ensureSystemPrompt = async () => {
      started.resolve();
      await release.promise;
      throw new Error("generation failed");
    };
    const response = f.send();
    await started.promise;
    await f.drain();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.jobs("channel_typing")).toHaveLength(1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 4000);
    await f.agent.alarm();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    release.resolve();
    expect((await response).status).toBe(200);
    await f.drain();
    expect(f.jobs("channel_typing")).toEqual([]);
    await f.send();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("cleans up after a successful channel turn and does not duplicate typing for a retried webhook", async () => {
    const f = await fixture();
    const started = deferred();
    const release = deferred();
    f.agent.handleUserMessage = async () => {
      f.turn();
      started.resolve();
      await release.promise;
      f.agent.activeTurns.delete("conversation");
      return "Finished";
    };
    const response = f.send();
    await started.promise;
    await f.drain();
    expect((await f.send()).status).toBe(409);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    release.resolve();
    expect(await (await response).json()).toEqual({ text: "Finished" });
    expect(f.jobs("channel_typing")).toEqual([]);
    expect((await f.send()).status).toBe(200);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "deadline"])(
    "aborts typing on %s even while generation is stalled",
    async (reason) => {
      const f = await fixture();
      const release = deferred();
      const started = deferred();
      f.agent.ensureSystemPrompt = async () => {
        started.resolve();
        await release.promise;
        throw new Error("stopped");
      };
      const work = f.agent.handleUserMessage(
        null,
        "conversation",
        "hello",
        undefined,
        "request",
        reason === "deadline" ? 30 : undefined,
      );
      await started.promise;
      f.agent.channelActivity.start("conversation", "request");
      await f.drain();
      if (reason === "stop")
        f.agent.handleCancelTurn("conversation", "request");
      else await vi.waitFor(() => expect(f.agent.activeTurns.size).toBe(0));
      expect(f.jobs("channel_typing")).toEqual([]);
      release.resolve();
      await work;
      await f.drain();
    },
  );

  it("keeps typing across all batches after the initial turn and stops after the last one", async () => {
    const f = await fixture();
    const one = await f.batch();
    const two = await f.batch();
    f.agent.channelActivity.start("conversation", "request");
    await f.drain();
    f.agent.finishSubagentBatch(one.batch_id, "completed");
    expect(f.jobs("channel_typing")).toHaveLength(1);
    f.agent.finishSubagentBatch(two.batch_id, "completed");
    expect(f.jobs("channel_typing")).toEqual([]);
  });

  it.each(["unlink", "downgrade"])(
    "stops activity after %s",
    async (reason) => {
      const f = await fixture();
      f.turn();
      f.agent.channelActivity.start("conversation", "request");
      await f.drain();
      if (reason === "unlink")
        f.control.sql.exec("DELETE FROM messaging_links");
      else
        f.agent.env.AUTH = {
          fetch: async () =>
            Response.json({
              userId: "owner",
              workspaceId: "default",
              role: "reader",
            }),
        };
      await f.agent.channelActivity.run(f.jobs("channel_typing")[0]);
      expect(f.jobs("channel_typing")).toEqual([]);
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each([403, 429, 500])(
    "handles Telegram %s without failing or continually retrying the turn",
    async (status) => {
      const f = await fixture();
      f.fetcher.mockImplementation(async () =>
        Response.json(
          { ok: false, parameters: { retry_after: 42 } },
          { status },
        ),
      );
      f.turn();
      const now = Date.now();
      f.agent.channelActivity.start("conversation", "request");
      await f.drain();
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      if (status === 403) expect(f.jobs("channel_typing")).toEqual([]);
      else
        expect(f.jobs("channel_typing")[0].run_at).toBeGreaterThanOrEqual(
          now + (status === 429 ? 42000 : 30000),
        );
      f.agent.handleCancelTurn("conversation", "request");
      expect(f.jobs("channel_typing")).toEqual([]);
      await f.drain();
    },
  );

  it("never overlaps slow typing calls and aborts in-flight actions on stop", async () => {
    const f = await fixture();
    const started = deferred();
    const release = deferred();
    f.fetcher.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return Response.json({ ok: true });
    });
    f.turn();
    f.agent.channelActivity.start("conversation", "request");
    await started.promise;
    await f.agent.channelActivity.run(f.jobs("channel_typing")[0]);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.agent.handleCancelTurn("conversation", "request");
    expect(f.fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    release.resolve();
    await f.drain();
    expect(f.jobs("channel_typing")).toEqual([]);
  });

  it("recovers background typing but not an orphaned foreground turn after reconstruction", async () => {
    const f = await fixture();
    const { batch_id } = await f.batch();
    f.agent.channelActivity.start("conversation", "request");
    await f.drain();
    const restored = await fixture(f.sql, f.control);
    await restored.agent.channelActivity.run(
      restored.jobs("channel_typing")[0],
    );
    expect(restored.fetcher).toHaveBeenCalledTimes(1);
    restored.agent.finishSubagentBatch(batch_id, "completed");
    restored.turn();
    restored.agent.channelActivity.start("conversation", "request");
    await restored.drain();
    const orphan = await fixture(f.sql, f.control);
    await orphan.agent.channelActivity.run(orphan.jobs("channel_typing")[0]);
    expect(orphan.fetcher).not.toHaveBeenCalled();
    expect(orphan.jobs("channel_typing")).toEqual([]);
  });

  it("delivers all 20 subagent results to Telegram after restart without another user message", async () => {
    const f = await fixture();
    const { batch_id } = await f.batch(20);
    f.sql.exec(
      "UPDATE subagent_tasks SET status='done',result_json=?",
      JSON.stringify({ text: "1, 2, 3, 4, 5, 6, 7, 8, 9, 10" }),
    );
    await f.agent.runBatchSynthesis(batch_id);
    expect(f.jobs("channel_reply")).toHaveLength(1);
    expect(f.fetcher).not.toHaveBeenCalled();
    const restored = await fixture(f.sql, f.control);
    await restored.agent.alarm();
    const [url, init] = restored.fetcher.mock.calls[0];
    expect(url).toContain("/sendMessage");
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe("42");
    expect(body.text.match(/1, 2, 3, 4, 5, 6, 7, 8, 9, 10/g)).toHaveLength(20);
    expect(restored.jobs("channel_reply")).toEqual([]);
    restored.agent.sendSubagentReply(
      "conversation",
      batch_id,
      "request",
      `batch_${batch_id}`,
      body.text,
    );
    await restored.agent.alarm();
    expect(restored.fetcher).toHaveBeenCalledTimes(1);
  });
});

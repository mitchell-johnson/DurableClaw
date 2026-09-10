import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { NanoChatAgent } from "../../src/durable-objects/NanoChatAgent";
import { createInternalAuthHeaders } from "../../src/utils/internalAuth";
import { queueWakeNotification } from "../../src/services/proactive/notifications";
import {
  beginWakeObservation,
  finishWakeObservation,
} from "../../src/services/proactive/wakeRecovery";
import { updateWakeRun } from "../../src/services/proactive/wakeTick";
import { writeObserverCursor } from "../../src/services/proactive/cursors";
import controlMigration from "../../migrations/0001_control.sql?raw";
import messagingMigration from "../../migrations/0002_messaging.sql?raw";

const runtime = env as any;
const configured = {
  ...runtime,
  TELEGRAM_BOT_TOKEN: "12345:test_only_bot_token",
  TELEGRAM_WEBHOOK_SECRET: "test_webhook_secret_at_least_32_characters",
};

beforeAll(async () => {
  for (const migration of [controlMigration, messagingMigration])
    for (const sql of migration
      .replace(/--.*$/gm, "")
      .split(";")
      .filter((statement) => statement.trim()))
      await runtime.CONTROL_DB.prepare(sql).run();
});
beforeEach(async () => {
  // The current Workers pool shares D1 state between tests in this file.
  await runtime.CONTROL_DB.batch(
    [
      "inbox",
      "messaging_links",
      "messaging_deliveries",
      "agent_wake_registry",
    ].map((table) => runtime.CONTROL_DB.prepare(`DELETE FROM ${table}`)),
  );
});
afterEach(() => vi.restoreAllMocks());

async function request(path: string, method = "GET", body?: unknown) {
  return new Request(`https://agent${path}`, {
    method,
    headers: await createInternalAuthHeaders(
      {
        userId: "owner",
        organizationId: "default",
        tenantBinding: "default",
        role: "owner",
      },
      "test-only-internal-secret",
    ),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// Reconstruct application instances over the same native DO SQLite storage.
// Only state lifecycle callbacks are supplied by the harness; storage and D1
// operations use the Cloudflare runtime throughout.
async function withAgent(
  test: (harness: {
    agent: any;
    state: DurableObjectState;
    construct: () => Promise<any>;
  }) => Promise<void>,
) {
  const stub = runtime.NANO_CHAT_AGENT.get(
    runtime.NANO_CHAT_AGENT.idFromName(crypto.randomUUID()),
  );
  await runInDurableObject(
    stub,
    async (_original: unknown, state: DurableObjectState) => {
      const background: Promise<unknown>[] = [];
      const construct = async () => {
        let initialized!: Promise<unknown>;
        const agent = new NanoChatAgent(
          {
            storage: state.storage,
            blockConcurrencyWhile: (work: () => Promise<unknown>) => {
              initialized = work();
            },
            getWebSockets: () => [],
            waitUntil: (work: Promise<unknown>) => background.push(work),
          } as any,
          configured,
        ) as any;
        await initialized;
        return agent;
      };
      try {
        const agent = await construct();
        const response = await agent.fetch(await request("/init", "POST", {}));
        expect(response.status).toBe(200);
        await test({ agent, state, construct });
      } finally {
        while (background.length) await Promise.all(background.splice(0));
        await state.storage.deleteAlarm();
      }
    },
  );
}

async function linkTelegram() {
  const id = crypto.randomUUID();
  await runtime.CONTROL_DB.prepare(
    "INSERT INTO messaging_links VALUES (?, 'owner', 'default', 'telegram', '42', '42', 'conversation', ?)",
  )
    .bind(id, Date.now())
    .run();
  return id;
}

function fakeTelegram(onSend?: () => Promise<void>) {
  const messages: Record<string, unknown>[] = [];
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const outgoing = new Request(input, init);
      expect(outgoing.redirect).toBe("manual");
      expect(outgoing.url).toBe(
        "https://api.telegram.org/bot12345:test_only_bot_token/sendMessage",
      );
      messages.push(await outgoing.json());
      await onSend?.();
      return Response.json({ ok: true, result: { message_id: 1 } });
    });
  return { messages, fetch };
}

describe("heartbeat delivery on native Cloudflare storage", () => {
  it("initializes a one-hour heartbeat and reports the persisted schedule after reconstruction", async () => {
    const started = Date.now();
    await withAgent(async ({ agent, state, construct }) => {
      const job = state.storage.sql
        .exec("SELECT * FROM scheduled_jobs WHERE job_id='wake'")
        .one();
      expect(job.run_at).toBeGreaterThanOrEqual(started + 3600_000);
      expect(job.run_at).toBeLessThanOrEqual(Date.now() + 3600_000);
      const response = await agent.fetch(await request("/persona"));
      expect(await response.json()).toMatchObject({
        persona: { wake_interval_minutes: 60 },
        heartbeat: {
          enabled: true,
          intervalMinutes: 60,
          nextRunAt: job.run_at,
          lastRun: null,
        },
      });
      expect(await state.storage.getAlarm()).toBe(job.run_at);
      const restored = await construct();
      const restoredResponse = await restored.fetch(await request("/persona"));
      expect(await restoredResponse.json()).toMatchObject({
        heartbeat: {
          enabled: true,
          intervalMinutes: 60,
          nextRunAt: job.run_at,
        },
      });
      expect(
        await runtime.CONTROL_DB.prepare(
          "SELECT enabled,next_wake_at FROM agent_wake_registry WHERE user_id='owner' AND org_id='default'",
        ).first(),
      ).toEqual({ enabled: 1, next_wake_at: job.run_at });
    });
  });

  it("restores and arms an outbox item when its delivery job was lost before restart", async () => {
    await withAgent(async ({ state, construct }) => {
      const sql = state.storage.sql;
      const now = Date.now();
      state.storage.transactionSync(() =>
        queueWakeNotification(sql, {
          id: "restart",
          content: "A reply arrived.",
          now,
        }),
      );
      sql.exec("DELETE FROM scheduled_jobs WHERE kind='wake_delivery'");
      await state.storage.deleteAlarm();
      const before = Date.now();
      await construct();
      expect(sql.exec("SELECT * FROM wake_notifications").toArray()).toEqual([
        {
          id: "restart",
          content: "A reply arrived.",
          proposals_json: "[]",
          created_at: now,
          delivered_at: null,
        },
      ]);
      const jobs = sql
        .exec("SELECT * FROM scheduled_jobs WHERE kind='wake_delivery'")
        .toArray();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].job_id).toBe("wake_delivery");
      expect(jobs[0].run_at).toBeGreaterThanOrEqual(before);
      expect(jobs[0].run_at).toBeLessThanOrEqual(Date.now());
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeGreaterThanOrEqual(before + 1000);
      expect(alarm).toBeLessThanOrEqual(Date.now() + 1000);
      expect(
        (await runtime.CONTROL_DB.prepare("SELECT * FROM inbox").all()).results,
      ).toEqual([]);
    });
  });

  it("keeps stable inbox IDs and sends once after a crash between provider delivery and outbox settlement", async () => {
    const linkId = await linkTelegram();
    await withAgent(async ({ agent, state, construct }) => {
      const sql = state.storage.sql;
      const now = Date.now();
      const proposal = {
        action_type: "review",
        why: "A reply arrived.",
        description: "Review the reply.",
      };
      state.storage.transactionSync(() =>
        queueWakeNotification(sql, {
          id: "crash",
          content: "Your application received a reply.",
          proposals: [proposal],
          now,
        }),
      );
      // Fail the native SQL write after the provider has accepted the message.
      sql.exec(
        "CREATE TRIGGER fail_heartbeat_settlement BEFORE UPDATE OF delivered_at ON wake_notifications BEGIN SELECT RAISE(ABORT, 'simulated crash after provider send'); END",
      );
      const { messages } = fakeTelegram(async () => {
        const recovery = sql
          .exec("SELECT run_at FROM scheduled_jobs WHERE kind='wake_delivery'")
          .one();
        expect(recovery.run_at).toBeGreaterThan(Date.now());
        expect(await state.storage.getAlarm()).toBe(recovery.run_at);
      });
      const job = sql
        .exec("SELECT * FROM scheduled_jobs WHERE kind='wake_delivery'")
        .one();
      await expect(agent.runJob(job)).rejects.toThrow(
        "simulated crash after provider send",
      );
      expect(messages).toMatchObject([
        { chat_id: "42", text: "Your application received a reply." },
      ]);
      expect(
        sql.exec("SELECT delivered_at FROM wake_notifications").one()
          .delivered_at,
      ).toBeNull();
      expect(
        (
          await runtime.CONTROL_DB.prepare(
            "SELECT id,kind,content,created_at FROM inbox ORDER BY id",
          ).all()
        ).results,
      ).toEqual([
        {
          id: "heartbeat_crash",
          kind: "insight",
          content: "Your application received a reply.",
          created_at: now,
        },
        {
          id: "heartbeat_crash_proposal_0",
          kind: "proposal",
          content: JSON.stringify(proposal),
          created_at: now,
        },
      ]);
      expect(
        (
          await runtime.CONTROL_DB.prepare(
            "SELECT link_id,status FROM messaging_deliveries",
          ).all()
        ).results,
      ).toEqual([{ link_id: linkId, status: "sent" }]);
      sql.exec("DROP TRIGGER fail_heartbeat_settlement");
      const restored = await construct();
      const retry = sql
        .exec("SELECT * FROM scheduled_jobs WHERE kind='wake_delivery'")
        .one();
      await restored.runJob(retry);
      await restored.runJob(retry);
      state.storage.transactionSync(() =>
        queueWakeNotification(sql, {
          id: "crash",
          content: "Your application received a reply.",
          proposals: [proposal],
          now,
        }),
      );
      await restored.runJob(retry);
      expect(messages).toHaveLength(1);
      expect(
        (
          await runtime.CONTROL_DB.prepare(
            "SELECT id FROM inbox ORDER BY id",
          ).all()
        ).results,
      ).toEqual([
        { id: "heartbeat_crash" },
        { id: "heartbeat_crash_proposal_0" },
      ]);
      expect(
        (
          await runtime.CONTROL_DB.prepare(
            "SELECT status FROM messaging_deliveries",
          ).all()
        ).results,
      ).toEqual([{ status: "sent" }]);
      expect(
        sql.exec("SELECT delivered_at FROM wake_notifications").one()
          .delivered_at,
      ).toBeTypeOf("number");
      expect(
        sql
          .exec("SELECT * FROM scheduled_jobs WHERE kind='wake_delivery'")
          .toArray(),
      ).toEqual([]);
    });
  });

  it("turns Off through the persona API and cancels pending delivery across reconstruction", async () => {
    await linkTelegram();
    const { fetch } = fakeTelegram();
    await withAgent(async ({ agent, state, construct }) => {
      const sql = state.storage.sql;
      state.storage.transactionSync(() =>
        queueWakeNotification(sql, {
          id: "cancel",
          content: "This should be cancelled.",
          now: Date.now(),
        }),
      );
      const staleJob = sql
        .exec("SELECT * FROM scheduled_jobs WHERE kind='wake_delivery'")
        .one();
      const response = await agent.fetch(
        await request("/persona", "PUT", { wake_interval_minutes: null }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        persona: { wake_interval_minutes: null },
        heartbeat: { enabled: false, intervalMinutes: null, nextRunAt: null },
      });
      const restored = await construct();
      await restored.runJob(staleJob);
      expect(sql.exec("SELECT * FROM wake_notifications").toArray()).toEqual(
        [],
      );
      expect(
        sql
          .exec(
            "SELECT * FROM scheduled_jobs WHERE kind IN ('wake','wake_delivery')",
          )
          .toArray(),
      ).toEqual([]);
      expect(
        (await runtime.CONTROL_DB.prepare("SELECT * FROM inbox").all()).results,
      ).toEqual([]);
      expect(
        (
          await runtime.CONTROL_DB.prepare(
            "SELECT * FROM messaging_deliveries",
          ).all()
        ).results,
      ).toEqual([]);
      expect(
        (
          await runtime.CONTROL_DB.prepare(
            "SELECT * FROM agent_wake_registry",
          ).all()
        ).results,
      ).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it.each(["schedule", "settlement"])(
    "rolls back the outbox, job, cursor, and wake completion when %s fails",
    async (failure) => {
      await withAgent(async ({ state }) => {
        const sql = state.storage.sql;
        const now = Date.now();
        sql.exec(
          "INSERT INTO wake_runs(run_id,trigger,status,started_at) VALUES('atomic','alarm','running',?)",
          now,
        );
        writeObserverCursor(sql, "workspace_events", "8", now);
        beginWakeObservation(sql, "atomic", ["workspace_events"]);
        sql.exec(
          failure === "schedule"
            ? "CREATE TRIGGER fail_heartbeat_transaction BEFORE INSERT ON scheduled_jobs WHEN NEW.kind='wake_delivery' BEGIN SELECT RAISE(ABORT, 'simulated transaction failure'); END"
            : "CREATE TRIGGER fail_heartbeat_transaction BEFORE DELETE ON wake_observation_windows BEGIN SELECT RAISE(ABORT, 'simulated transaction failure'); END",
        );
        const settle = () =>
          state.storage.transactionSync(() => {
            writeObserverCursor(sql, "workspace_events", "9", now);
            queueWakeNotification(sql, {
              id: "atomic",
              content: "A reply arrived.",
              now,
            });
            updateWakeRun(sql, "atomic", {
              status: "completed",
              completed_at: now,
            });
            finishWakeObservation(sql, "atomic");
          });
        expect(settle).toThrow("simulated transaction failure");
        expect(sql.exec("SELECT * FROM wake_notifications").toArray()).toEqual(
          [],
        );
        expect(
          sql
            .exec("SELECT * FROM scheduled_jobs WHERE kind='wake_delivery'")
            .toArray(),
        ).toEqual([]);
        expect(
          sql.exec("SELECT cursor_value FROM observer_cursors").one()
            .cursor_value,
        ).toBe("8");
        expect(
          sql
            .exec(
              "SELECT status,completed_at FROM wake_runs WHERE run_id='atomic'",
            )
            .one(),
        ).toEqual({ status: "running", completed_at: null });
        expect(
          sql.exec("SELECT run_id FROM wake_observation_windows").toArray(),
        ).toEqual([{ run_id: "atomic" }]);
        sql.exec("DROP TRIGGER fail_heartbeat_transaction");
        settle();
        expect(sql.exec("SELECT id FROM wake_notifications").toArray()).toEqual(
          [{ id: "atomic" }],
        );
        expect(
          sql
            .exec(
              "SELECT job_id FROM scheduled_jobs WHERE kind='wake_delivery'",
            )
            .toArray(),
        ).toEqual([{ job_id: "wake_delivery" }]);
        expect(
          sql.exec("SELECT cursor_value FROM observer_cursors").one()
            .cursor_value,
        ).toBe("9");
        expect(
          sql.exec("SELECT status FROM wake_runs WHERE run_id='atomic'").one()
            .status,
        ).toBe("completed");
        expect(
          sql.exec("SELECT * FROM wake_observation_windows").toArray(),
        ).toEqual([]);
      });
    },
  );
});

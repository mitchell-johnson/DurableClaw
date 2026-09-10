import { beforeEach, expect, it, vi } from "vitest";
import { createSqliteStorage } from "./helpers/sqlite";
import { runWakePassA } from "../src/services/proactive/wakeTick";
import { WAKE_RECOVERY_SCHEMA_SQL } from "../src/services/proactive/wakeRecovery";
import {
  WAKE_NOTIFICATION_SCHEMA_SQL,
  createWakeNotificationTool,
  queueWakeNotification,
  runWakeNotificationDelivery,
} from "../src/services/proactive/notifications";
import {
  isWakeIntervalMinutes,
  computeNextWakeAt,
} from "../src/durable-objects/assistant/wakeSettings";

const mocks = vi.hoisted(() => ({
  loop: vi.fn(),
  send: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock("../src/action-library/loop", () => ({ runToolLoop: mocks.loop }));
vi.mock("../src/channels/service", () => ({
  sendLinkedNotification: mocks.send,
}));
vi.mock("../src/auth", () => ({ authorizePrincipal: mocks.authorize }));

const signal = {
  kind: "email",
  salience: "medium" as const,
  entity_type: "email",
  entity_id: "message-1",
  summary: "A customer needs a response before today's deadline",
  occurred_at: 1,
  dedupe_key: "email:1",
};
function storage() {
  const sql = createSqliteStorage();
  sql.exec(`CREATE TABLE scheduled_jobs(job_id TEXT PRIMARY KEY,kind TEXT,run_at INTEGER,payload_json TEXT,created_at INTEGER);
    CREATE TABLE wake_runs(run_id TEXT PRIMARY KEY,batch_id TEXT,trigger TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,signal_count INTEGER,signals_json TEXT,triage_text TEXT,synthesis_text TEXT,tasks_json TEXT,tokens_in INTEGER,tokens_out INTEGER,error TEXT);
    CREATE TABLE observer_cursors(observer_name TEXT PRIMARY KEY,cursor_value TEXT,updated_at INTEGER);
    CREATE TABLE wake_signals_seen(dedupe_key TEXT PRIMARY KEY,first_seen_at INTEGER,expires_at INTEGER);
    CREATE TABLE agent_usage(day_utc TEXT PRIMARY KEY,triage_turns INTEGER,subagent_spawns INTEGER);`);
  sql.exec(WAKE_RECOVERY_SCHEMA_SQL);
  sql.exec(WAKE_NOTIFICATION_SCHEMA_SQL);
  return sql;
}
function deps(
  sql = storage(),
  events: unknown[] = [
    {
      sequence: 1,
      kind: "email",
      resource_id: "message-1",
      summary: signal.summary,
      salience: "medium",
      occurred_at: 1,
    },
  ],
) {
  return {
    env: {} as any,
    sql,
    transactionSync: <T>(fn: () => T) => fn(),
    tenantDB: {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: events }) }),
      }),
    } as any,
    user: {
      id: "owner",
      role: "owner",
      permissions: [
        {
          user_id: "owner",
          resource_type: "workspace",
          permission_type: "read",
        },
      ],
    },
    organizationId: "default",
    memoryTools: {},
    spawnTasks: vi.fn(),
    now: Date.now(),
  } as any;
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue({
    userId: "owner",
    workspaceId: "default",
    role: "owner",
  });
});

it("supports an hourly default cadence and configurable intervals through a day", () => {
  for (const minutes of [10, 15, 20, 30, 45, 60, 120, 240, 720, 1440])
    expect(isWakeIntervalMinutes(minutes)).toBe(true);
  for (const minutes of [0, -1, 1.5, 10080, "60", NaN])
    expect(isWakeIntervalMinutes(minutes)).toBe(false);
  expect(computeNextWakeAt(1000, 60)).toBe(3_601_000);
});
it("does not call the model or send notifications without new events", async () => {
  const d = deps(storage(), []);
  expect((await runWakePassA(d)).outcome).toBe("quiet");
  expect(mocks.loop).not.toHaveBeenCalled();
  expect(d.sql.exec("SELECT * FROM wake_notifications").toArray()).toEqual([]);
});
it("stays quiet when model text describes routine events but makes no attention decision", async () => {
  const d = deps();
  mocks.loop.mockResolvedValue({
    text: "Only a routine newsletter arrived. Nothing needs attention.",
    usage: {},
  });
  expect((await runWakePassA(d)).outcome).toBe("quiet");
  expect(d.sql.exec("SELECT * FROM wake_notifications").toArray()).toEqual([]);
  expect(mocks.send).not.toHaveBeenCalled();
});
it("durably queues an explicit grounded attention decision and suppresses the same event next time", async () => {
  const d = deps();
  mocks.loop.mockImplementation(async ({ tools }: any) => {
    await tools.notify_user.execute({
      message: "A customer needs your reply today.",
      signal_keys: ["event:1"],
    });
    return { text: "Done", usage: {} };
  });
  const result = await runWakePassA(d);
  expect(result.outcome).toBe("completed");
  expect(d.sql.exec("SELECT * FROM wake_notifications").toArray()).toEqual([
    expect.objectContaining({
      id: result.run_id,
      content: "A customer needs your reply today.",
      delivered_at: null,
    }),
  ]);
  expect(d.sql.exec("SELECT kind FROM scheduled_jobs").one().kind).toBe(
    "wake_delivery",
  );
  expect(mocks.send).not.toHaveBeenCalled();
  expect((await runWakePassA(d)).outcome).toBe("quiet");
  expect(mocks.loop).toHaveBeenCalledTimes(1);
});
it("rejects ungrounded notifications and duplicate notify calls", async () => {
  const record = vi.fn();
  const tool: any = createWakeNotificationTool([signal], record).notify_user;
  await tool.execute({
    message: "Invented event",
    signal_keys: ["not-observed"],
  });
  expect(record).not.toHaveBeenCalled();
  await tool.execute({
    message: "Please reply today",
    signal_keys: ["email:1"],
  });
  await tool.execute({
    message: "A second notification",
    signal_keys: ["email:1"],
  });
  expect(record).toHaveBeenCalledTimes(1);
});
it("does not queue a notification after the heartbeat is switched off during triage", async () => {
  const d = deps();
  let enabled = true;
  d.stillEnabled = () => enabled;
  mocks.loop.mockImplementation(async ({ tools }: any) => {
    await tools.notify_user.execute({
      message: "Needs attention",
      signal_keys: ["event:1"],
    });
    enabled = false;
    return { text: "Done", usage: {} };
  });
  await runWakePassA(d);
  expect(d.sql.exec("SELECT * FROM wake_notifications").toArray()).toEqual([]);
});
it("retains a notification and its retry alarm when delivery preparation fails", async () => {
  const sql = storage();
  queueWakeNotification(sql, {
    id: "wake-1",
    content: "Please reply",
    now: 1000,
  });
  const env: any = {
    CONTROL_DB: {
      prepare: () => {
        throw new Error("Storage unavailable");
      },
    },
  };
  const rearm = vi.fn();
  await expect(
    runWakeNotificationDelivery({
      sql,
      env,
      userId: "owner",
      workspaceId: "default",
      shouldSend: () => true,
      rearm,
      now: 2000,
    }),
  ).rejects.toThrow("Storage unavailable");
  expect(
    sql.exec("SELECT delivered_at FROM wake_notifications").one().delivered_at,
  ).toBeNull();
  expect(
    sql.exec("SELECT run_at FROM scheduled_jobs").one().run_at,
  ).toBeGreaterThan(2000);
  expect(rearm).toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it("settles old outbox entries in the inbox without resending after channel claims expire", async () => {
  const sql = storage();
  const now = Date.now();
  queueWakeNotification(sql, {
    id: "already-sent",
    content: "Important update",
    now: now - 49 * 3600_000,
  });
  const inbox = new Set(["heartbeat_already-sent"]);
  const env: any = {
    CONTROL_DB: {
      prepare: () => ({ bind: (...values: unknown[]) => values }),
      batch: async (rows: unknown[][]) => {
        for (const row of rows) inbox.add(String(row[0]));
      },
    },
  };
  await runWakeNotificationDelivery({
    sql,
    env,
    userId: "owner",
    workspaceId: "default",
    shouldSend: () => true,
    rearm: async () => {},
    now,
  });
  expect(inbox.size).toBe(1);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(
    sql.exec("SELECT delivered_at FROM wake_notifications").one().delivered_at,
  ).toEqual(expect.any(Number));
});
it("checks the external delivery age again during asynchronous preparation", async () => {
  vi.useFakeTimers();
  try {
    const now = Date.now();
    const sql = storage();
    queueWakeNotification(sql, {
      id: "near-deadline",
      content: "Important update",
      now: now - 24 * 3600_000 + 100,
    });
    const provider = vi.fn();
    mocks.send.mockImplementation(async (_env, _principal, notification) => {
      vi.setSystemTime(now + 200);
      if (notification.shouldSend()) provider();
    });
    const env: any = {
      CONTROL_DB: {
        prepare: () => ({ bind: () => ({}) }),
        batch: async () => [],
      },
    };
    await runWakeNotificationDelivery({
      sql,
      env,
      userId: "owner",
      workspaceId: "default",
      shouldSend: () => true,
      rearm: async () => {},
      now,
    });
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(provider).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

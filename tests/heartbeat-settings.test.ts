import { expect, it, vi } from "vitest";
import { NanoChatAgent } from "../src/durable-objects/NanoChatAgent";
import { createSqliteStorage } from "./helpers/sqlite";
import { queueWakeNotification } from "../src/services/proactive/notifications";
const mocks = vi.hoisted(() => ({ loop: vi.fn() }));
vi.mock("../src/action-library/loop", async (original) => ({
  ...(await original<object>()),
  runToolLoop: mocks.loop,
}));

function fixture() {
  const sql = createSqliteStorage();
  const agent: any = Object.create(NanoChatAgent.prototype);
  Object.assign(agent, {
    sql,
    env: { AGENT_TOKEN: "synthetic" },
    state: { storage: { transactionSync: (f: () => unknown) => f() } },
    context: {
      user_id: "owner",
      tenant_binding: "default",
      organization_id: "default",
      user_role: "owner",
    },
    rearmAlarm: vi.fn(),
    syncWakeRegistry: vi.fn(),
  });
  agent.ensureSchema();
  return { agent, sql };
}
it("persists an hourly heartbeat for a new agent and does not overwrite an existing Off preference", async () => {
  const { agent, sql } = fixture();
  agent.ensurePersonaDefaults("owner");
  expect(agent.getWakeIntervalMinutes("owner")).toBe(60);
  await agent.resumeWakeScheduleIfNeeded("owner");
  const next = Number(
    sql.exec("SELECT run_at FROM scheduled_jobs WHERE kind='wake'").one()
      .run_at,
  );
  expect(next - Date.now()).toBeGreaterThan(3590000);
  expect(next - Date.now()).toBeLessThanOrEqual(3600000);
  sql.exec(
    "UPDATE persona SET wake_interval_minutes=NULL WHERE user_id='owner'",
  );
  agent.ensurePersonaDefaults("owner");
  expect(agent.getWakeIntervalMinutes("owner")).toBeNull();
});
it("returns last and next heartbeat status without making the status fields persona settings", async () => {
  const { agent, sql } = fixture();
  agent.ensurePersonaDefaults("owner");
  await agent.resumeWakeScheduleIfNeeded("owner");
  sql.exec(
    "INSERT INTO wake_runs(run_id,trigger,status,started_at,completed_at) VALUES('w','alarm','quiet',1000,2000)",
  );
  const data = await (
    await agent.handlePersona(new Request("https://agent/persona"))
  ).json();
  expect(data.heartbeat).toMatchObject({
    enabled: true,
    intervalMinutes: 60,
    nextRunAt: expect.any(Number),
    lastRun: {
      status: "quiet",
      startedAt: 1000,
      completedAt: 2000,
      error: null,
    },
  });
  expect(data.persona.heartbeat).toBeUndefined();
});
it("switching Off cancels both future checks and pending notification delivery", async () => {
  const { agent, sql } = fixture();
  agent.ensurePersonaDefaults("owner");
  await agent.resumeWakeScheduleIfNeeded("owner");
  queueWakeNotification(sql, { id: "w", content: "Please review", now: 1 });
  await agent.applyWakeScheduleChange(null);
  expect(
    sql
      .exec("SELECT * FROM wake_notifications WHERE delivered_at IS NULL")
      .toArray(),
  ).toEqual([]);
  expect(
    sql
      .exec(
        "SELECT * FROM scheduled_jobs WHERE kind IN ('wake','wake_delivery')",
      )
      .toArray(),
  ).toEqual([]);
});
it.each([false, true])(
  "subagent synthesis only queues an explicitly selected notification (%s)",
  async (notify) => {
    const { agent, sql } = fixture();
    agent.ensurePersonaDefaults("owner");
    agent.finishSubagentBatch = vi.fn();
    agent.ensureNextWakeScheduled = vi.fn();
    const signals = [
      {
        kind: "email",
        salience: "medium",
        entity_type: "email",
        entity_id: "m1",
        summary: "Please reply today",
        occurred_at: 1,
        dedupe_key: "email:1",
      },
    ];
    sql.exec(
      "INSERT INTO wake_runs(run_id,batch_id,trigger,status,started_at,signals_json) VALUES('w','b','alarm','awaiting_batch',1000,?)",
      JSON.stringify(signals),
    );
    mocks.loop.mockImplementation(async ({ tools }: any) => {
      if (notify)
        await tools.notify_user.execute({
          message: "A customer needs your response today",
          signal_keys: ["email:1"],
        });
      return {
        text: notify ? "Done" : "Nothing warrants attention",
        usage: {},
      };
    });
    await agent.runWakeBatchSynthesis("b", {
      total: 1,
      settled: 1,
      results: [],
    });
    expect(sql.exec("SELECT * FROM wake_notifications").toArray()).toHaveLength(
      notify ? 1 : 0,
    );
    expect(
      sql.exec("SELECT status FROM wake_runs WHERE run_id='w'").one().status,
    ).toBe(notify ? "completed" : "quiet");
  },
);

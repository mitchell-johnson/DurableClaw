import { beforeEach, expect, it, vi } from "vitest";
import { createSqliteStorage } from "./helpers/sqlite";
import { runWakePassA, getWakeRun } from "../src/services/proactive/wakeTick";
import {
  WAKE_RECOVERY_SCHEMA_SQL,
  recoverInterruptedWakes,
} from "../src/services/proactive/wakeRecovery";
import { readDailyUsage, dayUtc } from "../src/services/proactive/budget";
const mocks = vi.hoisted(() => ({ loop: vi.fn(), outputs: vi.fn() }));
vi.mock("../src/action-library/loop", () => ({ runToolLoop: mocks.loop }));
vi.mock("../src/services/proactive/outputs", () => ({
  createWakeOutputs: mocks.outputs,
  resolveWakeNotificationCap: () => 5,
}));
function storage() {
  const sql = createSqliteStorage();
  sql.exec(`CREATE TABLE wake_runs(run_id TEXT PRIMARY KEY,batch_id TEXT,trigger TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,signal_count INTEGER,signals_json TEXT,triage_text TEXT,synthesis_text TEXT,tasks_json TEXT,tokens_in INTEGER,tokens_out INTEGER,error TEXT);
  CREATE TABLE observer_cursors(observer_name TEXT PRIMARY KEY,cursor_value TEXT,updated_at INTEGER);
  CREATE TABLE wake_signals_seen(dedupe_key TEXT PRIMARY KEY,first_seen_at INTEGER,expires_at INTEGER);
  CREATE TABLE agent_usage(day_utc TEXT PRIMARY KEY,triage_turns INTEGER,subagent_spawns INTEGER);`);
  sql.exec(WAKE_RECOVERY_SCHEMA_SQL);
  return sql;
}
function deps(sql: ReturnType<typeof storage>) {
  return {
    env: {} as any,
    sql,
    transactionSync: <T>(fn: () => T) => fn(),
    tenantDB: {
      prepare: () => ({
        bind: () => ({
          all: async () => ({
            results: [
              {
                sequence: 1,
                kind: "updated",
                resource_id: "note.md",
                summary: "Note updated",
                salience: "high",
                occurred_at: 1,
              },
            ],
          }),
        }),
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
beforeEach(() => vi.resetAllMocks());
it("releases observation consumption after a failed triage, while retaining its charged turn", async () => {
  const sql = storage();
  const d = deps(sql);
  mocks.loop.mockRejectedValue(new Error("provider unavailable"));
  const result = await runWakePassA(d);
  expect(result.outcome).toBe("failed");
  expect(sql.exec("SELECT * FROM observer_cursors").toArray()).toEqual([]);
  expect(sql.exec("SELECT * FROM wake_signals_seen").toArray()).toEqual([]);
  expect(readDailyUsage(sql, dayUtc(d.now)).triage_turns).toBe(1);
});
it("reconstruction restores a committed observation window while triage is pending", async () => {
  const sql = storage();
  const d = deps(sql);
  let release!: (v: unknown) => void;
  mocks.loop.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const pending = runWakePassA(d);
  await vi.waitFor(() => expect(mocks.loop).toHaveBeenCalled());
  expect(
    sql.exec("SELECT cursor_value FROM observer_cursors").one().cursor_value,
  ).toBe("1");
  expect(sql.exec("SELECT * FROM wake_signals_seen").toArray()).toHaveLength(1);
  recoverInterruptedWakes(sql, Date.now());
  expect(sql.exec("SELECT * FROM observer_cursors").toArray()).toEqual([]);
  expect(sql.exec("SELECT * FROM wake_signals_seen").toArray()).toEqual([]);
  expect(sql.exec("SELECT status FROM wake_runs").one().status).toBe("failed");
  // End the simulated discarded isolate's suspended promise only after recovery assertions.
  release({ text: "finished", usage: {} });
  await pending;
});
it("keeps an admitted batch associated when the provider fails after spawning", async () => {
  const sql = storage();
  const d = deps(sql);
  d.spawnTasks.mockImplementation(async (_tasks: unknown, runId: string) => {
    sql.exec(
      "UPDATE wake_runs SET batch_id='batch-admitted',status='awaiting_batch' WHERE run_id=?",
      runId,
    );
    return { batch_id: "batch-admitted", queued: 1 };
  });
  mocks.loop.mockImplementation(async ({ tools }: any) => {
    await tools.spawn_subagents.execute({ tasks: [{ goal: "Inspect note" }] });
    throw new Error("failed after admission");
  });
  const result = await runWakePassA(d);
  expect(result.outcome).toBe("spawned");
  expect(getWakeRun(sql, result.run_id)).toMatchObject({
    batch_id: "batch-admitted",
    status: "awaiting_batch",
  });
  expect(sql.exec("SELECT * FROM wake_signals_seen").toArray()).toHaveLength(1);
});
it("retains untriaged observations when the daily budget is exhausted", async () => {
  const sql = storage();
  const d = deps(sql);
  sql.exec("INSERT INTO agent_usage VALUES (?,48,100)", dayUtc(d.now));
  const result = await runWakePassA(d);
  expect(result.outcome).toBe("failed");
  expect(sql.exec("SELECT * FROM observer_cursors").toArray()).toEqual([]);
  expect(sql.exec("SELECT * FROM wake_signals_seen").toArray()).toEqual([]);
  expect(mocks.loop).not.toHaveBeenCalled();
});

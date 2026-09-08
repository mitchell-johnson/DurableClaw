import { expect, it, vi } from "vitest";
import { createSqliteStorage } from "./helpers/sqlite";
import { WAKE_RECOVERY_SCHEMA_SQL } from "../src/services/proactive/wakeRecovery";
import { NanoChatAgent } from "../src/durable-objects/NanoChatAgent";
const mocks = vi.hoisted(() => ({ loop: vi.fn() }));
vi.mock("../src/action-library/loop", () => ({ runToolLoop: mocks.loop }));
it("keeps an in-flight wake from recreating a disabled schedule", async () => {
  const sql = createSqliteStorage();
  sql.exec(`CREATE TABLE scheduled_jobs(job_id TEXT PRIMARY KEY,kind TEXT,run_at INTEGER,payload_json TEXT,created_at INTEGER);
 CREATE TABLE wake_runs(run_id TEXT PRIMARY KEY,batch_id TEXT,trigger TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,signal_count INTEGER,signals_json TEXT,triage_text TEXT,synthesis_text TEXT,tasks_json TEXT,tokens_in INTEGER,tokens_out INTEGER,error TEXT);
 CREATE TABLE observer_cursors(observer_name TEXT PRIMARY KEY,cursor_value TEXT,updated_at INTEGER);
 CREATE TABLE wake_signals_seen(dedupe_key TEXT PRIMARY KEY,first_seen_at INTEGER,expires_at INTEGER);
 CREATE TABLE agent_usage(day_utc TEXT PRIMARY KEY,triage_turns INTEGER,subagent_spawns INTEGER);`);
  sql.exec(WAKE_RECOVERY_SCHEMA_SQL);
  let interval: number | null = 10;
  const agent: any = Object.create(NanoChatAgent.prototype);
  Object.assign(agent, {
    sql,
    context: {
      user_id: "owner",
      tenant_binding: "default",
      organization_id: "default",
      user_role: "owner",
    },
    state: { storage: { transactionSync: (f: any) => f() } },
    env: {
      AGENT_TOKEN: "synthetic",
      CONTROL_DB: {
        prepare: () => ({
          bind: () => ({
            all: async () => ({
              results: [
                {
                  sequence: 1,
                  kind: "update",
                  resource_id: "note.md",
                  summary: "Synthetic note changed",
                  salience: "high",
                  occurred_at: 1,
                },
              ],
            }),
          }),
        }),
      },
    },
    rearmAlarm: async () => {},
    getWakeIntervalMinutes: () => interval,
    getPersonaSettings: () => ({ memoryEnabled: false }),
    getPersonaRow: () => null,
    syncWakeRegistry: vi.fn(),
  });
  mocks.loop.mockImplementation(async () => {
    interval = null;
    sql.exec("DELETE FROM scheduled_jobs WHERE kind='wake'");
    return { text: "A synthetic note needs attention", usage: {} };
  });
  await agent.runWakeJob();
  expect(interval).toBeNull();
  expect(
    sql.exec("SELECT kind FROM scheduled_jobs WHERE job_id='wake'").toArray(),
  ).toEqual([]);
  expect(agent.syncWakeRegistry).not.toHaveBeenCalledWith(
    expect.any(Number),
    "upsert",
  );
});

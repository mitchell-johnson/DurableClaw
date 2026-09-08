import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { NanoChatAgent } from "../../src/durable-objects/NanoChatAgent";
import { createInternalAuthHeaders } from "../../src/utils/internalAuth";
import { dayUtc } from "../../src/services/proactive/budget";
const runtime = env as any;
async function headers() {
  return createInternalAuthHeaders(
    {
      userId: "owner",
      organizationId: "default",
      tenantBinding: "default",
      role: "owner",
    },
    "test-only-internal-secret",
  );
}
async function fresh() {
  const stub = runtime.NANO_CHAT_AGENT.get(
    runtime.NANO_CHAT_AGENT.idFromName(crypto.randomUUID()),
  );
  await stub.fetch("https://agent/init", {
    method: "POST",
    headers: await headers(),
    body: "{}",
  });
  return stub;
}
function run(sql: SqlStorage, id: string) {
  sql.exec(
    "INSERT INTO wake_runs (run_id,trigger,status,started_at) VALUES (?,'alarm','running',?)",
    id,
    Date.now(),
  );
}
const tasks = [{ goal: "Read note", tier: "background" }];
describe("native wake admission and recovery", () => {
  it("atomically associates and charges once before parallel calls can dispatch", async () => {
    const result = await runInDurableObject(
      await fresh(),
      async (agent: any, state: DurableObjectState) => {
        run(state.storage.sql, "one");
        let observations = 0;
        agent.pumpDispatch = async () => {
          const association = state.storage.sql
            .exec("SELECT batch_id FROM wake_runs WHERE run_id='one'")
            .one();
          const charge = state.storage.sql
            .exec("SELECT subagent_spawns FROM agent_usage")
            .one();
          if (association.batch_id && charge.subagent_spawns === 1)
            observations++;
        };
        const results = await Promise.all(
          [1, 2].map(() =>
            agent.spawnSubagentBatch({
              origin: "wake",
              wake_run_id: "one",
              conversation_id: null,
              tasks,
            }),
          ),
        );
        return {
          results,
          observations,
          charge: state.storage.sql
            .exec("SELECT subagent_spawns FROM agent_usage")
            .one().subagent_spawns,
          batches: state.storage.sql
            .exec("SELECT batch_id FROM subagent_batches")
            .toArray().length,
        };
      },
    );
    expect(result.results[0]).toEqual(result.results[1]);
    expect(result).toMatchObject({ observations: 1, charge: 1, batches: 1 });
  });
  it("enforces remaining capacity without partial or phantom admission", async () => {
    const result = await runInDurableObject(
      await fresh(),
      async (agent: any, state: DurableObjectState) => {
        const sql = state.storage.sql;
        run(sql, "near");
        run(sql, "full");
        sql.exec("INSERT INTO agent_usage VALUES (?,0,99)", dayUtc(Date.now()));
        agent.pumpDispatch = async () => 0;
        const args = {
          origin: "wake",
          wake_run_id: "near",
          conversation_id: null,
          tasks,
        };
        let oversized = false,
          exhausted = false;
        try {
          await agent.spawnSubagentBatch({
            ...args,
            tasks: [...tasks, ...tasks],
          });
        } catch {
          oversized = true;
        }
        const admitted = await agent.spawnSubagentBatch(args);
        try {
          await agent.spawnSubagentBatch({ ...args, wake_run_id: "full" });
        } catch {
          exhausted = true;
        }
        return {
          oversized,
          exhausted,
          admitted,
          charge: sql.exec("SELECT subagent_spawns FROM agent_usage").one()
            .subagent_spawns,
          batches: sql.exec("SELECT batch_id FROM subagent_batches").toArray()
            .length,
        };
      },
    );
    expect(result).toMatchObject({
      oversized: true,
      exhausted: true,
      charge: 100,
      batches: 1,
      admitted: { queued: 1 },
    });
  });
  it("retains admission through dispatch failure and reconstruction without double charging", async () => {
    const result = await runInDurableObject(
      await fresh(),
      async (agent: any, state: DurableObjectState) => {
        run(state.storage.sql, "failed-dispatch");
        agent.pumpDispatch = async () => {
          throw new Error("dispatch interrupted");
        };
        const args = {
          origin: "wake",
          wake_run_id: "failed-dispatch",
          conversation_id: null,
          tasks,
        };
        try {
          await agent.spawnSubagentBatch(args);
        } catch {}
        const restored = new NanoChatAgent(state, env as any);
        await restored.fetch(
          new Request("https://agent/init", {
            method: "POST",
            headers: await headers(),
            body: "{}",
          }),
        );
        const admitted = await restored.spawnSubagentBatch(args as any);
        return {
          admitted,
          charge: state.storage.sql
            .exec("SELECT subagent_spawns FROM agent_usage")
            .one().subagent_spawns,
          status: state.storage.sql.exec("SELECT status FROM wake_runs").one()
            .status,
        };
      },
    );
    expect(result).toMatchObject({
      admitted: { queued: 1 },
      charge: 1,
      status: "awaiting_batch",
    });
  });
  it.each(["triage", "publishing"])(
    "recovers %s windows with an explicit replay boundary",
    async (phase) => {
      const result = await runInDurableObject(
        await fresh(),
        async (_agent: any, state: DurableObjectState) => {
          const sql = state.storage.sql;
          run(sql, "interrupted");
          sql.exec(
            "UPDATE wake_runs SET signals_json=? WHERE run_id='interrupted'",
            JSON.stringify([{ dedupe_key: "event:9" }]),
          );
          sql.exec(
            "INSERT INTO observer_cursors VALUES ('workspace_events','9',?)",
            Date.now(),
          );
          sql.exec(
            "INSERT INTO wake_signals_seen VALUES ('event:9',?,?)",
            Date.now(),
            Date.now() + 100000,
          );
          sql.exec(
            "INSERT INTO wake_observation_windows VALUES ('interrupted',?,?)",
            JSON.stringify({ workspace_events: "8" }),
            phase,
          );
          const restored = new NanoChatAgent(state, env as any);
          await restored.fetch(
            new Request("https://agent/init", {
              method: "POST",
              headers: await headers(),
              body: "{}",
            }),
          );
          return {
            run: sql.exec("SELECT status,error FROM wake_runs").one(),
            cursor: sql.exec("SELECT cursor_value FROM observer_cursors").one()
              .cursor_value,
            seen: sql.exec("SELECT * FROM wake_signals_seen").toArray().length,
          };
        },
      );
      expect(result.run.status).toBe("failed");
      expect(result.cursor).toBe(phase === "triage" ? "8" : "9");
      expect(result.seen).toBe(phase === "triage" ? 0 : 1);
      if (phase === "publishing")
        expect(result.run.error).toContain("output may be incomplete");
    },
  );
});

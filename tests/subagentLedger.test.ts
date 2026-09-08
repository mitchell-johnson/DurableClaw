/**
 * The subagent ledger — durable task state and, via the count of in-flight
 * (dispatched or running) rows, the per-user concurrency semaphore.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSqliteStorage } from "./helpers/sqlite";
import {
  insertBatch,
  claimSlots,
  settleTask,
  sweepTimeouts,
  batchState,
  inFlightCount,
  MAX_CONCURRENT_SUBAGENTS,
} from "../src/durable-objects/assistant/subagentLedger";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subagent_tasks (
  task_id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, origin TEXT NOT NULL,
  conversation_id TEXT, goal TEXT NOT NULL, tier TEXT NOT NULL,
  toolset TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
  result_json TEXT, error TEXT, created_at INTEGER NOT NULL,
  started_at INTEGER, finished_at INTEGER, deadline_at INTEGER NOT NULL,
  tokens_in INTEGER, tokens_out INTEGER
);
CREATE INDEX idx_subagent_status ON subagent_tasks(status);
CREATE INDEX idx_subagent_batch ON subagent_tasks(batch_id, status);
`;

let sql: ReturnType<typeof createSqliteStorage>;
beforeEach(() => {
  sql = createSqliteStorage();
  sql.exec(SCHEMA);
});

function seedBatch(count: number, batch_id = "b1") {
  insertBatch(sql, {
    batch_id,
    origin: "chat",
    conversation_id: "conv_a",
    toolset: ["search_records", "get_entity"],
    now: 1000,
    deadline_at: 61_000,
    tasks: Array.from({ length: count }, (_, i) => ({
      task_id: `${batch_id}_t${i}`,
      goal: `goal ${i}`,
      tier: i % 2 === 0 ? ("background" as const) : ("foreground" as const),
    })),
  });
}

describe("insertBatch", () => {
  it("writes one queued row per task carrying the shared batch fields", () => {
    seedBatch(3);
    const rows = sql.exec("SELECT * FROM subagent_tasks").toArray() as any[];
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "queued")).toBe(true);
    expect(rows.every((r) => r.batch_id === "b1")).toBe(true);
    expect(rows.every((r) => r.deadline_at === 61_000)).toBe(true);
    expect(JSON.parse(rows[0].toolset)).toEqual([
      "search_records",
      "get_entity",
    ]);
  });

  it("preserves the per-task tier", () => {
    seedBatch(2);
    const rows = sql
      .exec("SELECT task_id, tier FROM subagent_tasks")
      .toArray() as any[];
    expect(rows.find((r) => r.task_id === "b1_t0").tier).toBe("background");
    expect(rows.find((r) => r.task_id === "b1_t1").tier).toBe("foreground");
  });
});

describe("claimSlots", () => {
  it("marks claimed tasks dispatched and returns them", () => {
    seedBatch(3);
    const claimed = claimSlots(sql, { cap: 100, limit: 10, now: 1500 });
    expect(claimed).toHaveLength(3);
    const rows = sql
      .exec("SELECT status FROM subagent_tasks")
      .toArray() as any[];
    expect(rows.every((r) => r.status === "dispatched")).toBe(true);
  });

  it("never claims past the cap", () => {
    seedBatch(10);
    const first = claimSlots(sql, { cap: 4, limit: 10, now: 1500 });
    expect(first).toHaveLength(4);
    // Four are in flight, so the cap leaves no room at all.
    expect(claimSlots(sql, { cap: 4, limit: 10, now: 1500 })).toHaveLength(0);
  });

  it("frees a slot when an in-flight task settles", () => {
    seedBatch(10);
    claimSlots(sql, { cap: 2, limit: 10, now: 1500 });
    settleTask(sql, {
      task_id: "b1_t0",
      status: "done",
      result_json: "{}",
      now: 2000,
    });
    expect(claimSlots(sql, { cap: 2, limit: 10, now: 1500 })).toHaveLength(1);
  });

  it("respects the per-call limit independently of the cap", () => {
    seedBatch(10);
    expect(claimSlots(sql, { cap: 100, limit: 3, now: 1500 })).toHaveLength(3);
  });

  it("defaults the cap to 100 concurrent subagents per user", () => {
    expect(MAX_CONCURRENT_SUBAGENTS).toBe(100);
  });

  it("stamps started_at on every row it claims", () => {
    // Nothing else ever writes this column — no code path writes `running` —
    // so if the claim does not stamp it, `started_at` is null for the life of
    // every task and any later reader of it is reading a lie.
    seedBatch(2);
    const claimed = claimSlots(sql, { cap: 100, limit: 10, now: 1500 });

    expect(claimed.every((t) => t.started_at === 1500)).toBe(true);
    const rows = sql
      .exec("SELECT started_at FROM subagent_tasks")
      .toArray() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.started_at === 1500)).toBe(true);
  });

  it("leaves started_at null on a task that is still queued", () => {
    seedBatch(3);
    claimSlots(sql, { cap: 1, limit: 10, now: 1500 });

    const rows = sql
      .exec("SELECT status, started_at FROM subagent_tasks")
      .toArray() as any[];
    const waiting = rows.filter((r) => r.status === "queued");
    expect(waiting).toHaveLength(2);
    expect(
      waiting.every((r) => r.started_at === null || r.started_at === undefined),
    ).toBe(true);
  });
});

describe("settleTask", () => {
  it("transitions a dispatched task and reports that it did", () => {
    seedBatch(1);
    claimSlots(sql, { cap: 100, limit: 10, now: 1500 });
    const settled = settleTask(sql, {
      task_id: "b1_t0",
      status: "done",
      result_json: '{"answer":"42"}',
      tokens_in: 10,
      tokens_out: 20,
      now: 5000,
    });
    expect(settled).toBe(true);
    const row = (
      sql.exec("SELECT * FROM subagent_tasks").toArray() as any[]
    )[0];
    expect(row.status).toBe("done");
    expect(row.finished_at).toBe(5000);
    expect(row.tokens_out).toBe(20);
  });

  it("ignores a duplicate callback for an already-settled task", () => {
    // The subagent calls back over the network, so retries WILL happen. A
    // second callback must not re-settle the row or double-count the batch.
    seedBatch(1);
    claimSlots(sql, { cap: 100, limit: 10, now: 1500 });
    expect(
      settleTask(sql, { task_id: "b1_t0", status: "done", now: 5000 }),
    ).toBe(true);
    expect(
      settleTask(sql, {
        task_id: "b1_t0",
        status: "failed",
        error: "late",
        now: 9000,
      }),
    ).toBe(false);

    const row = (
      sql.exec("SELECT * FROM subagent_tasks").toArray() as any[]
    )[0];
    expect(row.status).toBe("done");
    expect(row.finished_at).toBe(5000);
  });

  it("returns false for an unknown task id", () => {
    expect(settleTask(sql, { task_id: "nope", status: "done", now: 1 })).toBe(
      false,
    );
  });
});

describe("sweepTimeouts", () => {
  it("times out only non-terminal tasks past their deadline", () => {
    seedBatch(3);
    claimSlots(sql, { cap: 100, limit: 10, now: 1500 });
    settleTask(sql, { task_id: "b1_t0", status: "done", now: 2000 });

    const swept = sweepTimeouts(sql, { batch_id: "b1", now: 99_000 });

    expect(swept).toBe(2);
    const rows = sql
      .exec("SELECT task_id, status FROM subagent_tasks")
      .toArray() as any[];
    expect(rows.find((r) => r.task_id === "b1_t0").status).toBe("done");
    expect(rows.find((r) => r.task_id === "b1_t1").status).toBe("timeout");
  });

  it("leaves tasks alone before their deadline", () => {
    seedBatch(2);
    claimSlots(sql, { cap: 100, limit: 10, now: 1500 });
    expect(sweepTimeouts(sql, { batch_id: "b1", now: 2000 })).toBe(0);
  });
});

describe("batchState", () => {
  it("reports totals and settles only when every task is terminal", () => {
    seedBatch(2);
    claimSlots(sql, { cap: 100, limit: 10, now: 1500 });
    settleTask(sql, {
      task_id: "b1_t0",
      status: "done",
      result_json: '{"a":1}',
      now: 2000,
    });

    let state = batchState(sql, "b1");
    expect(state.total).toBe(2);
    expect(state.settled).toBe(1);

    settleTask(sql, {
      task_id: "b1_t1",
      status: "failed",
      error: "nope",
      now: 3000,
    });
    state = batchState(sql, "b1");
    expect(state.settled).toBe(2);
    expect(state.results).toHaveLength(2);
  });

  it("scopes to one batch", () => {
    seedBatch(2, "b1");
    seedBatch(3, "b2");
    expect(batchState(sql, "b2").total).toBe(3);
  });
});

describe("inFlightCount", () => {
  it("counts only dispatched and running rows — queued work waits, it does not hold a slot", () => {
    seedBatch(3);
    // All three are queued. Nothing has been dispatched, so no slot is in use.
    expect(inFlightCount(sql)).toBe(0);

    claimSlots(sql, { cap: 100, limit: 1, now: 1500 });
    expect(inFlightCount(sql)).toBe(1);

    // 'running' occupies a slot exactly as 'dispatched' does.
    sql.exec(
      "UPDATE subagent_tasks SET status = ? WHERE task_id = ?",
      "running",
      "b1_t0",
    );
    expect(inFlightCount(sql)).toBe(1);

    settleTask(sql, { task_id: "b1_t0", status: "done", now: 2000 });
    expect(inFlightCount(sql)).toBe(0);
  });

  it("does not let a backlog larger than the cap deadlock the pump", () => {
    // The regression this whole distinction exists to prevent: if queued rows
    // counted against the cap, inserting a batch of >= cap tasks would leave
    // free = 0 and nothing would ever dispatch.
    seedBatch(10);
    expect(claimSlots(sql, { cap: 4, limit: 10, now: 1500 })).toHaveLength(4);
  });
});

describe("SQLite semaphore and settlement cost", () => {
  it("reads an indexed count instead of materializing retained history", () => {
    seedBatch(1000, "history");
    sql.exec("UPDATE subagent_tasks SET status = 'done'");
    seedBatch(10, "live");
    claimSlots(sql, { cap: 3, limit: 10, now: 1500 });
    const exec = vi.spyOn(sql, "exec");
    expect(inFlightCount(sql)).toBe(3);
    expect(exec).toHaveBeenCalledTimes(1);
    const [query, ...bindings] = exec.mock.calls[0];
    expect(query).toMatch(/COUNT\(\*\)/i);
    const plan = sql.exec(`EXPLAIN QUERY PLAN ${query}`, ...bindings).toArray();
    expect(
      plan.some((row) =>
        String(row.detail).includes("COVERING INDEX idx_subagent_status"),
      ),
    ).toBe(true);
  });

  it("claims one round in two statements, preserving FIFO with tied creation times", () => {
    seedBatch(100);
    const exec = vi.spyOn(sql, "exec");
    const tasks = claimSlots(sql, { cap: 100, limit: 100, now: 1500 });
    expect(tasks).toHaveLength(100);
    expect(tasks.map((task) => task.task_id)).toEqual(
      tasks.map((task) => task.task_id).sort(),
    );
    expect(exec).toHaveBeenCalledTimes(2);
    expect(
      tasks.every(
        (task) => task.status === "dispatched" && task.started_at === 1500,
      ),
    ).toBe(true);
  });

  it("settles by one conditional update and never overwrites any terminal state", () => {
    seedBatch(7);
    const statuses = [
      "queued",
      "dispatched",
      "running",
      "done",
      "failed",
      "timeout",
      "cancelled",
    ];
    statuses.forEach((status, i) =>
      sql.exec(
        "UPDATE subagent_tasks SET status = ? WHERE task_id = ?",
        status,
        `b1_t${i}`,
      ),
    );
    const exec = vi.spyOn(sql, "exec");
    statuses.forEach((_, i) => {
      exec.mockClear();
      expect(
        settleTask(sql, {
          task_id: `b1_t${i}`,
          status: "failed",
          error: "failure",
          now: 20_000,
        }),
      ).toBe(i < 3);
      expect(exec).toHaveBeenCalledTimes(1);
    });
  });

  it("sweeps an entire expired batch atomically while preserving other batches and future deadlines", () => {
    seedBatch(100);
    seedBatch(2, "other");
    sql.exec(
      "UPDATE subagent_tasks SET deadline_at = ? WHERE task_id = ?",
      100_000,
      "b1_t0",
    );
    settleTask(sql, {
      task_id: "b1_t1",
      status: "done",
      result_json: '{"answer":"saved"}',
      now: 2000,
    });
    const exec = vi.spyOn(sql, "exec");
    expect(sweepTimeouts(sql, { batch_id: "b1", now: 61_000 })).toBe(98);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(sweepTimeouts(sql, { batch_id: "b1", now: 61_000 })).toBe(0);
    const rows = batchState(sql, "b1").results;
    expect(rows.find((row) => row.task_id === "b1_t0")?.status).toBe("queued");
    expect(rows.find((row) => row.task_id === "b1_t1")?.result_json).toBe(
      '{"answer":"saved"}',
    );
    expect(batchState(sql, "other").settled).toBe(0);
  });
});

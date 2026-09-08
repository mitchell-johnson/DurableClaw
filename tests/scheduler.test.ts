/**
 * Pure job-queue functions backing the NanoChatAgent alarm multiplexer.
 * No DO is constructed here — these take an injected SQL runner.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createSqliteStorage } from "./helpers/sqlite";
import {
  scheduleJob,
  cancelJobs,
  dueJobs,
  nextRunAt,
  deleteJob,
} from "../src/durable-objects/assistant/scheduler";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  run_at INTEGER NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);
`;

let sql: ReturnType<typeof createSqliteStorage>;
beforeEach(() => {
  sql = createSqliteStorage();
  sql.exec(SCHEMA);
});

describe("scheduleJob", () => {
  it("stores a job with its payload serialized", () => {
    scheduleJob(sql, {
      job_id: "j1",
      kind: "wake",
      run_at: 500,
      payload: { batch_id: "b1" },
      now: 100,
    });
    const rows = sql.exec("SELECT * FROM scheduled_jobs").toArray() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("wake");
    expect(JSON.parse(rows[0].payload_json)).toEqual({ batch_id: "b1" });
  });

  it("replaces an existing job with the same id rather than duplicating it", () => {
    scheduleJob(sql, { job_id: "j1", kind: "wake", run_at: 500, now: 100 });
    // A different `now` on the second call is deliberate: reusing 100 here
    // couldn't distinguish "created_at was preserved" from "created_at was
    // overwritten with a coincidentally equal value", so it wouldn't prove
    // upsert semantics.
    scheduleJob(sql, { job_id: "j1", kind: "wake", run_at: 900, now: 250 });
    const rows = sql.exec("SELECT * FROM scheduled_jobs").toArray() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].run_at).toBe(900);
    expect(rows[0].created_at).toBe(100);
  });

  it("stores a null payload when none is given", () => {
    scheduleJob(sql, {
      job_id: "j1",
      kind: "summarize",
      run_at: 500,
      now: 100,
    });
    const rows = sql.exec("SELECT * FROM scheduled_jobs").toArray() as any[];
    expect(rows[0].payload_json).toBeNull();
  });
});

describe("dueJobs", () => {
  it("returns only jobs at or before now, earliest first", () => {
    scheduleJob(sql, { job_id: "late", kind: "wake", run_at: 900, now: 0 });
    scheduleJob(sql, { job_id: "early", kind: "dream", run_at: 100, now: 0 });
    scheduleJob(sql, {
      job_id: "exact",
      kind: "summarize",
      run_at: 500,
      now: 0,
    });

    const due = dueJobs(sql, 500, 10);

    expect(due.map((j) => j.job_id)).toEqual(["early", "exact"]);
  });

  it("respects the limit so one alarm pass stays bounded", () => {
    for (let i = 0; i < 10; i++) {
      scheduleJob(sql, { job_id: `j${i}`, kind: "wake", run_at: i, now: 0 });
    }
    expect(dueJobs(sql, 1000, 3)).toHaveLength(3);
  });

  it("returns an empty array when nothing is due", () => {
    scheduleJob(sql, { job_id: "j1", kind: "wake", run_at: 900, now: 0 });
    expect(dueJobs(sql, 500, 10)).toEqual([]);
  });
});

describe("nextRunAt", () => {
  it("returns the earliest run_at across all jobs", () => {
    scheduleJob(sql, { job_id: "a", kind: "wake", run_at: 900, now: 0 });
    scheduleJob(sql, { job_id: "b", kind: "dream", run_at: 300, now: 0 });
    expect(nextRunAt(sql)).toBe(300);
  });

  it("returns null when the queue is empty", () => {
    expect(nextRunAt(sql)).toBeNull();
  });
});

describe("cancelJobs", () => {
  it("removes every job of one kind and reports the count", () => {
    scheduleJob(sql, { job_id: "w1", kind: "wake", run_at: 100, now: 0 });
    scheduleJob(sql, { job_id: "w2", kind: "wake", run_at: 200, now: 0 });
    scheduleJob(sql, { job_id: "d1", kind: "dream", run_at: 300, now: 0 });

    expect(cancelJobs(sql, { kind: "wake" })).toBe(2);
    expect(sql.exec("SELECT * FROM scheduled_jobs").toArray()).toHaveLength(1);
  });

  it("removes a single job by id", () => {
    scheduleJob(sql, { job_id: "w1", kind: "wake", run_at: 100, now: 0 });
    expect(cancelJobs(sql, { job_id: "w1" })).toBe(1);
    expect(sql.exec("SELECT * FROM scheduled_jobs").toArray()).toHaveLength(0);
  });
});

describe("deleteJob", () => {
  it("removes the named job and leaves the rest", () => {
    scheduleJob(sql, { job_id: "a", kind: "wake", run_at: 100, now: 0 });
    scheduleJob(sql, { job_id: "b", kind: "wake", run_at: 200, now: 0 });
    deleteJob(sql, "a");
    const rows = sql
      .exec("SELECT job_id FROM scheduled_jobs")
      .toArray() as any[];
    expect(rows.map((r) => r.job_id)).toEqual(["b"]);
  });
});

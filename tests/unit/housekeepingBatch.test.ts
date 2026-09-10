import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteStorage } from "../helpers/sqlite";
import {
  HOUSEKEEPING_SCHEMA_SQL,
  enqueueHousekeepingTask,
  runHousekeepingTasks,
  type HousekeepingTask,
} from "../../src/durable-objects/assistant/housekeepingBatch";
import {
  createBatch,
  getBatch,
  type BatchEnv,
} from "../../src/utils/openrouterBatch";

vi.mock("../../src/utils/openrouterBatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/openrouterBatch")>()),
  createBatch: vi.fn(),
  getBatch: vi.fn(),
  isBatchTerminal: (s: string) =>
    ["completed", "failed", "expired", "cancelled"].includes(s),
  batchResultText: (b: any, id: string) =>
    b.results?.find((r: any) => r.custom_id === id)?.text ?? null,
}));

afterEach(() => vi.unstubAllGlobals());

function setup(env: Partial<BatchEnv> = {}) {
  const sql = createSqliteStorage();
  sql.exec(HOUSEKEEPING_SCHEMA_SQL);
  const apply = vi.fn(async () => true);
  const valid = vi.fn(() => true);
  const discard = vi.fn();
  const arm = vi.fn(async () => {});
  const run = (now: number) =>
    runHousekeepingTasks({
      sql,
      env: {
        OPENROUTER_API_KEY: "test",
        BATCH_MODEL: "example/test:batch",
        ...env,
      },
      now,
      apply,
      valid,
      discard,
      arm,
    });
  const queue = (key = "title:one") =>
    enqueueHousekeepingTask(sql, {
      key,
      kind: "title",
      conversationId: "c",
      payload: { source: "message" },
      request: { system: "Title", prompt: "Conversation" },
      now: 1,
    });
  const rows = () =>
    sql
      .exec("SELECT * FROM housekeeping_tasks ORDER BY created_at, task_id")
      .toArray() as unknown as HousekeepingTask[];
  return { sql, apply, valid, discard, arm, run, queue, rows };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createBatch).mockResolvedValue({
    id: "batch-one",
    status: "validating",
    results: null,
  });
  vi.mocked(getBatch).mockResolvedValue({
    id: "batch-one",
    status: "in_progress",
    results: null,
  });
});

describe("durable housekeeping batch lifecycle", () => {
  it("persists pinned inference intent before dispatch and reuses ready output after an application failure", async () => {
    const t = setup({
      OPENROUTER_PROVIDER: "google-ai-studio",
      BATCH_MODEL: "google/gemini-3.8-flash",
      BACKGROUND_REASONING_EFFORT: "high",
    });
    const id = t.queue();
    const fetcher = vi.fn(async () => {
      expect(t.arm).toHaveBeenCalled();
      expect(t.rows()).toEqual([
        expect.objectContaining({
          task_id: id,
          attempts: 1,
          next_run_at: 300_001,
        }),
      ]);
      return Response.json({
        choices: [
          { finish_reason: "stop", message: { content: "Saved result" } },
        ],
      });
    });
    vi.stubGlobal("fetch", fetcher);
    t.apply.mockImplementationOnce(async () => {
      expect(t.rows()).toEqual([
        expect.objectContaining({
          state: "ready",
          result_text: "Saved result",
        }),
      ]);
      throw new Error("Local write interrupted");
    });
    await t.run(1);
    expect(t.rows()).toEqual([
      expect.objectContaining({
        state: "ready",
        result_text: "Saved result",
        batch_id: null,
      }),
    ]);
    await t.run(600_001);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(t.rows()).toHaveLength(0);
    expect(t.apply).toHaveBeenLastCalledWith(
      expect.objectContaining({ task_id: id }),
      "Saved result",
      expect.any(Function),
    );
    expect(createBatch).not.toHaveBeenCalled();
  });

  it("bounds pinned inference to one task per pass and leaves the rest due without spending attempts", async () => {
    const t = setup({ OPENROUTER_PROVIDER: "google-ai-studio" });
    for (let i = 0; i < 25; i++) t.queue(`pinned:${i}`);
    const fetcher = vi.fn(async () =>
      Response.json({
        choices: [{ finish_reason: "stop", message: { content: "Done" } }],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    await t.run(1);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(t.rows()).toHaveLength(24);
    expect(
      t
        .rows()
        .every(
          (row) =>
            row.state === "queued" &&
            row.attempts === 0 &&
            row.next_run_at === 1,
        ),
    ).toBe(true);
    expect(createBatch).not.toHaveBeenCalled();
  });

  it("does not recreate or apply a pinned task deleted while the model request is in flight", async () => {
    const t = setup({ OPENROUTER_PROVIDER: "google-ai-studio" });
    const id = t.queue();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        t.sql.exec("DELETE FROM housekeeping_tasks WHERE task_id = ?", id);
        return Response.json({
          choices: [
            { finish_reason: "stop", message: { content: "Deleted source" } },
          ],
        });
      }),
    );
    await t.run(1);
    expect(t.rows()).toHaveLength(0);
    expect(t.apply).not.toHaveBeenCalled();
  });

  it("recovers an interrupted pinned attempt and caps inference retries before the safe fallback", async () => {
    const t = setup({ OPENROUTER_PROVIDER: "google-ai-studio" });
    const id = t.queue();
    // Simulate eviction after persisting intent but before saving a response.
    t.sql.exec(
      "UPDATE housekeeping_tasks SET attempts = 1, next_run_at = 300001 WHERE task_id = ?",
      id,
    );
    const fetcher = vi.fn(async () => {
      throw new Error("Transport interrupted");
    });
    vi.stubGlobal("fetch", fetcher);
    await t.run(1);
    expect(fetcher).not.toHaveBeenCalled();
    await t.run(300_001);
    await t.run(600_001);
    await t.run(900_001);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(t.apply).toHaveBeenCalledWith(
      expect.anything(),
      null,
      expect.any(Function),
    );
    expect(t.rows()).toHaveLength(0);
  });

  it("deduplicates tasks and submits them together without applying pending results", async () => {
    const t = setup();
    const id = t.queue();
    expect(t.queue()).toBe(id);
    t.queue("raw:two");
    await t.run(1);
    expect(createBatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createBatch).mock.calls[0][1]).toHaveLength(2);
    expect(t.rows().every((r) => r.batch_id === "batch-one")).toBe(true);
    expect(t.apply).not.toHaveBeenCalled();
    expect(t.arm).toHaveBeenCalled();
  });

  it("polls a persisted batch after restart and applies out-of-order results by task ID once", async () => {
    const t = setup();
    const one = t.queue();
    const two = t.queue("title:two");
    await t.run(1);
    vi.mocked(getBatch).mockResolvedValue({
      id: "batch-one",
      status: "completed",
      results: [
        { custom_id: two, text: "Second" },
        { custom_id: one, text: "First" },
      ],
    } as any);
    await t.run(600_001);
    expect(getBatch).toHaveBeenCalledTimes(1);
    expect(t.apply).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: one }),
      "First",
      expect.any(Function),
    );
    expect(t.apply).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: two }),
      "Second",
      expect.any(Function),
    );
    expect(t.rows()).toHaveLength(0);
    await t.run(1_200_001);
    expect(t.apply).toHaveBeenCalledTimes(2);
    expect(createBatch).toHaveBeenCalledTimes(1);
  });

  it("keeps the provider batch ID across poll failures and retries local writes without resubmission", async () => {
    const t = setup();
    const id = t.queue();
    await t.run(1);
    vi.mocked(getBatch).mockRejectedValueOnce(new Error("unavailable"));
    await t.run(600_001);
    expect(t.rows()[0].batch_id).toBe("batch-one");
    vi.mocked(getBatch).mockResolvedValue({
      id: "batch-one",
      status: "completed",
      results: [{ custom_id: id, text: "Ready" }],
    } as any);
    t.apply.mockResolvedValueOnce(false);
    await t.run(1_200_001);
    expect(t.rows()[0].result_text).toBe("Ready");
    await t.run(1_800_001);
    expect(t.rows()).toHaveLength(0);
    expect(createBatch).toHaveBeenCalledTimes(1);
    expect(getBatch).toHaveBeenCalledTimes(2);
  });

  it("discards a deleted or disabled task even when deletion happens during provider I/O", async () => {
    const t = setup();
    const id = t.queue();
    await t.run(1);
    vi.mocked(getBatch).mockImplementationOnce(async () => {
      t.sql.exec("DELETE FROM housekeeping_tasks WHERE task_id = ?", id);
      return {
        id: "batch-one",
        status: "completed",
        results: [{ custom_id: id, text: "Stale" }],
      } as any;
    });
    await t.run(600_001);
    expect(t.apply).not.toHaveBeenCalled();
    t.queue("raw:disabled");
    t.valid.mockReturnValue(false);
    await t.run(1_200_001);
    expect(createBatch).toHaveBeenCalledTimes(1);
    expect(t.rows()).toHaveLength(0);
  });

  it("retries submissions a bounded number of times then invokes the non-model fallback", async () => {
    const t = setup();
    t.queue();
    vi.mocked(createBatch).mockRejectedValue(new Error("down"));
    await t.run(1);
    await t.run(600_001);
    await t.run(1_200_001);
    await t.run(1_800_001);
    expect(createBatch).toHaveBeenCalledTimes(3);
    expect(t.apply).toHaveBeenCalledWith(
      expect.anything(),
      null,
      expect.any(Function),
    );
    expect(t.rows()).toHaveLength(0);
  });

  it.each(["failed", "cancelled", "expired"])(
    "handles terminal %s without destructive summary application",
    async (status) => {
      const t = setup();
      t.queue();
      await t.run(1);
      vi.mocked(getBatch).mockResolvedValue({
        id: "batch-one",
        status,
        results: null,
      } as any);
      await t.run(600_001);
      expect(t.apply).toHaveBeenCalledWith(
        expect.anything(),
        null,
        expect.any(Function),
      );
      expect(t.rows()).toHaveLength(0);
    },
  );

  it("bounds submissions and expires stuck batches", async () => {
    const t = setup();
    for (let i = 0; i < 25; i++) t.queue(`title:${i}`);
    await t.run(1);
    expect(vi.mocked(createBatch).mock.calls[0][1]).toHaveLength(20);
    await t.run(49 * 60 * 60 * 1000);
    expect(t.apply.mock.calls.every((args: any[]) => args[1] === null)).toBe(
      true,
    );
    expect(t.rows()).toHaveLength(5);
    await t.run(50 * 60 * 60 * 1000);
    expect(t.rows()).toHaveLength(0);
  });

  it("eventually polls every provider batch when the first five remain in progress", async () => {
    const t = setup();
    for (let i = 0; i < 7; i++) {
      const id = t.queue(`title:${i}`);
      t.sql.exec(
        "UPDATE housekeeping_tasks SET state = 'submitted', batch_id = ? WHERE task_id = ?",
        `batch-${i}`,
        id,
      );
    }
    vi.mocked(getBatch).mockImplementation(async (_env, id) => ({
      id,
      status: "in_progress",
      results: null,
    }));
    await t.run(1);
    await t.run(2);
    expect(
      new Set(vi.mocked(getBatch).mock.calls.map((call) => call[1])).size,
    ).toBe(7);
  });

  it("splits a Unicode-heavy backlog by actual encoded request bytes and drains it without submission retries", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/utils/openrouterBatch")
    >("../../src/utils/openrouterBatch");
    vi.mocked(createBatch).mockImplementation(actual.createBatch);
    const submitted = new Map<string, string[]>();
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = init.body as string;
        bodies.push(body);
        const decoded = JSON.parse(body);
        const id = `batch-${bodies.length}`;
        submitted.set(
          id,
          decoded.requests.map(
            (request: { custom_id: string }) => request.custom_id,
          ),
        );
        return new Response(
          JSON.stringify({ id, status: "validating", results: null }),
          { status: 202 },
        );
      }),
    );
    vi.mocked(getBatch).mockImplementation(async (_env, id) => ({
      id,
      status: "completed",
      results: submitted.get(id)!.map((custom_id) => ({
        custom_id,
        response: null,
        error: null,
        text: "Consolidated",
      })),
    }));
    const t = setup();
    for (let i = 0; i < 25; i++)
      enqueueHousekeepingTask(t.sql, {
        key: `summary:${i}`,
        kind: "summary",
        conversationId: `conversation-${i}`,
        payload: { source: "messages" },
        request: {
          system: "Summarize",
          prompt: "漢".repeat(60_000),
          maxTokens: 1000,
        },
        now: 1,
      });

    await t.run(1);
    expect(bodies).toHaveLength(1);
    const firstSize = JSON.parse(bodies[0]).requests.length;
    expect(firstSize).toBeGreaterThan(0);
    expect(firstSize).toBeLessThan(20);
    expect(
      t
        .rows()
        .filter((task) => task.state === "queued")
        .every((task) => task.attempts === 0),
    ).toBe(true);
    await t.run(2);
    await t.run(3);
    expect(
      t
        .rows()
        .every((task) => task.state === "submitted" && task.attempts === 1),
    ).toBe(true);
    expect([...submitted.values()].flat()).toHaveLength(25);
    expect(new Set([...submitted.values()].flat()).size).toBe(25);
    for (const body of bodies) {
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
        2 * 1024 * 1024,
      );
      expect(Object.keys(JSON.parse(body))).toEqual([
        "endpoint",
        "model",
        "requests",
      ]);
    }
    await t.run(600_001);
    await t.run(900_001);
    expect(t.rows()).toHaveLength(0);
    expect(t.apply).toHaveBeenCalledTimes(25);
    expect(
      t.apply.mock.calls.every((args: unknown[]) => args[1] === "Consolidated"),
    ).toBe(true);
    expect(createBatch).toHaveBeenCalledTimes(bodies.length);
  });

  it("falls back only the individually oversized task and submits the next valid task without spending retries", async () => {
    const t = setup();
    const huge = enqueueHousekeepingTask(t.sql, {
      key: "summary:huge",
      kind: "summary",
      payload: {},
      request: { system: "Summarize", prompt: "漢".repeat(800_000) },
      now: 0,
    });
    const valid = t.queue();
    await t.run(1);
    expect(createBatch).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(createBatch)
        .mock.calls[0][1].map((request) => request.customId),
    ).toEqual([valid]);
    expect(t.apply).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: huge, attempts: 0 }),
      null,
      expect.any(Function),
    );
    expect(t.rows()).toEqual([
      expect.objectContaining({
        task_id: valid,
        state: "submitted",
        attempts: 1,
      }),
    ]);
  });

  it.each(["false", "throw"])(
    "retires expired tasks and frees admission slots even when the final fallback returns %s",
    async (failure) => {
      const t = setup();
      for (let i = 0; i < 500; i++) t.queue(`raw:${i}`);
      expect(t.queue("new-task")).toBeNull();
      t.sql.exec(
        "UPDATE housekeeping_tasks SET kind = 'raw', state = 'ready', result_text = 'Saved output', batch_id = 'batch-existing'",
      );
      if (failure === "false") t.apply.mockResolvedValue(false);
      else t.apply.mockRejectedValue(new Error("persistent vector outage"));
      const expiresAt = 1 + 48 * 60 * 60 * 1000;

      await t.run(expiresAt - 1);
      expect(t.rows()).toHaveLength(500);
      expect(t.discard).not.toHaveBeenCalled();
      expect(
        t
          .rows()
          .every(
            (row) =>
              row.batch_id === "batch-existing" &&
              row.result_text === "Saved output",
          ),
      ).toBe(true);
      t.apply.mockClear();
      await t.run(expiresAt);
      expect(t.apply).toHaveBeenCalledTimes(20);
      expect(
        t.apply.mock.calls.every((args: unknown[]) => args[1] === null),
      ).toBe(true);
      expect(t.discard).toHaveBeenCalledTimes(20);
      expect(t.rows()).toHaveLength(480);
      expect(t.queue("new-task")).toEqual(expect.any(String));
    },
  );

  it("keeps a pending receipt until the exact age deadline without scheduling a retry beyond expiry", async () => {
    const t = setup();
    const id = t.queue("raw:pending");
    t.sql.exec(
      "UPDATE housekeeping_tasks SET kind = 'raw', state = 'submitted', batch_id = 'batch-pending' WHERE task_id = ?",
      id,
    );
    t.apply.mockResolvedValue(false);
    const expiresAt = 1 + 48 * 60 * 60 * 1000;
    await t.run(expiresAt - 1);
    expect(t.rows()).toEqual([
      expect.objectContaining({
        task_id: id,
        state: "submitted",
        batch_id: "batch-pending",
        next_run_at: expiresAt,
      }),
    ]);
    expect(t.arm).toHaveBeenLastCalledWith(expiresAt);
    expect(t.apply).not.toHaveBeenCalled();
    await t.run(expiresAt);
    expect(getBatch).toHaveBeenCalledOnce();
    expect(createBatch).not.toHaveBeenCalled();
    expect(t.apply).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: id }),
      null,
      expect.any(Function),
    );
    expect(t.discard).toHaveBeenCalledOnce();
    expect(t.rows()).toHaveLength(0);
  });

  it("bounds full payload loading for a large queued backlog while keeping the remaining work due", async () => {
    const t = setup();
    for (let i = 0; i < 500; i++) t.queue(`large:${i}`);
    t.sql.exec(
      "UPDATE housekeeping_tasks SET payload_json = ?, request_json = ?",
      JSON.stringify({ assistant_text: "漢".repeat(60_000) }),
      JSON.stringify({ system: "Compress", prompt: "漢".repeat(60_000) }),
    );
    const originalExec = t.sql.exec.bind(t.sql);
    const readSizes: number[] = [];
    vi.spyOn(t.sql, "exec").mockImplementation((query, ...bindings) => {
      const result = originalExec(query, ...bindings);
      const rows = result.toArray();
      if (
        rows.some(
          (row) =>
            "payload_json" in row ||
            "request_json" in row ||
            "result_text" in row,
        )
      )
        readSizes.push(rows.length);
      return result;
    });
    await t.run(1);
    expect(readSizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(
      20,
    );
    expect(createBatch).toHaveBeenCalledOnce();
    const tasks = originalExec(
      "SELECT state, attempts, next_run_at FROM housekeeping_tasks",
    ).toArray();
    expect(
      tasks
        .filter((task) => task.state === "queued")
        .every((task) => task.attempts === 0 && task.next_run_at === 1),
    ).toBe(true);
  });

  it("collects every member of selected receipts, including future-due siblings, without loading unselected payloads", async () => {
    const t = setup();
    const receipts = new Map<string, string[]>();
    for (let batch = 0; batch < 7; batch++) {
      const ids: string[] = [];
      for (let task = 0; task < 20; task++) {
        const id = t.queue(`batch:${batch}:task:${task}`)!;
        ids.push(id);
        t.sql.exec(
          "UPDATE housekeeping_tasks SET state = 'submitted', batch_id = ?, next_run_at = ? WHERE task_id = ?",
          `receipt-${batch}`,
          task === 0 ? 1 : 60_000,
          id,
        );
      }
      receipts.set(`receipt-${batch}`, ids);
    }
    vi.mocked(getBatch).mockImplementation(async (_env, id) => ({
      id,
      status: "completed",
      results: receipts.get(id)!.map((custom_id) => ({
        custom_id,
        response: null,
        error: null,
        text: "Collected",
      })),
    }));
    const originalExec = t.sql.exec.bind(t.sql);
    const fullReadIds: string[] = [];
    vi.spyOn(t.sql, "exec").mockImplementation((query, ...bindings) => {
      const result = originalExec(query, ...bindings);
      for (const row of result.toArray())
        if ("payload_json" in row) fullReadIds.push(String(row.task_id));
      return result;
    });
    await t.run(1);
    expect(getBatch).toHaveBeenCalledTimes(5);
    expect(t.apply).toHaveBeenCalledTimes(20);
    expect(fullReadIds).toHaveLength(20);
    const unselected = originalExec(
      "SELECT task_id FROM housekeeping_tasks WHERE state = 'submitted'",
    ).toArray();
    expect(unselected).toHaveLength(40);
    expect(
      fullReadIds.every((id) => !unselected.some((row) => row.task_id === id)),
    ).toBe(true);
    await t.run(2);
    expect(
      new Set(vi.mocked(getBatch).mock.calls.map((call) => call[1])).size,
    ).toBe(7);
    expect(
      originalExec(
        "SELECT task_id FROM housekeeping_tasks WHERE state = 'submitted'",
      ).toArray(),
    ).toHaveLength(0);
  });
});

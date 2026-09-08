import { createMemoryBucket } from "../helpers/memoryBucket";
import { buildNamespace } from "../../src/utils/memoryClient";
import { describe, expect, it, vi } from "vitest";
import { createSqliteStorage } from "../helpers/sqlite";
import {
  MEMORY_INDEX_SCHEMA_SQL,
  indexMemory,
  prepareDream,
  buildDreamRequest,
  applyDreamResult,
  isDreamValid,
  filterWarmMemoryIds,
  planMemoryDeletion,
  removeIndexedMemories,
  hydrateLegacyMemoryIndex,
  cleanupDreamResult,
  markMemoriesForDeletion,
  cleanupPendingMemoryDeletions,
  beginForgetAll,
} from "../../src/durable-objects/assistant/dreaming";

const NOW = 2_000_000_000_000;
function fixture() {
  const sql = createSqliteStorage();
  sql.exec(MEMORY_INDEX_SCHEMA_SQL);
  sql.exec("CREATE TABLE memory_links (vector_id TEXT)");
  const env = {
    WORKSPACE: createMemoryBucket() as any,
    AI: {
      run: vi.fn().mockResolvedValue({ data: [new Array(1024).fill(0.1)] }),
    },
    MEMORY_INDEX: {
      upsert: vi.fn().mockResolvedValue({ count: 1 }),
      deleteByIds: vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as any;
  function seed(
    id: string,
    type: "raw" | "tool_call" | "summary" | "memory" | "insight" = "raw",
    created_at = NOW - 1000,
  ) {
    indexMemory(sql, {
      vector_id: id,
      type,
      content: `Memory ${id}`,
      conversation_id: "c1",
      created_at,
    });
  }
  const row = (id: string) =>
    sql.exec("SELECT * FROM memory_index WHERE vector_id = ?", id).toArray()[0];
  return { sql, env, seed, row };
}
const result = (source_ids = ["a"]) =>
  JSON.stringify({
    insights: [{ content: "Prefers concise summaries.", source_ids }],
  });
function args(f: ReturnType<typeof fixture>, text = result()) {
  return {
    ...f,
    user_id: "u",
    tenant_binding: "T",
    taskId: "task",
    payload: prepareDream(f.sql, NOW)!,
    text,
    stillValid: () => true,
  };
}

describe("dream window and index", () => {
  it("backfills a bounded legacy memory slice with namespace, age and type checks", async () => {
    const f = fixture();
    f.env.MEMORY_INDEX.query = vi.fn().mockResolvedValue({
      matches: [
        {
          id: "legacy",
          score: 1,
          metadata: {
            type: "summary",
            user_namespace: buildNamespace("u", "T"),
            content_preview: "Previously prefers brief updates",
            created_at: NOW - 100,
          },
        },
        {
          id: "old",
          score: 1,
          metadata: {
            type: "raw",
            user_namespace: buildNamespace("u", "T"),
            content_preview: "old",
            created_at: 1,
          },
        },
        {
          id: "foreign",
          score: 1,
          metadata: {
            type: "raw",
            user_namespace: buildNamespace("other", "T"),
            content_preview: "secret",
            created_at: NOW - 100,
          },
        },
        {
          id: "insight",
          score: 1,
          metadata: {
            type: "insight",
            user_namespace: buildNamespace("u", "T"),
            content_preview: "staged",
            created_at: NOW - 100,
          },
        },
      ],
    });
    for (const match of (await f.env.MEMORY_INDEX.query()).matches) {
      await f.env.WORKSPACE.put(
        `memory/namespaces/${buildNamespace("u", "T")}/${match.id}.json`,
        JSON.stringify({ ...match.metadata, vector_id: match.id }),
      );
    }
    await hydrateLegacyMemoryIndex({
      ...f,
      user_id: "u",
      tenant_binding: "T",
      now: NOW,
    });
    expect(f.row("legacy")).toMatchObject({
      type: "summary",
      content: "Previously prefers brief updates",
    });
    expect(f.row("old")).toBeUndefined();
    expect(f.row("foreign")).toBeUndefined();
    expect(f.row("insight")).toBeUndefined();
    expect(f.env.WORKSPACE.objects.size).toBe(4);
  });

  it("selects only undreamt warm observations in the window, including compacted summaries", () => {
    const f = fixture();
    f.seed("a");
    f.seed("b", "tool_call");
    f.seed("s", "summary");
    f.seed("explicit", "memory");
    f.seed("insight", "insight");
    f.seed("old", "raw", NOW - 49 * 3600_000);
    f.seed("future", "raw", NOW + 1);
    f.seed("cold");
    f.seed("done");
    f.sql.exec(
      "UPDATE memory_index SET tier = 'cold' WHERE vector_id = ?",
      "cold",
    );
    f.sql.exec(
      "UPDATE memory_index SET dreamt_at = ? WHERE vector_id = ?",
      NOW,
      "done",
    );
    const payload = prepareDream(f.sql, NOW)!;
    expect(payload.memories.map((m) => m.vector_id)).toEqual(["a", "b", "s"]);
    expect(buildDreamRequest(payload).prompt).toContain("Memory s");
    expect(isDreamValid(f.sql, payload)).toBe(true);
    f.sql.exec("DELETE FROM memory_index WHERE vector_id = ?", "s");
    expect(isDreamValid(f.sql, payload)).toBe(false);
  });

  it("bounds payload size and never revives cold memories on duplicate index writes", () => {
    const f = fixture();
    for (let i = 0; i < 200; i++)
      indexMemory(f.sql, {
        vector_id: `m-${i}`,
        type: "raw",
        content: "x".repeat(10000),
        created_at: NOW - i,
      });
    const payload = prepareDream(f.sql, NOW)!;
    expect(payload.memories.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(payload).length).toBeLessThan(70_000);
    f.sql.exec(
      "UPDATE memory_index SET tier = 'cold', dreamt_at = ? WHERE vector_id = ?",
      NOW,
      "m-1",
    );
    indexMemory(f.sql, { vector_id: "m-1", type: "raw", content: "new text" });
    expect(f.row("m-1")).toMatchObject({ tier: "cold", dreamt_at: NOW });
  });
});

describe("dream completion", () => {
  it("recreates deletion markers when an upsert lands after forget-all already finished", async () => {
    const f = fixture();
    f.seed("a");
    const vectors = new Set(["a"]);
    let failCompensation = false;
    f.env.MEMORY_INDEX.query = vi.fn(async () => ({
      matches: [...vectors].map((id) => ({ id })),
    }));
    f.env.MEMORY_INDEX.deleteByIds.mockImplementation(async (ids: string[]) => {
      if (failCompensation) throw new Error("offline");
      for (const id of ids) vectors.delete(id);
      return { count: ids.length };
    });
    f.env.MEMORY_INDEX.upsert.mockImplementation(
      async (rows: Array<{ id: string }>) => {
        beginForgetAll({ ...f, user_id: "u", tenant_binding: "T" });
        expect(await cleanupPendingMemoryDeletions(f)).toBe(true);
        expect(
          f.sql.exec("SELECT * FROM memory_forget_state").toArray(),
        ).toEqual([]);
        for (const row of rows) vectors.add(row.id);
        failCompensation = true;
        return { count: rows.length };
      },
    );
    const onDeletionPending = vi.fn();
    await expect(
      applyDreamResult({ ...args(f), onDeletionPending }),
    ).rejects.toThrow("offline");
    expect(vectors.has("task:0")).toBe(true);
    expect(filterWarmMemoryIds(f.sql, ["task:0"])).toEqual([]);
    expect(onDeletionPending).toHaveBeenCalled();
    failCompensation = false;
    expect(await cleanupPendingMemoryDeletions(f)).toBe(true);
    expect([...vectors]).toEqual([]);
  });

  it("writes insights first, marks only cited sources cold, and never deletes original vectors", async () => {
    const f = fixture();
    f.seed("a");
    f.seed("b");
    f.env.MEMORY_INDEX.upsert.mockImplementation(async () => {
      expect(f.row("a")).toMatchObject({ tier: "warm", dreamt_at: null });
      return { count: 1 };
    });
    expect(await applyDreamResult(args(f))).toBe(true);
    expect(f.row("a")).toMatchObject({ tier: "cold", dreamt_at: NOW });
    expect(f.row("b")).toMatchObject({ tier: "warm", dreamt_at: NOW });
    expect(f.row("task:0")).toMatchObject({ type: "insight", tier: "warm" });
    expect(
      f.sql.exec("SELECT * FROM memory_insight_sources").toArray(),
    ).toEqual([{ insight_id: "task:0", source_id: "a" }]);
    expect(f.env.MEMORY_INDEX.deleteByIds).not.toHaveBeenCalled();
  });

  it.each([
    "not json",
    '{"insights":[{"content":"guess","source_ids":["other"]}]}',
    '{"insights":[{"content":"guess","source_ids":[]}]}',
  ])("rejects malformed or ungrounded output: %s", async (text) => {
    const f = fixture();
    f.seed("a");
    await expect(applyDreamResult(args(f, text))).rejects.toThrow();
    expect(f.row("a")).toMatchObject({ tier: "warm", dreamt_at: null });
    expect(f.env.MEMORY_INDEX.upsert).not.toHaveBeenCalled();
  });

  it("marks empty dreams processed without changing tiers", async () => {
    const f = fixture();
    f.seed("a");
    await applyDreamResult(args(f, '{"insights":[]}'));
    expect(f.row("a")).toMatchObject({ tier: "warm", dreamt_at: NOW });
    expect(prepareDream(f.sql, NOW)).toBeNull();
    expect(f.env.MEMORY_INDEX.upsert).not.toHaveBeenCalled();
  });

  it("reapplying a completed result preserves committed insights and tiers", async () => {
    const f = fixture();
    f.seed("a");
    const input = args(f);
    await applyDreamResult(input);
    await applyDreamResult(input);
    expect(f.row("task:0")).toMatchObject({ tier: "warm", type: "insight" });
    expect(f.row("a")).toMatchObject({ tier: "cold" });
    expect(f.env.MEMORY_INDEX.deleteByIds).not.toHaveBeenCalled();
  });

  it("leaves originals unchanged on persistence failure and retries the same IDs", async () => {
    const f = fixture();
    f.seed("a");
    const input = args(f);
    f.env.MEMORY_INDEX.upsert.mockRejectedValueOnce(new Error("offline"));
    expect(await applyDreamResult(input)).toBe(false);
    expect(f.row("a")).toMatchObject({ tier: "warm", dreamt_at: null });
    expect(await applyDreamResult(input)).toBe(true);
    expect(f.row("task:0")).toMatchObject({ type: "insight" });
  });

  it("cleans up writes when disabled during external IO", async () => {
    const f = fixture();
    f.seed("a");
    let valid = true;
    f.env.MEMORY_INDEX.upsert.mockImplementation(async () => {
      valid = false;
      return { count: 1 };
    });
    await applyDreamResult({ ...args(f), stillValid: () => valid });
    expect(f.env.MEMORY_INDEX.deleteByIds).toHaveBeenCalledWith(["task:0"]);
    expect(f.row("task:0")).toBeUndefined();
    expect(f.row("a")).toMatchObject({ tier: "warm", dreamt_at: null });
  });

  it("hides a partially persisted dream until every insight succeeds on retry", async () => {
    const f = fixture();
    f.seed("a");
    f.seed("b");
    const input = args(
      f,
      JSON.stringify({
        insights: [
          { content: "Prefers concise summaries.", source_ids: ["a"] },
          {
            content: "Usually searches archived documents.",
            source_ids: ["b"],
          },
        ],
      }),
    );
    f.env.MEMORY_INDEX.upsert
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error("second upsert failed"));
    expect(await applyDreamResult(input)).toBe(false);
    expect(filterWarmMemoryIds(f.sql, ["a", "b", "task:0", "task:1"])).toEqual([
      "a",
      "b",
    ]);
    expect(
      f.sql.exec("SELECT * FROM memory_insight_sources").toArray(),
    ).toEqual([]);
    expect(await applyDreamResult(input)).toBe(true);
    expect(filterWarmMemoryIds(f.sql, ["a", "b", "task:0", "task:1"])).toEqual([
      "task:0",
      "task:1",
    ]);
    expect(
      f.sql.exec("SELECT * FROM memory_insight_sources").toArray(),
    ).toHaveLength(2);
  });

  it("never upserts an insight when its source disappears during embedding", async () => {
    const f = fixture();
    f.seed("a");
    const input = args(f);
    f.env.AI.run.mockImplementation(async () => {
      f.sql.exec("DELETE FROM memory_index WHERE vector_id = ?", "a");
      return { data: [new Array(1024).fill(0.1)] };
    });
    await applyDreamResult(input);
    expect(f.env.MEMORY_INDEX.upsert).not.toHaveBeenCalled();
    expect(f.row("task:0")).toBeUndefined();
  });
});

describe("reversibility and tiers", () => {
  it("blocks unknown recall before and after forgetting while preserving new indexed writes", async () => {
    const f = fixture();
    f.seed("a");
    const operation = beginForgetAll({
      sql: f.sql,
      user_id: "u",
      tenant_binding: "T",
    });
    f.seed("new");
    expect(
      beginForgetAll({ sql: f.sql, user_id: "u", tenant_binding: "T" }),
    ).toBe(operation);
    expect(filterWarmMemoryIds(f.sql, ["a", "new", "legacy"])).toEqual(["new"]);
    f.env.MEMORY_INDEX.query = vi.fn().mockResolvedValue({
      matches: [
        {
          id: "new",
          score: 1,
          metadata: { user_namespace: buildNamespace("u", "T") },
        },
        {
          id: "legacy",
          score: 1,
          metadata: { user_namespace: buildNamespace("u", "T") },
        },
      ],
    });
    await f.env.WORKSPACE.put(
      `memory/namespaces/${buildNamespace("u", "T")}/legacy.json`,
      JSON.stringify({
        vector_id: "legacy",
        user_namespace: buildNamespace("u", "T"),
      }),
    );
    await hydrateLegacyMemoryIndex({ ...f, user_id: "u", tenant_binding: "T" });
    expect(f.env.MEMORY_INDEX.query).not.toHaveBeenCalled();
    expect(await cleanupPendingMemoryDeletions(f)).toBe(true);
    expect(f.env.MEMORY_INDEX.deleteByIds).toHaveBeenCalledWith([
      "a",
      "legacy",
    ]);
    expect(f.row("new")).toMatchObject({ tier: "warm", deleting_at: null });
    expect(
      filterWarmMemoryIds(f.sql, ["new", "legacy-after-completion"]),
    ).toEqual(["new"]);
  });

  it("deletion follows summary and insight provenance transitively without looping", () => {
    const f = fixture();
    f.seed("a");
    f.seed("s", "summary");
    f.seed("i", "insight");
    f.sql.exec("INSERT INTO memory_insight_sources VALUES (?, ?)", "s", "a");
    f.sql.exec("INSERT INTO memory_insight_sources VALUES (?, ?)", "i", "s");
    f.sql.exec("INSERT INTO memory_insight_sources VALUES (?, ?)", "s", "i");
    expect(planMemoryDeletion(f.sql, ["a"])).toEqual(["a", "s", "i"]);
  });

  it("summary provenance alone does not keep a restored original cold", () => {
    const f = fixture();
    f.seed("a");
    f.seed("s", "summary");
    f.seed("i", "insight");
    f.sql.exec(
      "UPDATE memory_index SET tier = 'cold' WHERE vector_id = ?",
      "a",
    );
    f.sql.exec("INSERT INTO memory_insight_sources VALUES (?, ?)", "s", "a");
    f.sql.exec("INSERT INTO memory_insight_sources VALUES (?, ?)", "i", "a");
    removeIndexedMemories(f.sql, ["i"]);
    expect(f.row("a")).toMatchObject({ tier: "warm" });
    expect(
      f.sql.exec("SELECT insight_id FROM memory_insight_sources").toArray(),
    ).toEqual([{ insight_id: "s" }]);
  });

  it("retains failed deletion markers and removes them only when the bounded retry succeeds", async () => {
    const f = fixture();
    f.seed("a");
    f.seed("b");
    markMemoriesForDeletion(f.sql, ["a", "b"]);
    f.env.MEMORY_INDEX.deleteByIds.mockRejectedValueOnce(new Error("offline"));
    await expect(
      cleanupPendingMemoryDeletions({ ...f, limit: 1 }),
    ).rejects.toThrow("offline");
    expect(filterWarmMemoryIds(f.sql, ["a", "b"])).toEqual([]);
    expect(await cleanupPendingMemoryDeletions({ ...f, limit: 1 })).toBe(false);
    expect(await cleanupPendingMemoryDeletions({ ...f, limit: 1 })).toBe(true);
    expect(f.sql.exec("SELECT * FROM memory_index").toArray()).toEqual([]);
  });

  it.each(["individual", "forget before listing", "forget after listing"])(
    "retains durable deletion state without a binding and resumes once restored: %s",
    async (operation) => {
      const f = fixture();
      f.seed("a");
      if (operation === "individual") markMemoriesForDeletion(f.sql, ["a"]);
      else {
        beginForgetAll({ sql: f.sql, user_id: "u", tenant_binding: "T" });
        if (operation === "forget after listing")
          f.sql.exec("UPDATE memory_forget_state SET legacy_list_complete = 1");
      }
      const binding = f.env.MEMORY_INDEX;
      binding.query = vi.fn().mockResolvedValue({ matches: [] });
      f.env.MEMORY_INDEX = undefined;
      await expect(cleanupPendingMemoryDeletions(f)).rejects.toThrow(
        "MEMORY_INDEX",
      );
      expect(f.row("a")).toMatchObject({
        tier: "cold",
        deleting_at: expect.any(Number),
      });
      expect(filterWarmMemoryIds(f.sql, ["a"])).toEqual([]);
      expect(
        f.sql.exec("SELECT * FROM memory_forget_state").toArray(),
      ).toHaveLength(operation === "individual" ? 0 : 1);
      expect(binding.deleteByIds).not.toHaveBeenCalled();
      f.env.MEMORY_INDEX = binding;
      expect(await cleanupPendingMemoryDeletions(f)).toBe(true);
      expect(binding.deleteByIds).toHaveBeenCalledWith(["a"]);
      expect(f.row("a")).toBeUndefined();
      expect(f.sql.exec("SELECT * FROM memory_forget_state").toArray()).toEqual(
        [],
      );
    },
  );

  it("never restores a source marked for pending deletion when its last insight is removed", async () => {
    const f = fixture();
    f.seed("a");
    await applyDreamResult(args(f));
    markMemoriesForDeletion(f.sql, ["a"]);
    removeIndexedMemories(f.sql, ["task:0"]);
    expect(filterWarmMemoryIds(f.sql, ["a"])).toEqual([]);
    expect(f.row("a")).toMatchObject({ tier: "cold" });
    // A tier mutation elsewhere must not clear the durable deletion intent.
    f.sql.exec(
      "UPDATE memory_index SET tier = 'warm' WHERE vector_id = ?",
      "a",
    );
    expect(filterWarmMemoryIds(f.sql, ["a"])).toEqual([]);
  });
  it("cleans only indexed cold staged insights for a discarded task", async () => {
    const f = fixture();
    f.seed("task:0", "insight");
    f.seed("task:1", "insight");
    f.seed("other:0", "insight");
    f.sql.exec(
      "UPDATE memory_index SET tier = 'cold' WHERE vector_id IN (?, ?)",
      "task:0",
      "other:0",
    );
    await cleanupDreamResult({ ...f, taskId: "task" });
    expect(f.env.MEMORY_INDEX.deleteByIds).toHaveBeenCalledWith(["task:0"]);
    expect(f.row("task:0")).toBeUndefined();
    expect(f.row("task:1")).toMatchObject({ tier: "warm" });
    expect(f.row("other:0")).toMatchObject({ tier: "cold" });
    await cleanupDreamResult({ ...f, taskId: "task" });
    expect(f.env.MEMORY_INDEX.deleteByIds).toHaveBeenCalledTimes(1);
  });

  it("filters cold IDs and fails closed on lookup errors", () => {
    const f = fixture();
    f.seed("a");
    f.seed("b");
    f.sql.exec(
      "UPDATE memory_index SET tier = 'cold' WHERE vector_id = ?",
      "a",
    );
    expect(filterWarmMemoryIds(f.sql, ["a", "b", "legacy"])).toEqual(["b"]);
    expect(() =>
      filterWarmMemoryIds(
        {
          exec: () => {
            throw new Error("broken SQL");
          },
        },
        ["a"],
      ),
    ).toThrow();
  });

  it("deleting an insight restores sources without repeating a rejected learning", async () => {
    const f = fixture();
    f.seed("a");
    await applyDreamResult(args(f));
    expect(planMemoryDeletion(f.sql, ["task:0"])).toEqual(["task:0"]);
    removeIndexedMemories(f.sql, ["task:0"]);
    expect(f.row("a")).toMatchObject({ tier: "warm", dreamt_at: NOW });
    expect(f.row("task:0")).toBeUndefined();
    expect(
      f.sql.exec("SELECT * FROM memory_insight_sources").toArray(),
    ).toEqual([]);
  });

  it("forgetting a source deletes derived insights and restores other sources", async () => {
    const f = fixture();
    f.seed("a");
    f.seed("b");
    await applyDreamResult(args(f, result(["a", "b"])));
    const ids = planMemoryDeletion(f.sql, ["a"]);
    expect(ids).toEqual(["a", "task:0"]);
    removeIndexedMemories(f.sql, ids);
    expect(f.row("a")).toBeUndefined();
    expect(f.row("task:0")).toBeUndefined();
    expect(f.row("b")).toMatchObject({ tier: "warm" });
  });

  it("keeps a source cold until the last insight referencing it is removed", async () => {
    const f = fixture();
    f.seed("a");
    await applyDreamResult(
      args(
        f,
        JSON.stringify({
          insights: [
            { content: "First supported learning", source_ids: ["a"] },
            { content: "Second supported learning", source_ids: ["a"] },
          ],
        }),
      ),
    );
    removeIndexedMemories(f.sql, ["task:0"]);
    expect(f.row("a")).toMatchObject({ tier: "cold" });
    removeIndexedMemories(f.sql, ["task:1"]);
    expect(f.row("a")).toMatchObject({ tier: "warm" });
  });
});

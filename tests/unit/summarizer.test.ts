import { createMemoryBucket } from "../helpers/memoryBucket";
import { buildNamespace } from "../../src/utils/memoryClient";
/**
 * Unit tests for the DurableClaw conversation summarizer.
 *
 * The summarizer is pure logic over a SqlExecLike + Env, so we exercise
 * it directly with real SQLite and stubbed AI / Vectorize
 * bindings. No DO state, no workers test pool.
 *
 * Coverage:
 *  - happy path: 20 messages -> summary vector written, raw vectors
 *    deleted, memory_links carried forward, cursor advanced.
 *  - below threshold (< batch_size) -> no summary, reason set.
 *  - AI call failure -> no Vectorize write, no SQL update, reason set.
 *  - Embed failure -> same.
 *  - Vectorize upsert failure -> no raw deletes, reason set.
 *  - entity link carry-forward: source raws have memory_links, summary
 *    vector inherits the entities; old memory_links rows deleted.
 *  - re-run with cursor populated re-summarises a fresh window.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  countMessagesSinceCursor,
  summarizeConversation,
  applyConversationSummary,
  isSummaryValid,
  DEFAULT_BATCH_SIZE,
} from "../../src/durable-objects/assistant/summarizer";
import { createSqliteStorage } from "../helpers/sqlite";
import {
  MEMORY_INDEX_SCHEMA_SQL,
  indexMemory,
  planMemoryDeletion,
  removeIndexedMemories,
  filterWarmMemoryIds,
  filterListMemoryIds,
  prepareDream,
} from "../../src/durable-objects/assistant/dreaming";
import { HOUSEKEEPING_SCHEMA_SQL } from "../../src/durable-objects/assistant/housekeepingBatch";

// Simulate only batch response delivery; preparation/application use real SQL.
const batchText = vi.fn();
async function completeBatchSummary(
  args: Parameters<typeof summarizeConversation>[0],
) {
  const queued = await summarizeConversation(args);
  if (queued.reason !== "queued") return queued;
  const task = args.sql
    .exec(
      "SELECT * FROM housekeeping_tasks WHERE task_key = ?",
      `summary:${args.conversation_id}`,
    )
    .toArray()[0] as any;
  let text: string | null;
  try {
    text = (await batchText()).text ?? null;
  } catch {
    return { ...queued, reason: "ai_call_failed" };
  }
  const result = await applyConversationSummary({
    ...args,
    payload: JSON.parse(task.payload_json),
    taskId: task.task_id,
    text,
    stillValid: () => true,
  });
  if (result.summarized)
    args.sql.exec(
      "DELETE FROM housekeeping_tasks WHERE task_id = ?",
      task.task_id,
    );
  return result;
}

function makeAI(embedding: number[] = new Array(1024).fill(0.1)) {
  return {
    run: vi.fn().mockResolvedValue({ data: [embedding] }),
  };
}

function makeMemoryBinding(
  overrides: Partial<{
    upsert: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
    getByIds: ReturnType<typeof vi.fn>;
    deleteByIds: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    upsert:
      overrides.upsert ?? vi.fn().mockResolvedValue({ ids: [], count: 0 }),
    query: overrides.query ?? vi.fn().mockResolvedValue({ matches: [] }),
    getByIds: overrides.getByIds ?? vi.fn().mockResolvedValue([]),
    deleteByIds:
      overrides.deleteByIds ?? vi.fn().mockResolvedValue({ ids: [], count: 0 }),
  };
}

function makeEnv(
  overrides: {
    AI?: any;
    MEMORY_INDEX?: any;
  } = {},
) {
  return {
    WORKSPACE: createMemoryBucket() as any,
    AI: overrides.AI ?? makeAI(),
    MEMORY_INDEX: overrides.MEMORY_INDEX ?? makeMemoryBinding(),
    OPENROUTER_API_KEY: "sk-or-test",
  } as any;
}

/**
 * Seed the in-memory SQL with a conversations + messages + memory_links
 * triplet ready for summarization.
 */
function seedConversation(opts: {
  sql: ReturnType<typeof createSqliteStorage>;
  conversation_id: string;
  message_count: number;
  /** Whether to stamp every assistant row with a vector_id (used as a delete target). */
  withVectorIds?: boolean;
  /**
   * For each message index, add this many memory_links rows pointing at
   * (document, doc-<index>). Lets tests assert carry-forward.
   */
  linksPerMessage?: number;
}): { messageIds: string[]; vectorIds: string[] } {
  opts.sql.exec(HOUSEKEEPING_SCHEMA_SQL);
  opts.sql.exec(MEMORY_INDEX_SCHEMA_SQL);
  opts.sql.exec(
    `CREATE TABLE conversations (
      conversation_id TEXT,
      title TEXT,
      created_at INTEGER,
      last_active_at INTEGER,
      message_count INTEGER,
      summarized_through_message_id TEXT
    )`,
  );
  opts.sql.exec(
    `CREATE TABLE messages (
      message_id TEXT,
      conversation_id TEXT,
      role TEXT,
      content TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      tool_name TEXT,
      vector_id TEXT,
      created_at INTEGER
    )`,
  );
  opts.sql.exec(
    `CREATE TABLE memory_links (
      vector_id TEXT,
      entity_type TEXT,
      entity_id TEXT,
      conversation_id TEXT,
      created_at INTEGER
    )`,
  );

  const now = 1_700_000_000_000;
  opts.sql.exec(
    `INSERT INTO conversations (conversation_id, title, created_at, last_active_at, message_count, summarized_through_message_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    opts.conversation_id,
    null,
    now,
    now + opts.message_count,
    opts.message_count,
    null,
  );

  const messageIds: string[] = [];
  const vectorIds: string[] = [];
  for (let i = 0; i < opts.message_count; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const message_id = `m-${i.toString().padStart(3, "0")}`;
    const vector_id =
      opts.withVectorIds && role === "assistant" ? `vec-${i}` : null;
    if (vector_id) vectorIds.push(vector_id);
    messageIds.push(message_id);
    opts.sql.exec(
      `INSERT INTO messages (message_id, conversation_id, role, content, tool_calls, tool_call_id, tool_name, vector_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      message_id,
      opts.conversation_id,
      role,
      `turn ${i} from ${role}`,
      null,
      null,
      null,
      vector_id,
      now + i,
    );
    if (vector_id && opts.linksPerMessage && opts.linksPerMessage > 0) {
      for (let k = 0; k < opts.linksPerMessage; k++) {
        opts.sql.exec(
          `INSERT INTO memory_links (vector_id, entity_type, entity_id, conversation_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          vector_id,
          "document",
          `doc-${i}-${k}`,
          opts.conversation_id,
          now + i,
        );
      }
    }
  }
  return { messageIds, vectorIds };
}

describe("summarizeConversation", () => {
  it("holds a published summary out of recall, listing and dreaming until local cursor commit", async () => {
    const sql = createSqliteStorage();
    seedConversation({ sql, conversation_id: "staging", message_count: 20 });
    const env = makeEnv();
    let summaryId = "";
    env.MEMORY_INDEX.upsert.mockImplementation(
      async (vectors: Array<{ id: string }>) => {
        summaryId = vectors[0].id;
        expect(
          sql.exec("SELECT vector_id FROM memory_pending_writes").toArray(),
        ).toEqual([{ vector_id: summaryId }]);
        expect(filterWarmMemoryIds(sql, [summaryId])).toEqual([]);
        expect(filterListMemoryIds(sql, [summaryId])).toEqual([]);
        expect(prepareDream(sql)).toBeNull();
        expect(
          sql
            .exec("SELECT summarized_through_message_id FROM conversations")
            .one().summarized_through_message_id,
        ).toBeNull();
        return { mutationId: "accepted" };
      },
    );
    const result = await completeBatchSummary({
      env,
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "staging",
    });
    expect(result.summarized).toBe(true);
    expect(filterWarmMemoryIds(sql, [summaryId])).toEqual([summaryId]);
    expect(sql.exec("SELECT * FROM memory_pending_writes").toArray()).toEqual(
      [],
    );
    expect(
      sql.exec("SELECT summarized_through_message_id FROM conversations").one()
        .summarized_through_message_id,
    ).toBe("m-019");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    (batchText as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      text: "Discussed React documents in the workspace; user prefers concise responses.",
    });
  });

  it("bounds persisted snapshots and detects source edits beyond the prompt prefix", async () => {
    const sql = createSqliteStorage();
    seedConversation({ sql, conversation_id: "large", message_count: 20 });
    const original = "a".repeat(110_000);
    sql.exec("UPDATE messages SET content = ?", original);
    await summarizeConversation({
      env: makeEnv(),
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "large",
    });
    const task = sql
      .exec("SELECT payload_json, request_json FROM housekeeping_tasks")
      .one();
    expect(
      new TextEncoder().encode(
        String(task.payload_json) + String(task.request_json),
      ).byteLength,
    ).toBeLessThan(100_000);
    const payload = JSON.parse(String(task.payload_json));
    expect(isSummaryValid(sql, payload)).toBe(true);
    sql.exec(
      "UPDATE messages SET content = ? WHERE message_id = 'm-000'",
      original.slice(0, -1) + "b",
    );
    expect(isSummaryValid(sql, payload)).toBe(false);
  });

  it("hides a cancelled summary when its compensating vector delete fails", async () => {
    const sql = createSqliteStorage();
    seedConversation({ sql, conversation_id: "cancel", message_count: 20 });
    const env = makeEnv();
    let valid = true;
    env.MEMORY_INDEX.upsert.mockImplementation(async () => {
      valid = false;
      return {};
    });
    env.MEMORY_INDEX.deleteByIds.mockRejectedValue(new Error("Unavailable"));
    await summarizeConversation({
      env,
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "cancel",
    });
    const task = sql.exec("SELECT * FROM housekeeping_tasks").one();
    const onDeletionPending = vi.fn();
    await expect(
      applyConversationSummary({
        env,
        sql,
        user_id: "u",
        tenant_binding: "T",
        taskId: String(task.task_id),
        payload: JSON.parse(String(task.payload_json)),
        text: "Summary",
        stillValid: () => valid,
        onDeletionPending,
      }),
    ).resolves.toMatchObject({ summarized: false, reason: "stale_source" });
    expect(onDeletionPending).toHaveBeenCalledOnce();
    expect(filterWarmMemoryIds(sql, [`summary-${task.task_id}`])).toEqual([]);
    expect(
      sql.exec("SELECT deleting_at FROM memory_index").one().deleting_at,
    ).not.toBeNull();
    expect(
      (sql.exec("SELECT * FROM conversations").toArray() as any[])[0]
        .summarized_through_message_id,
    ).toBeNull();
  });

  it("commits source provenance and the cursor before deleting raws, including retained dream sources", async () => {
    const sql = createSqliteStorage();
    const { vectorIds } = seedConversation({
      sql,
      conversation_id: "commit",
      message_count: 4,
      withVectorIds: true,
    });
    for (const id of vectorIds)
      indexMemory(sql, {
        vector_id: id,
        type: "raw",
        content: id,
        conversation_id: "commit",
      });
    indexMemory(sql, {
      vector_id: "dream",
      type: "insight",
      content: "An existing learning",
    });
    sql.exec(
      "INSERT INTO memory_insight_sources (insight_id, source_id) VALUES (?, ?)",
      "dream",
      vectorIds[0],
    );
    sql.exec(
      "UPDATE memory_index SET tier = 'cold', dreamt_at = 123 WHERE vector_id = ?",
      vectorIds[0],
    );
    const memory = makeMemoryBinding();
    let committedAtDelete: unknown;
    memory.deleteByIds.mockImplementation(async (ids: string[]) => {
      const summary = sql
        .exec("SELECT vector_id FROM memory_index WHERE type = 'summary'")
        .one();
      committedAtDelete = {
        cursor: (sql.exec("SELECT * FROM conversations").toArray() as any[])[0]
          .summarized_through_message_id,
        deletionPlan: planMemoryDeletion(sql, [vectorIds[1]]),
        summaryId: summary.vector_id,
        ids,
      };
      return { count: ids.length };
    });
    const result = await completeBatchSummary({
      env: makeEnv({ MEMORY_INDEX: memory }),
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "commit",
      batch_size: 4,
    });
    expect(committedAtDelete).toEqual({
      cursor: "m-003",
      deletionPlan: [vectorIds[1], result.summary_vector_id],
      summaryId: result.summary_vector_id,
      ids: [vectorIds[1]],
    });
    expect(planMemoryDeletion(sql, [vectorIds[0]])).toEqual([
      vectorIds[0],
      "dream",
      result.summary_vector_id,
    ]);
    expect(
      sql
        .exec("SELECT tier FROM memory_index WHERE vector_id = ?", vectorIds[0])
        .one().tier,
    ).toBe("cold");
    // Summary provenance is for deletion, not evidence that a dream still
    // covers this raw. Rejecting its sole insight restores the original.
    removeIndexedMemories(sql, ["dream"]);
    expect(
      sql
        .exec(
          "SELECT tier, dreamt_at FROM memory_index WHERE vector_id = ?",
          vectorIds[0],
        )
        .one(),
    ).toEqual({ tier: "warm", dreamt_at: 123 });
  });

  it("forgets the full derived chain even when provenance contains a cycle", () => {
    const sql = createSqliteStorage();
    sql.exec(MEMORY_INDEX_SCHEMA_SQL);
    for (const [derived, source] of [
      ["summary", "raw"],
      ["insight", "summary"],
      ["summary", "insight"],
      ["unrelated", "other"],
    ]) {
      sql.exec(
        "INSERT INTO memory_insight_sources (insight_id, source_id) VALUES (?, ?)",
        derived,
        source,
      );
    }
    expect(planMemoryDeletion(sql, ["raw"])).toEqual([
      "raw",
      "summary",
      "insight",
    ]);
  });

  it("retains outgoing summary ancestry when confirmed compaction cleanup removes an original", () => {
    const sql = createSqliteStorage();
    sql.exec(MEMORY_INDEX_SCHEMA_SQL);
    indexMemory(sql, {
      vector_id: "raw",
      type: "raw",
      content: "An observation",
    });
    indexMemory(sql, {
      vector_id: "summary",
      type: "summary",
      content: "A replacement",
    });
    sql.exec(
      "INSERT INTO memory_insight_sources (insight_id, source_id) VALUES (?, ?)",
      "summary",
      "raw",
    );
    removeIndexedMemories(sql, ["raw"]);
    expect(sql.exec("SELECT vector_id FROM memory_index").toArray()).toEqual([
      { vector_id: "summary" },
    ]);
    const explicitForget = planMemoryDeletion(sql, ["raw"]);
    expect(explicitForget).toEqual(["raw", "summary"]);
    removeIndexedMemories(sql, explicitForget);
    expect(sql.exec("SELECT * FROM memory_index").toArray()).toEqual([]);
    expect(sql.exec("SELECT * FROM memory_insight_sources").toArray()).toEqual(
      [],
    );
  });

  it("queues inference without touching memories or advancing the cursor", async () => {
    const sql = createSqliteStorage();
    seedConversation({
      sql,
      conversation_id: "queued",
      message_count: 20,
      withVectorIds: true,
    });
    const env = makeEnv();
    const result = await summarizeConversation({
      env,
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "queued",
    });
    expect(result.reason).toBe("queued");
    expect(batchText).not.toHaveBeenCalled();
    expect(env.MEMORY_INDEX.upsert).not.toHaveBeenCalled();
    expect(
      (sql.exec("SELECT * FROM conversations").toArray() as any[])[0]
        .summarized_through_message_id,
    ).toBeNull();
    expect(sql.exec("SELECT * FROM housekeeping_tasks").toArray()).toHaveLength(
      1,
    );
  });

  it("below batch threshold: returns reason=below_batch_threshold without summarizing", async () => {
    const sql = createSqliteStorage();
    seedConversation({ sql, conversation_id: "conv-1", message_count: 10 });

    const memory = makeMemoryBinding();
    const env = makeEnv({ MEMORY_INDEX: memory });

    const result = await completeBatchSummary({
      env,
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv-1",
    });

    expect(result.summarized).toBe(false);
    expect(result.message_count).toBe(10);
    expect(result.reason).toBe("below_batch_threshold");
    expect(batchText).not.toHaveBeenCalled();
    expect(memory.upsert).not.toHaveBeenCalled();
    expect(memory.deleteByIds).not.toHaveBeenCalled();

    // Cursor not advanced.
    const conv = (
      sql.exec("SELECT * FROM conversations").toArray() as any[]
    )[0];
    expect(conv.summarized_through_message_id).toBe(null);
  });

  it("happy path: 30 messages -> oldest 20 summarized, cursor advances to message 19, raws deleted", async () => {
    const sql = createSqliteStorage();
    const { messageIds, vectorIds } = seedConversation({
      sql,
      conversation_id: "conv-1",
      message_count: 30,
      withVectorIds: true,
    });

    const memory = makeMemoryBinding();
    const env = makeEnv({ MEMORY_INDEX: memory });

    const result = await completeBatchSummary({
      env,
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv-1",
    });

    expect(result.summarized).toBe(true);
    expect(result.message_count).toBe(DEFAULT_BATCH_SIZE);
    expect(typeof result.summary_vector_id).toBe("string");
    expect(result.summary_vector_id!.length).toBeGreaterThan(0);
    expect(result.reason).toBeUndefined();

    // Summary embedded + upserted once.
    expect(batchText).toHaveBeenCalledTimes(1);
    expect(memory.upsert).toHaveBeenCalledTimes(1);
    const upserted = memory.upsert.mock.calls[0][0][0];
    expect(upserted.metadata.type).toBe("summary");
    expect(upserted.metadata.user_namespace).toBe(buildNamespace("u", "T"));

    // source_message_ids round-trips through writeMemory's `extra` as a
    // JSON-encoded string (Vectorize metadata scalars). Parse and assert
    // the IDs cover exactly the seeded oldest-N window in order.
    expect(
      typeof JSON.parse(upserted.metadata.extra_json).source_message_ids,
    ).toBe("string");
    const parsedSourceIds = JSON.parse(
      JSON.parse(upserted.metadata.extra_json).source_message_ids,
    );
    expect(parsedSourceIds).toHaveLength(DEFAULT_BATCH_SIZE);
    expect(parsedSourceIds).toEqual(messageIds.slice(0, DEFAULT_BATCH_SIZE));
    expect(JSON.parse(upserted.metadata.extra_json).source_count).toBe(
      DEFAULT_BATCH_SIZE,
    );

    // Raw vectors that were stamped on the oldest 20 messages are deleted.
    // Only assistant rows had vector_ids; in 20 messages (indices 0..19),
    // assistant rows are at 1, 3, 5 ... 19 = 10 vectors.
    expect(memory.deleteByIds).toHaveBeenCalledTimes(1);
    const deletedArg = memory.deleteByIds.mock.calls[0][0] as string[];
    const expectedDeleted = vectorIds.filter((vid) => {
      const idx = parseInt(vid.slice(4), 10);
      return idx < DEFAULT_BATCH_SIZE;
    });
    expect(deletedArg.sort()).toEqual(expectedDeleted.sort());

    // Cursor advanced to the 20th message_id (index 19).
    const conv = (
      sql.exec("SELECT * FROM conversations").toArray() as any[]
    )[0];
    expect(conv.summarized_through_message_id).toBe(
      messageIds[DEFAULT_BATCH_SIZE - 1],
    );

    // Model selection is covered by the batch client's request contract tests.
  });

  it("entity link carry-forward: source raws had memory_links -> new summary inherits them; old rows deleted", async () => {
    const sql = createSqliteStorage();
    const { vectorIds } = seedConversation({
      sql,
      conversation_id: "conv-2",
      message_count: 20,
      withVectorIds: true,
      linksPerMessage: 1,
    });

    const memory = makeMemoryBinding();
    const env = makeEnv({ MEMORY_INDEX: memory });

    const beforeLinks = (
      sql.exec("SELECT * FROM memory_links").toArray() as any[]
    ).length;
    expect(beforeLinks).toBeGreaterThan(0);

    const result = await completeBatchSummary({
      env,
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv-2",
    });

    expect(result.summarized).toBe(true);

    // After: every old memory_links row keyed on a vec-* should be gone;
    // every entity should be re-linked to the summary's vector_id.
    const remainingLinks = sql
      .exec("SELECT * FROM memory_links")
      .toArray() as any[];
    const summaryId = result.summary_vector_id!;
    const linkedToOldRaw = remainingLinks.filter((r: any) =>
      vectorIds.includes(r.vector_id),
    );
    expect(linkedToOldRaw).toHaveLength(0);

    const linkedToSummary = remainingLinks.filter(
      (r: any) => r.vector_id === summaryId,
    );
    expect(linkedToSummary.length).toBeGreaterThan(0);
    // Every entity that was linked from a summarized raw vector should
    // appear under the summary vector now.
    const entitiesUnderSummary = new Set(
      linkedToSummary.map((r: any) => `${r.entity_type}:${r.entity_id}`),
    );
    expect(entitiesUnderSummary.size).toBe(linkedToSummary.length);
  });

  it("AI call fails: no Vectorize write, no cursor update, reason=ai_call_failed", async () => {
    const sql = createSqliteStorage();
    seedConversation({
      sql,
      conversation_id: "conv-3",
      message_count: 20,
      withVectorIds: true,
    });

    (batchText as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("gateway down"),
    );

    const memory = makeMemoryBinding();
    const env = makeEnv({ MEMORY_INDEX: memory });

    const result = await completeBatchSummary({
      env,
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv-3",
    });

    expect(result.summarized).toBe(false);
    expect(result.reason).toBe("ai_call_failed");
    expect(memory.upsert).not.toHaveBeenCalled();
    expect(memory.deleteByIds).not.toHaveBeenCalled();
    expect(
      (sql.exec("SELECT * FROM conversations").toArray() as any[])[0]
        .summarized_through_message_id,
    ).toBe(null);
  });

  it("empty AI text: no Vectorize write, no cursor update, reason=ai_empty_response", async () => {
    const sql = createSqliteStorage();
    seedConversation({ sql, conversation_id: "conv-4", message_count: 20 });

    (batchText as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "   ",
    });

    const memory = makeMemoryBinding();
    const env = makeEnv({ MEMORY_INDEX: memory });

    const result = await completeBatchSummary({
      env,
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv-4",
    });

    expect(result.summarized).toBe(false);
    expect(result.reason).toBe("ai_empty_response");
    expect(memory.upsert).not.toHaveBeenCalled();
    expect(
      (sql.exec("SELECT * FROM conversations").toArray() as any[])[0]
        .summarized_through_message_id,
    ).toBe(null);
  });

  it("summarization model returns text=undefined (defensive): reason=ai_empty_response", async () => {
    const sql = createSqliteStorage();
    seedConversation({ sql, conversation_id: "conv-4b", message_count: 20 });

    (batchText as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: undefined,
    });

    const memory = makeMemoryBinding();
    const env = makeEnv({ MEMORY_INDEX: memory });

    const result = await completeBatchSummary({
      env,
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv-4b",
    });

    expect(result.summarized).toBe(false);
    expect(result.reason).toBe("ai_empty_response");
    expect(memory.upsert).not.toHaveBeenCalled();
  });

  it("embed fails: writeMemory throws -> no cursor update, reason=vector_write_failed", async () => {
    const sql = createSqliteStorage();
    seedConversation({
      sql,
      conversation_id: "conv-5",
      message_count: 20,
      withVectorIds: true,
    });

    // Force the AI binding's run() to throw -- generateEmbedding throws,
    // which writeMemory bubbles up to summarizeConversation.
    const failingAI = {
      run: vi.fn().mockRejectedValue(new Error("embed boom")),
    };
    const memory = makeMemoryBinding();
    const env = makeEnv({ AI: failingAI, MEMORY_INDEX: memory });

    const result = await completeBatchSummary({
      env,
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv-5",
    });

    expect(result.summarized).toBe(false);
    expect(result.reason).toBe("vector_write_failed");
    expect(memory.upsert).not.toHaveBeenCalled();
    expect(memory.deleteByIds).not.toHaveBeenCalled();
    expect(
      (sql.exec("SELECT * FROM conversations").toArray() as any[])[0]
        .summarized_through_message_id,
    ).toBe(null);
  });

  it("Vectorize upsert fails: no raw deletes, no cursor update, reason=vector_write_failed", async () => {
    const sql = createSqliteStorage();
    seedConversation({
      sql,
      conversation_id: "conv-6",
      message_count: 20,
      withVectorIds: true,
    });

    const memory = makeMemoryBinding({
      upsert: vi.fn().mockRejectedValue(new Error("vectorize down")),
    });
    const env = makeEnv({ MEMORY_INDEX: memory });

    const result = await completeBatchSummary({
      env,
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv-6",
    });

    expect(result.summarized).toBe(false);
    expect(result.reason).toBe("vector_write_failed");
    expect(memory.deleteByIds).not.toHaveBeenCalled();
    expect(
      (sql.exec("SELECT * FROM conversations").toArray() as any[])[0]
        .summarized_through_message_id,
    ).toBe(null);
  });

  it("MEMORY_INDEX binding missing: returns reason=vector_write_failed, no work attempted on Vectorize", async () => {
    const sql = createSqliteStorage();
    seedConversation({ sql, conversation_id: "conv-7", message_count: 20 });

    // Construct env without MEMORY_INDEX at all (vs. passing `undefined`
    // through `??` in `makeEnv`, which would still fall back to the
    // default mock binding).
    const env = {
      WORKSPACE: createMemoryBucket() as any,
      AI: makeAI(),
      OPENROUTER_API_KEY: "sk-or-test",
    } as any;

    const result = await completeBatchSummary({
      env,
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv-7",
    });

    expect(result.summarized).toBe(false);
    expect(result.reason).toBe("vector_write_failed");
    expect(
      (sql.exec("SELECT * FROM conversations").toArray() as any[])[0]
        .summarized_through_message_id,
    ).toBe(null);
  });

  it("honours batch_size override", async () => {
    const sql = createSqliteStorage();
    seedConversation({ sql, conversation_id: "conv-8", message_count: 12 });

    const memory = makeMemoryBinding();
    const env = makeEnv({ MEMORY_INDEX: memory });

    // Default batch_size=20 -> would skip. Override to 5 -> should summarize.
    const result = await completeBatchSummary({
      env,
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv-8",
      batch_size: 5,
    });

    expect(result.summarized).toBe(true);
    expect(result.message_count).toBe(5);
    expect(memory.upsert).toHaveBeenCalledTimes(1);
  });

  it.each([0, 17, 19])(
    "processes consecutive batches exactly once with %i earlier rows and randomly ordered tied IDs",
    async (earlierCount) => {
      const sql = createSqliteStorage();
      const { messageIds: earlierIds } = seedConversation({
        sql,
        conversation_id: "conv-tied",
        message_count: earlierCount,
      });
      sql.exec(
        "CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at)",
      );
      // Random UUIDs carry no chronology. Reverse lexical insertion guarantees
      // every boundary exercises a cursor whose ID is above later tied rows.
      const tiedIds = Array.from({ length: 63 - earlierCount }, () =>
        crypto.randomUUID(),
      )
        .sort()
        .reverse();
      for (const id of tiedIds) {
        sql.exec(
          "INSERT INTO messages (message_id, conversation_id, role, content, vector_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          id,
          "conv-tied",
          "assistant",
          id,
          null,
          1_700_000_000_100,
        );
      }
      // A second conversation sharing timestamps cannot enter this batch/count.
      sql.exec(
        "INSERT INTO messages (message_id, conversation_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
        "other-message",
        "conv-other",
        "assistant",
        "other",
        1_700_000_000_100,
      );
      const allIds = [...earlierIds, ...tiedIds];
      const memory = makeMemoryBinding();
      const env = makeEnv({ MEMORY_INDEX: memory });
      let cursor: string | null = null;
      const selected: string[] = [];
      expect(countMessagesSinceCursor(sql, "conv-tied", cursor)).toBe(63);
      for (let offset = 0; offset < 63; offset += 20) {
        const batchSize = Math.min(20, 63 - offset);
        const result = await completeBatchSummary({
          env,
          sql,
          user_id: "u",
          tenant_binding: "T",
          conversation_id: "conv-tied",
          batch_size: batchSize,
        });
        expect(result.summarized).toBe(true);
        const sources = JSON.parse(
          JSON.parse(memory.upsert.mock.calls.at(-1)![0][0].metadata.extra_json)
            .source_message_ids,
        );
        expect(sources).toEqual(allIds.slice(offset, offset + batchSize));
        selected.push(...sources);
        cursor = (sql.exec("SELECT * FROM conversations").toArray() as any[])[0]
          .summarized_through_message_id;
        expect(countMessagesSinceCursor(sql, "conv-tied", cursor)).toBe(
          63 - selected.length,
        );
      }
      expect(selected).toEqual(allIds);
      expect(new Set(selected).size).toBe(63);
      expect(
        await completeBatchSummary({
          env,
          sql,
          user_id: "u",
          tenant_binding: "T",
          conversation_id: "conv-tied",
        }),
      ).toMatchObject({
        summarized: false,
        reason: "no_messages",
        message_count: 0,
      });
    },
  );

  it("restarts both batch selection and counting when the stored cursor row is gone", async () => {
    const sql = createSqliteStorage();
    const { messageIds } = seedConversation({
      sql,
      conversation_id: "conv-gone",
      message_count: 6,
    });
    sql.exec(
      "UPDATE conversations SET summarized_through_message_id = ? WHERE conversation_id = ?",
      messageIds[2],
      "conv-gone",
    );
    sql.exec("DELETE FROM messages WHERE message_id = ?", messageIds[2]);
    expect(countMessagesSinceCursor(sql, "conv-gone", messageIds[2])).toBe(5);
    const memory = makeMemoryBinding();
    const result = await completeBatchSummary({
      env: makeEnv({ MEMORY_INDEX: memory }),
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv-gone",
      batch_size: 5,
    });
    expect(result.summarized).toBe(true);
    expect(
      JSON.parse(
        JSON.parse(memory.upsert.mock.calls[0][0][0].metadata.extra_json)
          .source_message_ids,
      ),
    ).toEqual(messageIds.filter((id) => id !== messageIds[2]));
  });

  it("respects an existing summarized_through_message_id cursor and reads only newer messages", async () => {
    const sql = createSqliteStorage();
    seedConversation({
      sql,
      conversation_id: "conv-9",
      message_count: 30,
      withVectorIds: true,
    });

    // Manually advance cursor to message m-014 (15 messages summarized).
    sql.exec(
      `UPDATE conversations SET summarized_through_message_id = ? WHERE conversation_id = ?`,
      "m-014",
      "conv-9",
    );

    const memory = makeMemoryBinding();
    const env = makeEnv({ MEMORY_INDEX: memory });

    // With batch_size=10, we should summarize m-015..m-024.
    const result = await completeBatchSummary({
      env,
      sql,
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv-9",
      batch_size: 10,
    });

    expect(result.summarized).toBe(true);
    expect(result.message_count).toBe(10);
    expect(
      (sql.exec("SELECT * FROM conversations").toArray() as any[])[0]
        .summarized_through_message_id,
    ).toBe("m-024");
  });
});

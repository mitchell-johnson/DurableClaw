import { createMemoryBucket } from "../helpers/memoryBucket";
import { buildNamespace } from "../../src/utils/memoryClient";
/**
 * Unit tests for DurableClaw memory orchestration.
 *
 * Covers the WRITE half of the turn loop plus the entity-link primitive:
 *   - writeRawTurnMemory short text path (embedded as-is).
 *   - writeRawTurnMemory long text fallback and supplied batch summary.
 *   - writeToolCallMemory embeds INTENT not result rows; memory_links
 *     rows are written for extracted entities.
 *   - collectExpansionVectorIds seed/per-entity/total caps and exclusions.
 *
 * The READ half moved to the `search_memory` tool when pre-turn stuffing was
 * removed; its behaviour is covered by
 * tests/durable-objects/assistant/memory-recall.test.ts. The cap tests below
 * used to run through `retrieveMemoryForTurn` and now exercise the helper
 * directly, so removing that function cost no coverage.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  writeRawTurnMemory,
  writeToolCallMemory,
  buildRawMemoryRequest,
  truncateAssistantText,
  tokenEstimate,
  collectExpansionVectorIds,
} from "../../src/durable-objects/assistant/memory";
import { createSqliteStorage } from "../helpers/sqlite";
import {
  MEMORY_INDEX_SCHEMA_SQL,
  filterWarmMemoryIds,
} from "../../src/durable-objects/assistant/dreaming";

function createMemorySql() {
  const sql = createSqliteStorage();
  sql.exec(MEMORY_INDEX_SCHEMA_SQL);
  return {
    exec: sql.exec,
    get tables() {
      return { memory_links: sql.exec("SELECT * FROM memory_links").toArray() };
    },
  };
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

function makeMatch(opts: {
  vector_id: string;
  score?: number;
  type?: "raw" | "summary" | "memory" | "tool_call";
  preview?: string;
}) {
  const namespace = buildNamespace("u", "T");
  return {
    id: opts.vector_id,
    score: opts.score ?? 0.5,
    metadata: {
      vector_id: opts.vector_id,
      type: opts.type ?? "raw",
      content_preview: opts.preview ?? `preview for ${opts.vector_id}`,
      user_id: "u",
      tenant_binding: "T",
      tenant_id: "T",
      created_at: 1,
      user_namespace: namespace,
    },
  };
}

describe("writeRawTurnMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("short assistant text embedded as-is (no summary call)", async () => {
    const memory = makeMemoryBinding();
    const env = {
      WORKSPACE: createMemoryBucket() as any,
      AI: makeAI(),
      MEMORY_INDEX: memory as any,
      OPENROUTER_API_KEY: "sk-or-test",
    } as any;

    const result = await writeRawTurnMemory(env, createMemorySql(), {
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv",
      user_message: "hi",
      assistant_text: "short reply",
    });

    expect(result.vector_id).not.toBeNull();
    expect(memory.upsert).toHaveBeenCalledTimes(1);
    const upsertedMeta = memory.upsert.mock.calls[0][0][0].metadata;
    expect(upsertedMeta.type).toBe("raw");
    const contentPreview = upsertedMeta.content_preview as string;
    expect(contentPreview).toContain("User: hi");
    expect(contentPreview).toContain("Assistant: short reply");
  });

  it("long assistant text uses bounded local fallback without a live model call", async () => {
    const memory = makeMemoryBinding();
    const longText = "x".repeat(2000);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("mock-fetch-rejects-summary")) as any;

    try {
      const env = {
        WORKSPACE: createMemoryBucket() as any,
        AI: makeAI(),
        MEMORY_INDEX: memory as any,
        OPENROUTER_API_KEY: "sk-or-test",
      } as any;

      const result = await writeRawTurnMemory(env, createMemorySql(), {
        user_id: "u",
        tenant_binding: "T",
        conversation_id: "conv",
        user_message: "hi",
        assistant_text: longText,
      });

      expect(result.vector_id).not.toBeNull();
      expect(memory.upsert).toHaveBeenCalledTimes(1);

      const aiRunArgs = (env.AI.run as any).mock.calls[0][1];
      const embeddedText: string = aiRunArgs.text[0];
      expect(embeddedText.length).toBeLessThan(longText.length + 100);
      expect(embeddedText.length).toBeLessThanOrEqual(1500);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns vector_id=null when binding is missing", async () => {
    const env = {
      WORKSPACE: createMemoryBucket() as any,
      AI: makeAI(),
      MEMORY_INDEX: undefined,
    } as any;
    const result = await writeRawTurnMemory(env, createMemorySql(), {
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "c",
      user_message: "hi",
      assistant_text: "reply",
    });
    expect(result.vector_id).toBeNull();
  });
});

describe("writeToolCallMemory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("checks cancellation after embedding before creating a tool memory vector", async () => {
    const sql = createMemorySql();
    let valid = true;
    const memory = makeMemoryBinding();
    const env = {
      AI: {
        run: vi.fn(async () => {
          valid = false;
          return { data: [[0.1]] };
        }),
      },
      MEMORY_INDEX: memory,
    } as any;
    const result = await writeToolCallMemory(env, sql, {
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "c",
      user_message: "Find documents",
      tool_name: "search_documents",
      tool_args: {},
      tool_output: {},
      stillValid: () => valid,
    });
    expect(result.vector_id).toBeNull();
    expect(memory.upsert).not.toHaveBeenCalled();
  });

  it("keeps a cancelled tool memory hidden if compensating vector deletion fails", async () => {
    const sql = createMemorySql();
    let valid = true;
    const memory = makeMemoryBinding({
      upsert: vi.fn(async () => {
        valid = false;
        return { count: 1 };
      }),
      deleteByIds: vi.fn().mockRejectedValue(new Error("offline")),
    });
    const pending = vi.fn();
    const env = {
      WORKSPACE: createMemoryBucket() as any,
      AI: makeAI(),
      MEMORY_INDEX: memory,
    } as any;
    const result = await writeToolCallMemory(env, sql, {
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "c",
      user_message: "Find documents",
      tool_name: "search_documents",
      tool_args: {},
      tool_output: {},
      stillValid: () => valid,
      onDeletionPending: pending,
    });
    expect(result.vector_id).toBeNull();
    const ids = sql
      .exec("SELECT vector_id FROM memory_index")
      .toArray()
      .map((row) => row.vector_id as string);
    expect(ids).toHaveLength(1);
    expect(filterWarmMemoryIds(sql, ids)).toEqual([]);
    expect(pending).toHaveBeenCalledOnce();
  });

  it("embeds INTENT (user message + tool name), NOT the result rows", async () => {
    const memory = makeMemoryBinding();
    const env = {
      WORKSPACE: createMemoryBucket() as any,
      AI: makeAI(),
      MEMORY_INDEX: memory as any,
      OPENROUTER_API_KEY: "sk-or-test",
    } as any;
    const sql = createMemorySql();
    sql.exec(
      `CREATE TABLE memory_links (vector_id TEXT, entity_type TEXT, entity_id TEXT, conversation_id TEXT, created_at INTEGER)`,
    );

    const result = await writeToolCallMemory(env, sql, {
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv-a",
      user_message: "find react documents in the workspace",
      tool_name: "search_documents",
      tool_args: { query: "react the workspace" },
      tool_output: {
        ui: "record_list",
        data: [
          { id: "doc-001", entity_type: "document", name: "Record A" },
          { id: "doc-002", entity_type: "document", name: "Record B" },
        ],
        summary: "2 documents.",
      },
      result_count: 2,
    });

    expect(result.vector_id).not.toBeNull();

    const aiRunArgs = (env.AI.run as any).mock.calls[0][1];
    const embeddedText: string = aiRunArgs.text[0];
    expect(embeddedText).toContain("find react documents in the workspace");
    expect(embeddedText).toContain("search_documents");
    expect(embeddedText).not.toContain("Record A");
    expect(embeddedText).not.toContain("Record B");
    expect(embeddedText).not.toContain("doc-001");
    expect(
      sql
        .exec(
          "SELECT type, content FROM memory_index WHERE vector_id = ?",
          result.vector_id,
        )
        .toArray(),
    ).toEqual([{ type: "tool_call", content: embeddedText }]);
  });

  it("writes memory_links rows for extracted entities", async () => {
    const memory = makeMemoryBinding();
    const env = {
      WORKSPACE: createMemoryBucket() as any,
      AI: makeAI(),
      MEMORY_INDEX: memory as any,
      OPENROUTER_API_KEY: "sk-or-test",
    } as any;
    const sql = createMemorySql();
    sql.exec(
      `CREATE TABLE memory_links (vector_id TEXT, entity_type TEXT, entity_id TEXT, conversation_id TEXT, created_at INTEGER)`,
    );

    await writeToolCallMemory(env, sql, {
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv-a",
      user_message: "what about document doc-001",
      tool_name: "get_record",
      tool_args: { entity_type: "document", id: "doc-001" },
      tool_output: {
        data: {
          entity_id: "doc-001",
          entity_type: "document",
          name: "Record A",
        },
      },
    });

    expect(sql.tables.memory_links).toHaveLength(1);
    expect(sql.tables.memory_links[0].entity_type).toBe("document");
    expect(sql.tables.memory_links[0].entity_id).toBe("doc-001");
    expect(sql.tables.memory_links[0].conversation_id).toBe("conv-a");
  });

  it("returns vector_id=null and skips memory_links when binding missing", async () => {
    const env = {
      WORKSPACE: createMemoryBucket() as any,
      AI: makeAI(),
      MEMORY_INDEX: undefined,
    } as any;
    const sql = createMemorySql();
    sql.exec(
      `CREATE TABLE memory_links (vector_id TEXT, entity_type TEXT, entity_id TEXT, conversation_id TEXT, created_at INTEGER)`,
    );

    const result = await writeToolCallMemory(env, sql, {
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv",
      user_message: "q",
      tool_name: "get_record",
      tool_args: { entity_type: "document", id: "doc-1" },
      tool_output: {},
    });

    expect(result.vector_id).toBeNull();
    expect(sql.tables.memory_links ?? []).toHaveLength(0);
  });
});

describe("raw memory batch request and local fallback", () => {
  it("truncates long responses locally while preserving short responses", () => {
    expect(truncateAssistantText("x".repeat(2000))).toBe("x".repeat(1200));
    expect(truncateAssistantText("short reply")).toBe("short reply");
  });

  it("builds a bounded text-only request for deferred summarization", () => {
    const request = buildRawMemoryRequest("assistant reply".repeat(10_000));
    expect(request.prompt.length).toBeLessThanOrEqual(60_000);
    expect(request.prompt).toContain("assistant reply");
    expect(request.system).toContain("user-facing outcome");
    expect(request.maxTokens).toBeGreaterThan(0);
    expect(request).not.toHaveProperty("tools");
    expect(request).not.toHaveProperty("model");
  });

  it("persists the supplied batch summary under its stable vector ID", async () => {
    const memory = makeMemoryBinding();
    const env = {
      WORKSPACE: createMemoryBucket() as any,
      AI: makeAI(),
      MEMORY_INDEX: memory,
    } as any;
    const result = await writeRawTurnMemory(env, createMemorySql(), {
      user_id: "u",
      tenant_binding: "T",
      conversation_id: "conv",
      user_message: "Find React documents",
      assistant_text: "x".repeat(2000),
      assistant_summary: "Found three React documents in the workspace.",
      vector_id: "raw-task-id",
    });
    expect(result.vector_id).toBe("raw-task-id");
    expect(env.AI.run.mock.calls[0][1].text[0]).toBe(
      "User: Find React documents\n\nAssistant: Found three React documents in the workspace.",
    );
  });
});

describe("tokenEstimate", () => {
  it("returns ceil(len/4)", () => {
    expect(tokenEstimate("")).toBe(0);
    expect(tokenEstimate("abc")).toBe(1);
    expect(tokenEstimate("a".repeat(10))).toBe(3);
  });
});

describe("collectExpansionVectorIds", () => {
  /**
   * A `memory_links` stand-in. `links` maps vector_id -> entities, and
   * `siblings` maps "type:id" -> the vectors linked to that entity.
   */
  function linkSql(
    links: Record<string, Array<{ entity_type: string; entity_id: string }>>,
    siblings: Record<string, string[]>,
  ) {
    return {
      exec(query: string, ...params: unknown[]) {
        if (/WHERE vector_id = \?/.test(query)) {
          return { toArray: () => links[String(params[0])] ?? [] };
        }
        if (/entity_type = \? AND entity_id = \?/.test(query)) {
          const key = `${params[0]}:${params[1]}`;
          const limit = Number(params[2]);
          // The query carries its own LIMIT; honour it so the per-entity cap
          // is actually asserted rather than assumed.
          return {
            toArray: () =>
              (siblings[key] ?? [])
                .slice(0, limit)
                .map((v) => ({ vector_id: v })),
          };
        }
        return { toArray: () => [] };
      },
    };
  }

  it("caps linked vectors per entity", () => {
    const ids = collectExpansionVectorIds(
      linkSql(
        { seed: [{ entity_type: "document", entity_id: "c1" }] },
        { "document:c1": ["v1", "v2", "v3", "v4", "v5", "v6", "v7"] },
      ),
      ["seed"],
      new Set(),
    );

    expect(ids).toHaveLength(5);
  });

  it("caps the total across many entities", () => {
    const links = {
      seed: [] as Array<{ entity_type: string; entity_id: string }>,
    };
    const siblings: Record<string, string[]> = {};
    for (let e = 0; e < 10; e++) {
      links.seed.push({ entity_type: "document", entity_id: `c${e}` });
      siblings[`document:c${e}`] = [
        `v${e}a`,
        `v${e}b`,
        `v${e}c`,
        `v${e}d`,
        `v${e}e`,
      ];
    }

    const ids = collectExpansionVectorIds(
      linkSql(links, siblings),
      ["seed"],
      new Set(),
    );

    // Without the total cap this would be 50 getByIds lookups.
    expect(ids).toHaveLength(15);
  });

  it("excludes vectors already present in the semantic results", () => {
    const ids = collectExpansionVectorIds(
      linkSql(
        { seed: [{ entity_type: "document", entity_id: "c1" }] },
        { "document:c1": ["v1", "v2", "v3"] },
      ),
      ["seed"],
      new Set(["v2"]),
    );

    expect(ids).toEqual(["v1", "v3"]);
  });

  it("visits each entity once even when several seeds share it", () => {
    const ids = collectExpansionVectorIds(
      linkSql(
        {
          s1: [{ entity_type: "document", entity_id: "c1" }],
          s2: [{ entity_type: "document", entity_id: "c1" }],
        },
        { "document:c1": ["v1", "v2"] },
      ),
      ["s1", "s2"],
      new Set(),
    );

    expect(ids).toEqual(["v1", "v2"]);
  });

  it("returns nothing for an empty seed list", () => {
    expect(collectExpansionVectorIds(linkSql({}, {}), [], new Set())).toEqual(
      [],
    );
  });

  it("skips a seed whose link read throws rather than failing the whole walk", () => {
    const flaky = {
      exec(query: string, ...params: unknown[]) {
        if (/WHERE vector_id = \?/.test(query)) {
          if (params[0] === "bad") throw new Error("read failed");
          return {
            toArray: () => [{ entity_type: "document", entity_id: "c1" }],
          };
        }
        return { toArray: () => [{ vector_id: "v1" }] };
      },
    };

    const ids = collectExpansionVectorIds(flaky, ["bad", "good"], new Set());

    expect(ids).toEqual(["v1"]);
  });
});

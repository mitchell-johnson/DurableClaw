import { describe, expect, it, vi } from "vitest";
import { createSqliteStorage } from "./helpers/sqlite";
import { createMemoryBucket } from "./helpers/memoryBucket";
import {
  MEMORY_INDEX_SCHEMA_SQL,
  beginForgetAll,
  cleanupPendingMemoryDeletions,
  filterWarmMemoryIds,
  filterListMemoryIds,
  indexMemory,
  markMemoriesForDeletion,
  removeIndexedMemories,
  hydrateLegacyMemoryIndex,
} from "../src/durable-objects/assistant/dreaming";
import { createMemoryTools } from "../src/durable-objects/assistant/tools/memory";
import { createMemoryRetrievalTool } from "../src/action-library/tools/retrieval";
import {
  buildNamespace,
  writeMemory,
  deleteMemoriesByIds,
} from "../src/utils/memoryClient";

function fixture() {
  const sql = createSqliteStorage();
  sql.exec(MEMORY_INDEX_SCHEMA_SQL);
  sql.exec(
    "CREATE TABLE memory_links (vector_id TEXT, entity_type TEXT, entity_id TEXT)",
  );
  const env = {
    AGENT_TOKEN: "test-only",
    WORKSPACE: createMemoryBucket(),
    AI: { run: vi.fn().mockResolvedValue({ data: [Array(1024).fill(0.1)] }) },
    MEMORY_INDEX: {
      upsert: vi.fn().mockResolvedValue({ mutationId: "accepted" }),
      deleteByIds: vi.fn().mockResolvedValue({ mutationId: "accepted" }),
      query: vi.fn().mockResolvedValue({ matches: [] }),
    },
  } as any;
  const owner = { user_id: "owner", tenant_binding: "default" };
  async function seed(
    id: string,
    type: "raw" | "summary" | "memory" | "tool_call" | "insight" = "memory",
  ) {
    await writeMemory(env, {
      ...owner,
      type,
      content: `Private ${id}`,
      vector_id: id,
    });
    indexMemory(sql, { vector_id: id, type, content: `Private ${id}` });
    return env.MEMORY_INDEX.upsert.mock.calls.at(-1)[0][0];
  }
  return { sql, env, owner, seed };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("durable memory deletion visibility", () => {
  it.each(["individual", "all"])(
    "retains only content-free tombstones after %s deletion and prevents repair/replay resurrection",
    async (operation) => {
      const f = fixture();
      const vector = await f.seed("forgotten", "raw");
      if (operation === "all") beginForgetAll({ ...f.owner, sql: f.sql });
      else markMemoriesForDeletion(f.sql, ["forgotten"]);
      expect(await cleanupPendingMemoryDeletions(f)).toBe(true);
      expect(f.sql.exec("SELECT * FROM memory_index").toArray()).toEqual([]);
      expect(f.sql.exec("SELECT * FROM memory_tombstones").toArray()).toEqual([
        { vector_id: "forgotten", deleted_at: expect.any(Number) },
      ]);
      // Simulate a delayed pre-deletion inventory write followed by startup repair.
      await f.env.WORKSPACE.put(
        `memory/namespaces/${buildNamespace("owner", "default")}/forgotten.json`,
        JSON.stringify({ ...vector.metadata, vector_id: "forgotten" }),
      );
      await hydrateLegacyMemoryIndex({ ...f, ...f.owner });
      indexMemory(f.sql, {
        vector_id: "forgotten",
        type: "raw",
        content: "replayed",
      });
      expect(filterWarmMemoryIds(f.sql, ["forgotten", "unknown"])).toEqual([]);
      expect(filterListMemoryIds(f.sql, ["forgotten", "unknown"])).toEqual([]);
      expect(f.sql.exec("SELECT * FROM memory_index").toArray()).toEqual([]);
      await f.seed("new");
      expect(filterWarmMemoryIds(f.sql, ["forgotten", "new"])).toEqual(["new"]);
    },
  );

  it.each(["preview", "recall"])(
    "suppresses a delayed R2 snapshot in the actual %s tool after deletion",
    async (kind) => {
      const f = fixture();
      const vector = await f.seed("delayed");
      f.env.MEMORY_INDEX.query.mockResolvedValue({
        matches: [{ ...vector, score: 1 }],
      });
      const reading = deferred();
      const resume = deferred();
      const get = f.env.WORKSPACE.get.bind(f.env.WORKSPACE);
      let hold = true;
      f.env.WORKSPACE.get = async (key: string) => {
        const object = await get(key);
        if (hold && object && key.startsWith("memory/namespaces/")) {
          hold = false;
          return {
            ...object,
            json: async () => {
              reading.resolve();
              await resume.promise;
              return object.json();
            },
          };
        }
        return object;
      };
      const tool =
        kind === "preview"
          ? createMemoryTools({ ...f, ...f.owner }).forget
          : createMemoryRetrievalTool(
              {
                env: f.env,
                tenantBinding: "default",
                tenantDB: {} as any,
                principal: {
                  userId: "owner",
                  userRole: "owner",
                  permissions: [],
                },
                telemetryTag: "test",
              },
              { sql: f.sql },
            ).search_memory;
      const pending = (tool.execute as any)(
        kind === "preview" ? { matching: "private" } : { query: "private" },
      );
      await reading.promise;
      markMemoriesForDeletion(f.sql, ["delayed"]);
      await deleteMemoriesByIds(f.env, ["delayed"]);
      removeIndexedMemories(f.sql, ["delayed"]);
      resume.resolve();
      const result = JSON.parse(await pending);
      expect(kind === "preview" ? result.candidates : result.memories).toEqual(
        [],
      );
      expect(JSON.stringify(result)).not.toContain("Private delayed");
    },
  );

  it("hides every pending memory type from management and preview, retaining visible cold sources", async () => {
    const f = fixture();
    const vectors = [];
    for (const type of [
      "raw",
      "summary",
      "memory",
      "tool_call",
      "insight",
    ] as const)
      vectors.push(await f.seed(type, type));
    await f.seed("cold-source", "summary");
    f.sql.exec(
      "UPDATE memory_index SET tier = 'cold' WHERE vector_id = ?",
      "cold-source",
    );
    const ids = vectors.map((v) => v.id);
    markMemoriesForDeletion(f.sql, ids);
    f.env.MEMORY_INDEX.query.mockResolvedValue({
      matches: vectors.map((v) => ({ ...v, score: 1 })),
    });
    expect(filterListMemoryIds(f.sql, [...ids, "cold-source"])).toEqual([
      "cold-source",
    ]);
    const result = JSON.parse(
      await createMemoryTools({ ...f, ...f.owner }).forget.execute({
        matching: "private",
      }),
    );
    expect(result.candidates).toEqual([]);
  });
});

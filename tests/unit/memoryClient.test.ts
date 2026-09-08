import { describe, it, expect, vi } from "vitest";
import { createMemoryBucket } from "../helpers/memoryBucket";
import {
  buildNamespace,
  writeMemory,
  queryMemory,
  listMemories,
  listAllMemoryIds,
  deleteMemoriesByIds,
  rankByTypeWeight,
  getMemoriesByIds,
} from "../../src/utils/memoryClient";
function fixture(pageSize = 1000) {
  return {
    AI: {
      run: vi.fn().mockResolvedValue({ data: [new Array(1024).fill(0.1)] }),
    },
    WORKSPACE: createMemoryBucket(pageSize),
    MEMORY_INDEX: {
      upsert: vi.fn().mockResolvedValue({ mutationId: "mutation" }),
      deleteByIds: vi.fn().mockResolvedValue({ mutationId: "mutation" }),
      query: vi.fn().mockResolvedValue({ matches: [] }),
    },
  } as any;
}
const owner = { user_id: "user-a", tenant_binding: "workspace-a" };
const input = {
  ...owner,
  type: "memory" as const,
  content: "Use concise responses",
};

describe("memory namespaces and inventory", () => {
  it("rejects stale vector query and ID results after deletion acceptance", async () => {
    const env = fixture();
    await writeMemory(env, { ...input, vector_id: "stale" });
    const vector = env.MEMORY_INDEX.upsert.mock.calls[0][0][0];
    env.MEMORY_INDEX.query.mockResolvedValue({
      matches: [{ ...vector, score: 0.9 }],
    });
    env.MEMORY_INDEX.getByIds = vi.fn().mockResolvedValue([vector]);
    expect(
      await queryMemory(env, { ...owner, query_text: "preference" }),
    ).toHaveLength(1);
    expect(await getMemoriesByIds(env, ["stale"])).toHaveLength(1);
    await deleteMemoriesByIds(env, ["stale"]);
    // The vector adapter intentionally keeps serving the pre-mutation snapshot.
    expect(
      await queryMemory(env, { ...owner, query_text: "preference" }),
    ).toEqual([]);
    expect(await getMemoriesByIds(env, ["stale"])).toEqual([]);
  });

  it("bounds arbitrary unicode identities and distinguishes delimiter collisions", () => {
    expect(buildNamespace("a:b", "c")).not.toBe(buildNamespace("a", "b:c"));
    expect(buildNamespace("用户".repeat(200), "workspace".repeat(100))).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(buildNamespace("a", "b")).not.toBe(buildNamespace("b", "a"));
  });
  it("persists enumerable inventory before an ambiguous vector upsert", async () => {
    const env = fixture();
    env.MEMORY_INDEX.upsert.mockImplementation(async () => {
      expect(await listAllMemoryIds(env, owner)).toEqual(["id-a"]);
      throw new Error("connection ended after acceptance");
    });
    await expect(
      writeMemory(env, { ...input, vector_id: "id-a" }),
    ).rejects.toThrow();
    expect(await listAllMemoryIds(env, owner)).toEqual(["id-a"]);
    await deleteMemoriesByIds(env, ["id-a"]);
    expect(await listAllMemoryIds(env, owner)).toEqual([]);
    expect(env.WORKSPACE.objects.size).toBe(0);
  });
  it("enumerates all pages past vector-search caps and isolates tenant and user", async () => {
    const env = fixture(13);
    for (let i = 0; i < 123; i++)
      await writeMemory(env, {
        ...input,
        vector_id: `id-${String(i).padStart(3, "0")}`,
      });
    await writeMemory(env, {
      ...input,
      user_id: "user-b",
      vector_id: "foreign-user",
    });
    await writeMemory(env, {
      ...input,
      tenant_binding: "workspace-b",
      vector_id: "foreign-workspace",
    });
    const ids = await listAllMemoryIds(env, owner);
    expect(ids).toHaveLength(123);
    const page = await listMemories(env, { ...owner, offset: 100, limit: 50 });
    expect(page.matches).toHaveLength(23);
    expect(page.total_returned).toBe(123);
    expect(env.MEMORY_INDEX.query).not.toHaveBeenCalled();
    await deleteMemoriesByIds(env, ids);
    expect(await listAllMemoryIds(env, owner)).toEqual([]);
    expect(
      await listAllMemoryIds(env, { ...owner, user_id: "user-b" }),
    ).toEqual(["foreign-user"]);
  });
  it("retains deletion locators if namespace purge fails", async () => {
    const env = fixture();
    await writeMemory(env, { ...input, vector_id: "id" });
    const remove = env.WORKSPACE.delete;
    env.WORKSPACE.delete = vi
      .fn()
      .mockRejectedValueOnce(new Error("R2 unavailable"))
      .mockImplementation(remove);
    await expect(deleteMemoriesByIds(env, ["id"])).rejects.toThrow();
    expect(env.WORKSPACE.objects.has("memory/records/id.json")).toBe(true);
    await deleteMemoriesByIds(env, ["id"]);
    expect(env.WORKSPACE.objects.size).toBe(0);
  });
  it("does not produce a vector when cancellation arrives during inventory writes", async () => {
    const env = fixture();
    let valid = true;
    const put = env.WORKSPACE.put;
    env.WORKSPACE.put = async (...args: any[]) => {
      const result = await put(...args);
      valid = false;
      return result;
    };
    const result = await writeMemory(env, {
      ...input,
      stillValid: () => valid,
    });
    expect(result.persisted).toBe(false);
    expect(env.MEMORY_INDEX.upsert).not.toHaveBeenCalled();
    expect(env.WORKSPACE.objects.size).toBe(0);
  });
  it("fails explicitly without enumerable storage or compatible embeddings", async () => {
    const env = fixture();
    await expect(
      writeMemory({ ...env, WORKSPACE: undefined }, input),
    ).rejects.toThrow("WORKSPACE");
    env.AI.run.mockResolvedValue({ data: [[0.1, 0.2]] });
    await expect(writeMemory(env, input)).rejects.toThrow("dimensions");
    expect(env.MEMORY_INDEX.upsert).not.toHaveBeenCalled();
  });
  it("post-filters search scope even if a custom index ignores namespace filters", async () => {
    const env = fixture();
    const namespace = buildNamespace(owner.user_id, owner.tenant_binding);
    await writeMemory(env, { ...input, vector_id: "owned" });
    env.MEMORY_INDEX.query.mockResolvedValue({
      matches: [
        {
          id: "owned",
          score: 0.7,
          metadata: { user_namespace: namespace, type: "memory" },
        },
        {
          id: "other",
          score: 1,
          metadata: { user_namespace: "foreign", type: "memory" },
        },
      ],
    });
    const results = await queryMemory(env, {
      ...owner,
      query_text: "preference",
      topK: NaN,
    });
    expect(results.map((row) => row.vector_id)).toEqual(["owned"]);
    expect(env.MEMORY_INDEX.query.mock.calls[0][1]).toMatchObject({
      namespace,
      topK: 12,
      filter: { user_namespace: { $eq: namespace } },
    });
    expect(rankByTypeWeight(results)[0].weighted_score).toBeCloseTo(1.05);
  });
});

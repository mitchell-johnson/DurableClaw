import { expect, it, vi } from "vitest";
import { createSqliteStorage } from "./helpers/sqlite";
import { createMemoryBucket } from "./helpers/memoryBucket";
import {
  MEMORY_INDEX_SCHEMA_SQL,
  indexMemory,
  beginForgetAll,
  completeForgetAllLegacyListing,
} from "../src/durable-objects/assistant/dreaming";
import { buildNamespace } from "../src/utils/memoryClient";
import { NanoChatAgent } from "../src/durable-objects/NanoChatAgent";
function fixture() {
  const sql = createSqliteStorage();
  sql.exec(MEMORY_INDEX_SCHEMA_SQL);
  const bucket = createMemoryBucket();
  const env: any = {
    WORKSPACE: bucket,
    MEMORY_INDEX: { deleteByIds: async () => ({ mutationId: "ok" }) },
  };
  return { sql, bucket, env, user_id: "owner", tenant_binding: "default" };
}
async function seed(f: ReturnType<typeof fixture>, count: number) {
  const ns = buildNamespace(f.user_id, f.tenant_binding);
  for (let i = 0; i < count; i++) {
    const id = "memory-" + String(i).padStart(5, "0");
    indexMemory(f.sql, {
      vector_id: id,
      type: "memory",
      content: "Synthetic " + i,
      created_at: i,
    });
    await f.bucket.put(
      `memory/namespaces/${ns}/${id}.json`,
      JSON.stringify({
        vector_id: id,
        user_namespace: ns,
        type: "memory",
        content_preview: "Synthetic " + i,
        created_at: i,
      }),
    );
  }
}
it("fetches only a chronological management page of inventory bodies", async () => {
  const f = fixture();
  await seed(f, 2501);
  const get = vi.spyOn(f.bucket, "get");
  const list = vi.spyOn(f.bucket, "list");
  const agent: any = Object.create(NanoChatAgent.prototype);
  Object.assign(agent, {
    sql: f.sql,
    env: f.env,
    context: { user_id: f.user_id, tenant_binding: f.tenant_binding },
  });
  const page = await (
    await agent.handleListMemories(new URL("https://agent/memories?limit=30"))
  ).json();
  expect(page.memories).toHaveLength(30);
  expect(page.memories[0].vector_id).toBe("memory-02500");
  expect(get.mock.calls.length).toBeLessThanOrEqual(30);
  expect(list).not.toHaveBeenCalled();
  expect(JSON.parse(atob(page.next_cursor))).toEqual([2471, "memory-02471"]);
});
it("keeps remaining memories reachable when an earlier page is forgotten", async () => {
  const f = fixture();
  await seed(f, 6);
  const agent: any = Object.create(NanoChatAgent.prototype);
  Object.assign(agent, {
    sql: f.sql,
    env: f.env,
    context: { user_id: f.user_id, tenant_binding: f.tenant_binding },
  });
  const first = await (
    await agent.handleListMemories(new URL("https://agent/memories?limit=2"))
  ).json();
  f.sql.exec(
    "DELETE FROM memory_index WHERE vector_id=?",
    first.memories[0].vector_id,
  );
  const next = await (
    await agent.handleListMemories(
      new URL(
        `https://agent/memories?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`,
      ),
    )
  ).json();
  expect(next.memories.map((row: any) => row.vector_id)).toEqual([
    "memory-00003",
    "memory-00002",
  ]);
});
it("lists local-only imported memories with stable cursor continuation", async () => {
  const f = fixture();
  for (const id of ["a", "b", "c"])
    indexMemory(f.sql, {
      vector_id: id,
      type: "summary",
      content: `Imported ${id}`,
      created_at: 123,
    });
  const agent: any = Object.create(NanoChatAgent.prototype);
  Object.assign(agent, {
    sql: f.sql,
    env: f.env,
    context: { user_id: f.user_id, tenant_binding: f.tenant_binding },
  });
  const first = await (
    await agent.handleListMemories(new URL("https://agent/memories?limit=2"))
  ).json();
  expect(
    first.memories.map((row: any) => [row.vector_id, row.content_preview]),
  ).toEqual([
    ["a", "Imported a"],
    ["b", "Imported b"],
  ]);
  const last = await (
    await agent.handleListMemories(
      new URL(
        `https://agent/memories?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`,
      ),
    )
  ).json();
  expect(last.memories.map((row: any) => row.vector_id)).toEqual(["c"]);
  expect(last.next_cursor).toBeNull();
  const legacy = await (
    await agent.handleListMemories(
      new URL("https://agent/memories?limit=2&cursor=2"),
    )
  ).json();
  expect(legacy.memories.map((row: any) => row.vector_id)).toEqual(["c"]);
});
it("journals one namespace inventory page per forget-discovery pass without loading bodies", async () => {
  const f = fixture();
  await seed(f, 2501);
  f.sql.exec("DELETE FROM memory_index");
  beginForgetAll(f);
  const get = vi.spyOn(f.bucket, "get");
  const list = vi.spyOn(f.bucket, "list");
  await completeForgetAllLegacyListing(f);
  expect(list).toHaveBeenCalledTimes(1);
  expect(get).not.toHaveBeenCalled();
  expect(
    f.sql.exec("SELECT legacy_list_complete FROM memory_forget_state").one()
      .legacy_list_complete,
  ).toBe(0);
  const cursor = f.sql
    .exec("SELECT cursor FROM memory_inventory_cursors WHERE kind = 'forget'")
    .one().cursor;
  expect(cursor).toBeTruthy();
  // A newly constructed pass resumes from durable SQL state, not closure state.
  await completeForgetAllLegacyListing({ ...f });
  await completeForgetAllLegacyListing({ ...f });
  expect(list).toHaveBeenCalledTimes(3);
  expect(get).not.toHaveBeenCalled();
  expect(
    f.sql.exec("SELECT legacy_list_complete FROM memory_forget_state").one()
      .legacy_list_complete,
  ).toBe(1);
  expect(
    f.sql
      .exec(
        "SELECT COUNT(*) AS n FROM memory_index WHERE deleting_at IS NOT NULL",
      )
      .one().n,
  ).toBe(2501);
  expect(
    f.sql
      .exec("SELECT * FROM memory_inventory_cursors WHERE kind = 'forget'")
      .toArray(),
  ).toEqual([]);
});
it("bounds the HTTP purge even when local deletion inventory exceeds the R2 inventory", async () => {
  const f = fixture();
  f.sql.exec("CREATE TABLE memory_links(vector_id TEXT)");
  for (let i = 0; i < 201; i++)
    indexMemory(f.sql, {
      vector_id: `local-${i}`,
      type: "memory",
      content: "Synthetic",
    });
  const remove = vi.spyOn(f.env.MEMORY_INDEX, "deleteByIds");
  const agent: any = Object.create(NanoChatAgent.prototype);
  Object.assign(agent, {
    sql: f.sql,
    env: f.env,
    context: { user_id: f.user_id, tenant_binding: f.tenant_binding },
    invalidatePendingMemory: () => {},
    queueMemoryDeletionCleanup: () => {},
  });
  const response = await agent.handleForgetAllMemories(
    new Request("https://agent/memories", {
      method: "DELETE",
      body: JSON.stringify({ confirm: "FORGET" }),
    }),
  );
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({
    success: true,
    pending: true,
    deleted: 100,
  });
  expect(remove).toHaveBeenCalledTimes(1);
  expect(
    f.sql
      .exec(
        "SELECT COUNT(*) AS n FROM memory_index WHERE deleting_at IS NOT NULL",
      )
      .one().n,
  ).toBe(101);
});

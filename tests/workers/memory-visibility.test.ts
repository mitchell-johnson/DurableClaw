import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { NanoChatAgent } from "../../src/durable-objects/NanoChatAgent";
import { createInternalAuthHeaders } from "../../src/utils/internalAuth";
import {
  indexMemory,
  markMemoriesForDeletion,
  removeIndexedMemories,
  filterWarmMemoryIds,
} from "../../src/durable-objects/assistant/dreaming";
import { buildNamespace } from "../../src/utils/memoryClient";
const runtime = env as any;
async function headers(user: string) {
  return createInternalAuthHeaders(
    {
      userId: user,
      organizationId: "default",
      tenantBinding: "default",
      role: "owner",
    },
    "test-only-internal-secret",
  );
}
function fresh() {
  return runtime.NANO_CHAT_AGENT.get(
    runtime.NANO_CHAT_AGENT.idFromName(crypto.randomUUID()),
  );
}

describe("memory visibility on reconstructed coordinator storage", () => {
  it("creates the deletion table during v9 upgrade and keeps a deleted ID hidden after reconstruction", async () => {
    const stub = fresh();
    const user = crypto.randomUUID();
    await stub.fetch("https://agent/init", {
      method: "POST",
      headers: await headers(user),
      body: "{}",
    });
    const result = await runInDurableObject(
      stub,
      async (_original: any, state: DurableObjectState) => {
        // The v9 installation has no tombstone table. No memory data is discarded.
        state.storage.sql.exec("UPDATE schema_meta SET version = 9");
        state.storage.sql.exec("DROP TABLE memory_tombstones");
        const agent = new NanoChatAgent(state, env as any);
        await agent.fetch(
          new Request("https://agent/init", {
            method: "POST",
            headers: await headers(user),
            body: "{}",
          }),
        );
        indexMemory(state.storage.sql, {
          vector_id: "deleted",
          type: "raw",
          content: "Do not recall this",
        });
        markMemoriesForDeletion(state.storage.sql, ["deleted"]);
        removeIndexedMemories(state.storage.sql, ["deleted"]);
        const restored = new NanoChatAgent(state, env as any);
        await restored.fetch(
          new Request("https://agent/init", {
            method: "POST",
            headers: await headers(user),
            body: "{}",
          }),
        );
        indexMemory(state.storage.sql, {
          vector_id: "deleted",
          type: "raw",
          content: "Late write",
        });
        return {
          allowed: filterWarmMemoryIds(state.storage.sql, ["deleted"]),
          rows: state.storage.sql
            .exec("SELECT * FROM memory_index WHERE vector_id = 'deleted'")
            .toArray(),
          tombstones: state.storage.sql
            .exec("SELECT * FROM memory_tombstones")
            .toArray(),
        };
      },
    );
    expect(result.allowed).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.tombstones).toEqual([
      { vector_id: "deleted", deleted_at: expect.any(Number) },
    ]);
  });

  it("advances past fully hidden and mixed inventory pages without exposing pending deletions", async () => {
    const stub = fresh();
    const user = crypto.randomUUID();
    await stub.fetch("https://agent/init", {
      method: "POST",
      headers: await headers(user),
      body: "{}",
    });
    await runInDurableObject(
      stub,
      async (_agent: any, state: DurableObjectState) => {
        const rows = [
          ["staged-insight", "insight", "cold", false],
          ["deleting-memory", "memory", "warm", true],
          ["visible-memory", "memory", "warm", false],
          ["deleting-raw", "raw", "warm", true],
          ["cold-source", "summary", "cold", false],
          ["deleting-tool", "tool_call", "warm", true],
          ["deleting-summary", "summary", "warm", true],
          ["deleting-insight", "insight", "warm", true],
          ["visible-insight", "insight", "warm", false],
        ] as const;
        for (const [offset, [id, type, tier, deleting]] of rows.entries()) {
          indexMemory(state.storage.sql, {
            vector_id: id,
            type,
            content: id,
            created_at: 100 - offset,
          });
          state.storage.sql.exec(
            "UPDATE memory_index SET tier = ? WHERE vector_id = ?",
            tier,
            id,
          );
          if (deleting) markMemoriesForDeletion(state.storage.sql, [id]);
          await runtime.WORKSPACE.put(
            `memory/namespaces/${buildNamespace(user, "default")}/${id}.json`,
            JSON.stringify({
              vector_id: id,
              type,
              content_preview: id,
              created_at: 100 - offset,
              user_id: user,
              tenant_binding: "default",
              user_namespace: buildNamespace(user, "default"),
            }),
          );
        }
      },
    );
    let cursor: string | null = null;
    const found: string[] = [];
    const pages: Array<{ memories: unknown[]; next_cursor: string | null }> =
      [];
    do {
      const response = await stub.fetch(
        `https://agent/memories?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        { headers: await headers(user) },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      pages.push(body);
      found.push(...body.memories.map((m: any) => m.vector_id));
      cursor = body.next_cursor;
      expect(pages.length).toBeLessThan(10);
    } while (cursor);
    expect(pages[0]).toMatchObject({ memories: [], next_cursor: "2" });
    expect(pages[1]).toMatchObject({ next_cursor: "4" });
    expect(found).toEqual(["visible-memory", "cold-source", "visible-insight"]);
    expect(pages).toHaveLength(5);
  });
});

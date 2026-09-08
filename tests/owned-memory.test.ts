import { describe, expect, it, vi } from "vitest";
import { createSqliteStorage } from "./helpers/sqlite";
import { createMemoryBucket } from "./helpers/memoryBucket";
import {
  MEMORY_INDEX_SCHEMA_SQL,
  filterWarmMemoryIds,
  filterListMemoryIds,
  prepareDream,
  cleanupPendingMemoryDeletions,
  hydrateLegacyMemoryIndex,
} from "../src/durable-objects/assistant/dreaming";
import {
  writeRawTurnMemory,
  writeToolCallMemory,
} from "../src/durable-objects/assistant/memory";
import { createMemoryTools } from "../src/durable-objects/assistant/tools/memory";
import {
  writeOwnedMemory,
  recoverPendingMemoryWrites,
  discardPendingMemoryWrites,
} from "../src/durable-objects/assistant/ownedMemory";
import { buildNamespace, listAllMemoryIds } from "../src/utils/memoryClient";

function fixture() {
  const sql = createSqliteStorage();
  sql.exec(MEMORY_INDEX_SCHEMA_SQL);
  sql.exec(
    "CREATE TABLE memory_links (vector_id TEXT, entity_type TEXT, entity_id TEXT, conversation_id TEXT, created_at INTEGER)",
  );
  const env = {
    WORKSPACE: createMemoryBucket(),
    AI: { run: vi.fn().mockResolvedValue({ data: [Array(1024).fill(0.1)] }) },
    MEMORY_INDEX: {
      upsert: vi.fn().mockResolvedValue({ mutationId: "accepted" }),
      deleteByIds: vi.fn().mockResolvedValue({ mutationId: "accepted" }),
    },
  } as any;
  const owner = { user_id: "owner", tenant_binding: "default" };
  const onDeletionPending = vi.fn();
  return { sql, env, owner, onDeletionPending };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("owned memory publication journal", () => {
  it.each(["raw", "raw_batch", "tool_call", "remember"])(
    "keeps %s hidden throughout publication and commits only after it finishes",
    async (kind) => {
      const f = fixture();
      const paused = deferred(),
        release = deferred();
      const put = f.env.WORKSPACE.put.bind(f.env.WORKSPACE);
      let id = "";
      f.env.WORKSPACE.put = async (key: string, body: string) => {
        const result = await put(key, body);
        if (key.startsWith("memory/namespaces/")) {
          id = JSON.parse(body).vector_id;
          paused.resolve();
          await release.promise;
        }
        return result;
      };
      const writing =
        kind === "remember"
          ? createMemoryTools({ ...f, ...f.owner }).remember.execute({
              fact: "A private preference",
              scope: "global",
            })
          : kind === "tool_call"
            ? writeToolCallMemory(f.env, f.sql, {
                ...f.owner,
                conversation_id: "c",
                user_message: "Find files",
                tool_name: "search_records",
                tool_args: {},
                tool_output: {},
                onDeletionPending: f.onDeletionPending,
              })
            : writeRawTurnMemory(f.env, f.sql, {
                ...f.owner,
                conversation_id: "c",
                user_message: "Question",
                assistant_text: "Answer",
                ...(kind === "raw_batch"
                  ? { vector_id: "raw-task", retryTaskId: "task" }
                  : {}),
                onDeletionPending: f.onDeletionPending,
              });
      await paused.promise;
      expect(
        f.sql.exec("SELECT vector_id FROM memory_pending_writes").toArray(),
      ).toEqual([{ vector_id: id }]);
      expect(filterWarmMemoryIds(f.sql, [id])).toEqual([]);
      expect(filterListMemoryIds(f.sql, [id])).toEqual([]);
      expect(prepareDream(f.sql)).toBeNull();
      await hydrateLegacyMemoryIndex({ ...f, ...f.owner });
      expect(filterWarmMemoryIds(f.sql, [id])).toEqual([]);
      release.resolve();
      await writing;
      expect(filterWarmMemoryIds(f.sql, [id])).toEqual([id]);
      expect(
        f.sql.exec("SELECT * FROM memory_pending_writes").toArray(),
      ).toEqual([]);
    },
  );

  it.each(["locator", "namespace"])(
    "retains cleanup ownership after a partial %s R2 publication fails",
    async (boundary) => {
      const f = fixture();
      const put = f.env.WORKSPACE.put.bind(f.env.WORKSPACE);
      f.env.WORKSPACE.put = async (key: string, body: string) => {
        await put(key, body);
        if (
          key.startsWith(
            boundary === "locator" ? "memory/records/" : "memory/namespaces/",
          )
        )
          throw new Error("Connection lost after publication");
      };
      f.env.MEMORY_INDEX.deleteByIds.mockImplementation(async () => {
        // The owner must have recorded AND scheduled deletion before trying it.
        expect(f.onDeletionPending).toHaveBeenCalled();
        expect(
          f.sql
            .exec(
              "SELECT vector_id FROM memory_index WHERE deleting_at IS NOT NULL",
            )
            .toArray(),
        ).toHaveLength(1);
        throw new Error("Temporarily offline");
      });
      await expect(
        writeOwnedMemory({
          ...f,
          memory: {
            ...f.owner,
            type: "memory",
            content: "Private",
            vector_id: "partial",
          },
        }),
      ).rejects.toThrow("publication");
      expect(filterWarmMemoryIds(f.sql, ["partial"])).toEqual([]);
      expect(filterListMemoryIds(f.sql, ["partial"])).toEqual([]);
      expect(f.sql.exec("SELECT * FROM memory_write_scopes").toArray()).toEqual(
        [
          {
            vector_id: "partial",
            user_namespace: buildNamespace("owner", "default"),
          },
        ],
      );
      f.env.MEMORY_INDEX.deleteByIds.mockResolvedValue({
        mutationId: "accepted",
      });
      expect(await cleanupPendingMemoryDeletions(f)).toBe(true);
      expect(await listAllMemoryIds(f.env, f.owner)).toEqual([]);
      expect(f.env.WORKSPACE.objects.size).toBe(0);
    },
  );

  it("retains valid deterministic summary retries across recovery without tombstoning them", async () => {
    const f = fixture();
    f.env.MEMORY_INDEX.upsert.mockRejectedValueOnce(new Error("Retry storage"));
    const args = {
      ...f,
      retryTaskId: "summary-task",
      memory: {
        ...f.owner,
        type: "summary" as const,
        content: "Summary",
        vector_id: "summary-task",
      },
    };
    await expect(writeOwnedMemory(args)).rejects.toThrow("Retry storage");
    expect(
      recoverPendingMemoryWrites(f.sql, (task) => task === "summary-task"),
    ).toBe(0);
    expect(f.sql.exec("SELECT * FROM memory_tombstones").toArray()).toEqual([]);
    expect(filterWarmMemoryIds(f.sql, ["summary-task"])).toEqual([]);
    expect(f.env.MEMORY_INDEX.deleteByIds).not.toHaveBeenCalled();
    await expect(writeOwnedMemory(args)).resolves.toMatchObject({
      vector_id: "summary-task",
      persisted: true,
    });
    expect(filterWarmMemoryIds(f.sql, ["summary-task"])).toEqual([
      "summary-task",
    ]);
    expect(
      f.env.MEMORY_INDEX.upsert.mock.calls.map((call: any) => call[0][0].id),
    ).toEqual(["summary-task", "summary-task"]);
  });

  it.each(["recovery", "discard"])(
    "turns abandoned retry staging into durable cleanup on %s",
    async (reason) => {
      const f = fixture();
      f.env.MEMORY_INDEX.upsert.mockRejectedValueOnce(new Error("Unavailable"));
      await expect(
        writeOwnedMemory({
          ...f,
          retryTaskId: "abandoned",
          memory: {
            ...f.owner,
            type: "summary",
            content: "Summary",
            vector_id: "abandoned-id",
          },
        }),
      ).rejects.toThrow();
      expect(
        reason === "recovery"
          ? recoverPendingMemoryWrites(f.sql, () => false)
          : discardPendingMemoryWrites(f.sql, "abandoned"),
      ).toBe(1);
      expect(
        f.sql.exec("SELECT * FROM memory_pending_writes").toArray(),
      ).toEqual([]);
      expect(
        f.sql
          .exec(
            "SELECT vector_id FROM memory_index WHERE deleting_at IS NOT NULL",
          )
          .toArray(),
      ).toEqual([{ vector_id: "abandoned-id" }]);
      expect(await cleanupPendingMemoryDeletions(f)).toBe(true);
    },
  );
});

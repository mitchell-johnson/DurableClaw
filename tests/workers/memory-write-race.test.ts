import { expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { NanoChatAgent } from "../../src/durable-objects/NanoChatAgent";
import { createInternalAuthHeaders } from "../../src/utils/internalAuth";
import { writeToolCallMemory } from "../../src/durable-objects/assistant/memory";
import {
  beginForgetAll,
  cleanupPendingMemoryDeletions,
  hydrateLegacyMemoryIndex,
  filterWarmMemoryIds,
  filterListMemoryIds,
  prepareDream,
} from "../../src/durable-objects/assistant/dreaming";
import { buildNamespace, listMemories } from "../../src/utils/memoryClient";
const runtime = env as any;
async function headers() {
  return createInternalAuthHeaders(
    {
      userId: "owner",
      organizationId: "default",
      tenantBinding: "default",
      role: "owner",
    },
    "test-only-internal-secret",
  );
}
it.each([
  { kind: "raw", forget: true },
  { kind: "tool_call", forget: true },
  { kind: "tool_call", forget: false },
])(
  "recovers $kind writes after delayed publication (forget=$forget)",
  async ({ kind, forget }) => {
    const stub = runtime.NANO_CHAT_AGENT.get(
      runtime.NANO_CHAT_AGENT.idFromName(crypto.randomUUID()),
    );
    await stub.fetch("https://agent/init", {
      method: "POST",
      headers: await headers(),
      body: "{}",
    });
    const result = await runInDurableObject(
      stub,
      async (_agent: any, state: DurableObjectState) => {
        let release!: () => void, notifyPaused!: () => void;
        const paused = new Promise<void>((resolve) => {
          notifyPaused = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        let valid = true,
          failDelete = false,
          publishedId = "";
        const ownerEnv = {
          ...runtime,
          AI: { run: async () => ({ data: [Array(1024).fill(0.01)] }) },
          MEMORY_INDEX: {
            upsert: async () => ({ mutationId: "write" }),
            deleteByIds: async () => {
              if (failDelete) throw new Error("temporary delete failure");
              return { mutationId: "delete" };
            },
          },
          WORKSPACE: {
            get: (key: string) => runtime.WORKSPACE.get(key),
            list: (options: unknown) => runtime.WORKSPACE.list(options),
            delete: (key: string | string[]) => runtime.WORKSPACE.delete(key),
            put: async (key: string, value: string) => {
              if (key.startsWith("memory/namespaces/")) {
                publishedId = JSON.parse(value).vector_id;
                notifyPaused();
                await blocked;
              }
              return runtime.WORKSPACE.put(key, value);
            },
          },
        } as any;
        const sql = state.storage.sql;
        const writer = new NanoChatAgent(state, ownerEnv) as any;
        await writer.fetch(
          new Request("https://agent/init", {
            method: "POST",
            headers: await headers(),
            body: JSON.stringify({ conversation_id: "race" }),
          }),
        );
        const messageId = writer.appendMessage({
          conversationId: "race",
          role: "assistant",
          content: "Private response",
        });
        const writing =
          kind === "raw"
            ? writer.persistMemoryForTurn({
                conversationId: "race",
                assistantMessageId: messageId,
                memoryEnabled: true,
                userMessage: "Private content to forget",
                fullText: "Private response",
                finishReason: "stop",
                toolCallTrace: [],
              })
            : writeToolCallMemory(ownerEnv, sql, {
                user_id: "owner",
                tenant_binding: "default",
                conversation_id: "race",
                user_message: "Private content to forget",
                tool_name: "search_records",
                tool_args: {},
                tool_output: {},
                stillValid: () => valid,
              });
        await paused;
        let scanComplete = true;
        if (forget) {
          valid = false;
          writer.memoryWriteEpoch++;
          beginForgetAll({ sql, user_id: "owner", tenant_binding: "default" });
          scanComplete = await cleanupPendingMemoryDeletions({
            sql,
            env: ownerEnv,
            user_id: "owner",
            tenant_binding: "default",
          });
        } else {
          const abandoned = new NanoChatAgent(state, ownerEnv);
          await abandoned.fetch(
            new Request("https://agent/init", {
              method: "POST",
              headers: await headers(),
              body: "{}",
            }),
          );
        }
        failDelete = true;
        release();
        await writing;
        const restored = new NanoChatAgent(state, ownerEnv);
        await restored.fetch(
          new Request("https://agent/init", {
            method: "POST",
            headers: await headers(),
            body: "{}",
          }),
        );
        await hydrateLegacyMemoryIndex({
          sql,
          env: ownerEnv,
          user_id: "owner",
          tenant_binding: "default",
        });
        const hidden = {
          warm: filterWarmMemoryIds(sql, [publishedId]),
          listed: filterListMemoryIds(sql, [publishedId]),
          dream:
            prepareDream(sql)?.memories.some(
              (memory) => memory.vector_id === publishedId,
            ) ?? false,
          pending: sql
            .exec(
              "SELECT vector_id FROM memory_index WHERE deleting_at IS NOT NULL",
            )
            .toArray().length,
          scheduled: sql
            .exec(
              "SELECT job_id FROM scheduled_jobs WHERE job_id='memory_deletions'",
            )
            .toArray().length,
        };
        failDelete = false;
        await cleanupPendingMemoryDeletions({
          sql,
          env: ownerEnv,
          user_id: "owner",
          tenant_binding: "default",
        });
        const remote = await listMemories(ownerEnv, {
          user_id: "owner",
          tenant_binding: "default",
        });
        const remainingKey = await runtime.WORKSPACE.get(
          `memory/namespaces/${buildNamespace("owner", "default")}/${encodeURIComponent(publishedId)}.json`,
        );
        return {
          scanComplete,
          hidden,
          remaining: remote.matches.some(
            (memory) => memory.vector_id === publishedId,
          ),
          remainingKey: remainingKey !== null,
        };
      },
    );
    expect(result.scanComplete).toBe(true);
    expect(result.hidden).toEqual({
      warm: [],
      listed: [],
      dream: false,
      pending: 1,
      scheduled: 1,
    });
    expect(result.remaining).toBe(false);
    expect(result.remainingKey).toBe(false);
  },
);

import { createMemoryTools } from "../src/durable-objects/assistant/tools/memory";
import { createMemoryBucket } from "./helpers/memoryBucket";
import { summarizeConversation } from "../src/durable-objects/assistant/summarizer";
import { describe, it, expect, vi, afterEach } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { NanoChatAgent } from "../src/durable-objects/NanoChatAgent";
import { ConversationHistoryStore } from "../src/agent-core/history";
import { replayHistory } from "../src/agent-core/replay";
import { createSqliteStorage } from "./helpers/sqlite";

function sse(deltas: any[], finish = "stop") {
  return new Response(
    [
      ...deltas.map((delta) => ({
        id: "completion",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: null }],
      })),
      {
        id: "completion",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
      },
    ]
      .map((x) => `data: ${JSON.stringify(x)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
async function fixture(sql = createSqliteStorage()) {
  let init: Promise<unknown>;
  const setAlarm = vi.fn(async () => {});
  const state = {
    storage: { sql, transactionSync: (f: any) => f(), setAlarm },
    blockConcurrencyWhile: (f: any) => (init = f()),
    getWebSockets: () => [],
    waitUntil: () => {},
  };
  const dispatches: any[] = [];
  const env = {
    OPENROUTER_API_KEY: "test",
    CHAT_MODEL: "test-model",
    INTERNAL_AUTH_SECRET: "test-secret",
    RESEARCH_SUBAGENT: {
      idFromName: (id: string) => id,
      get: (id: string) => ({
        fetch: async (r: Request) => {
          dispatches.push(id);
          return new Response("{}", { status: 202 });
        },
      }),
    },
  };
  const agent = new NanoChatAgent(state as any, env as any) as any;
  await init!;
  agent.persistContext({
    user_id: "owner",
    user_name: "Owner",
    user_role: "owner",
    organization_id: "workspace",
    organization_name: "Workspace",
    tenant_binding: "workspace",
  });
  agent.restoreContextFromSql();
  agent.ensureConversationRow("conversation");
  agent.ensureSystemPrompt = async () => "System";
  agent.getPersonaSettings = () => ({
    memoryEnabled: false,
    enabledTools: null,
    disabledTools: null,
  });
  agent.generateConversationTitle = async () => {};
  return { agent, sql, state, env, dispatches, setAlarm };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("coordinator durable turn and dispatch recovery", () => {
  it("returns all 20 subagent results through a new assistant turn without another user message", async () => {
    const f = await fixture();
    const frames: any[] = [];
    f.agent.sendToConversation = (conversation: string, frame: any) => {
      expect(conversation).toBe("conversation");
      frames.push(frame);
    };
    // A channel bridge that sends replies on assistant_end must receive the
    // follow-up as well as the already-finished dispatch acknowledgement.
    const parentRequestId = "original-request";
    const { batch_id } = await f.agent.spawnSubagentBatch({
      origin: "chat",
      conversation_id: "conversation",
      request_id: parentRequestId,
      tasks: Array.from({ length: 20 }, (_, i) => ({
        goal: `Agent ${i + 1}: count to 10`,
        tier: "background",
      })),
    });
    frames.length = 0;
    const tasks = f.sql.exec("SELECT task_id FROM subagent_tasks").toArray();
    for (const [i, task] of tasks.entries()) {
      await f.agent.handleSubagentResult(
        new Request("https://do/subagent-result", {
          method: "POST",
          body: JSON.stringify({
            task_id: task.task_id,
            batch_id,
            status: "done",
            result: "1, 2, 3, 4, 5, 6, 7, 8, 9, 10",
          }),
        }),
      );
      if (i < 19) {
        await f.agent.runBatchSynthesis(batch_id);
        expect(frames).toEqual([]);
      }
    }
    await f.agent.alarm();
    const replies: string[] = [];
    let text = "";
    for (const frame of frames) {
      if (frame.type === "assistant_start") text = "";
      if (frame.type === "assistant_delta") text += frame.content;
      if (frame.type === "assistant_end") replies.push(text);
    }
    expect(replies).toHaveLength(1);
    for (let i = 1; i <= 20; i++) expect(replies[0]).toContain(`Agent ${i}:`);
    expect(replies[0].match(/1, 2, 3, 4, 5, 6, 7, 8, 9, 10/g)).toHaveLength(20);
    const start = frames.find((frame) => frame.type === "assistant_start");
    expect(start).toMatchObject({
      parent_request_id: parentRequestId,
      batch_id,
      message_id: `batch_${batch_id}`,
    });
    expect(start.request_id).not.toBe(parentRequestId);
    expect(
      frames.find((frame) => frame.type === "assistant_message")?.content,
    ).toBe(replies[0]);
    expect(
      f.sql
        .exec(
          "SELECT status FROM subagent_batches WHERE batch_id = ?",
          batch_id,
        )
        .toArray()[0].status,
    ).toBe("completed");
    await f.agent.runBatchSynthesis(batch_id);
    expect(
      frames.filter((frame) => frame.type === "assistant_end"),
    ).toHaveLength(1);
  });
  it("defers mixed subagent outcomes until the foreground turn finishes, then reports failures too", async () => {
    const f = await fixture();
    const { batch_id } = await f.agent.spawnSubagentBatch({
      origin: "chat",
      conversation_id: "conversation",
      request_id: "original",
      tasks: ["Success", "Failure", "Timeout"].map((goal) => ({
        goal,
        tier: "background",
      })),
    });
    f.sql.exec(
      "UPDATE subagent_tasks SET status='done', result_json=? WHERE goal='Success'",
      JSON.stringify({ text: "Confirmed result" }),
    );
    f.sql.exec(
      "UPDATE subagent_tasks SET status='failed' WHERE goal='Failure'",
    );
    f.sql.exec(
      "UPDATE subagent_tasks SET status='timeout' WHERE goal='Timeout'",
    );
    const frames: any[] = [];
    f.agent.sendToConversation = (_id: string, frame: any) =>
      frames.push(frame);
    f.agent.processingConversations.add("conversation");
    await f.agent.runBatchSynthesis(batch_id);
    expect(frames).toEqual([]);
    expect(
      f.sql
        .exec("SELECT kind FROM scheduled_jobs WHERE kind='batch_synthesis'")
        .toArray(),
    ).toHaveLength(1);
    f.agent.processingConversations.delete("conversation");
    await f.agent.runBatchSynthesis(batch_id);
    const reply = frames.find(
      (frame) => frame.type === "assistant_delta",
    ).content;
    expect(reply).toContain("Confirmed result");
    expect(reply).toContain("couldn't be completed");
    expect(reply).toContain("took too long");
    expect(
      frames.filter((frame) => frame.type === "assistant_end"),
    ).toHaveLength(1);
  });

  it("delivers a terminal synthesis failure as a complete reply", async () => {
    const f = await fixture();
    const { batch_id } = await f.agent.spawnSubagentBatch({
      origin: "chat",
      conversation_id: "conversation",
      request_id: "original",
      tasks: [{ goal: "Research", tier: "background" }],
    });
    const frames: any[] = [];
    f.agent.sendToConversation = (_id: string, frame: any) =>
      frames.push(frame);
    await f.agent.failSubagentBatch(batch_id);
    expect(frames.map((frame) => frame.type)).toEqual([
      "assistant_start",
      "assistant_delta",
      "assistant_end",
      "assistant_message",
      "subagent_batch",
    ]);
    expect(frames[1].content).toContain("could not deliver");
    expect(frames.at(-1).status).toBe("failed");
  });

  it("does not deliver a research reply after Stop", async () => {
    const f = await fixture();
    const { batch_id } = await f.agent.spawnSubagentBatch({
      origin: "chat",
      conversation_id: "conversation",
      request_id: "original",
      tasks: [{ goal: "Research", tier: "background" }],
    });
    f.sql.exec("UPDATE subagent_tasks SET status='done'");
    f.agent.handleCancelTurn("conversation", "original");
    const frames: any[] = [];
    f.agent.sendToConversation = (_id: string, frame: any) =>
      frames.push(frame);
    await f.agent.runBatchSynthesis(batch_id);
    expect(frames).toEqual([]);
    expect(
      f.sql
        .exec("SELECT status FROM subagent_batches WHERE batch_id=?", batch_id)
        .toArray()[0].status,
    ).toBe("cancelled");
  });

  it("retains completed tool effects in durable history when Stop interrupts the next step", async () => {
    const f = await fixture();
    let effects = 0,
      requests = 0;
    f.agent.ensureTools = async () => ({
      effect: tool({
        description: "action",
        inputSchema: z.object({}),
        execute: async () => ({ changed: ++effects }),
      }),
    });
    vi.stubGlobal("fetch", async () => {
      if (++requests === 1)
        return sse(
          [
            {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "effect", arguments: "{}" },
                },
              ],
            },
          ],
          "tool_calls",
        );
      f.agent.handleCancelTurn("conversation", "request");
      throw new DOMException("cancelled", "AbortError");
    });
    await f.agent.handleUserMessage(
      { send: () => {} },
      "conversation",
      "Perform one action",
      undefined,
      "request",
    );
    const rows = f.sql
      .exec("SELECT role,content,tool_calls FROM messages ORDER BY rowid")
      .toArray();
    expect(effects).toBe(1);
    expect(rows.map((r) => r.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(rows.at(-1)?.content).toContain("Stopped");
    expect(rows.filter((r) => r.role === "tool")).toHaveLength(1);
  });
  it("retains an effect that completes after Stop without appending it into a newer turn", async () => {
    const f = await fixture();
    let started!: () => void;
    let complete!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    const release = new Promise<void>((resolve) => (complete = resolve));
    f.agent.ensureTools = async () => ({
      effect: tool({
        description: "action",
        inputSchema: z.object({}),
        execute: async () => {
          started();
          await release;
          return { changed: true };
        },
      }),
    });
    vi.stubGlobal("fetch", async () =>
      sse(
        [
          {
            tool_calls: [
              {
                index: 0,
                id: "late-call",
                type: "function",
                function: { name: "effect", arguments: "{}" },
              },
            ],
          },
        ],
        "tool_calls",
      ),
    );
    const handling = f.agent.handleUserMessage(
      { send: () => {} },
      "conversation",
      "Perform an action",
      undefined,
      "request",
    );
    await entered;
    const pending = f.sql
      .exec("SELECT message_id,content FROM messages WHERE role='tool'")
      .toArray();
    f.agent.handleCancelTurn("conversation", "request");
    f.agent.appendMessage({
      conversationId: "conversation",
      role: "user",
      content: "A newer request",
    });
    complete();
    await handling;
    // The durable invocation exists before the effect completes. Its result
    // is filled in place, so a late response cannot reorder newer history.
    expect(pending).toHaveLength(1);
    const rows = f.sql
      .exec("SELECT message_id,role,content FROM messages ORDER BY rowid")
      .toArray();
    expect(
      JSON.parse(
        String(
          rows.find((row) => row.message_id === pending[0].message_id)?.content,
        ),
      ),
    ).toMatchObject({ type: "text", value: JSON.stringify({ changed: true }) });
    expect(rows.at(-1)?.content).toBe("A newer request");
  });
  it("never recreates a cleared conversation's tool result after late completion", async () => {
    const f = await fixture();
    let started!: () => void, complete!: () => void;
    const entered = new Promise<void>((resolve) => (started = resolve));
    const release = new Promise<void>((resolve) => (complete = resolve));
    f.agent.ensureTools = async () => ({
      effect: tool({
        description: "action",
        inputSchema: z.object({}),
        execute: async () => {
          started();
          await release;
          return { changed: true };
        },
      }),
    });
    vi.stubGlobal("fetch", async () =>
      sse(
        [
          {
            tool_calls: [
              {
                index: 0,
                id: "clear-call",
                type: "function",
                function: { name: "effect", arguments: "{}" },
              },
            ],
          },
        ],
        "tool_calls",
      ),
    );
    const handling = f.agent.handleUserMessage(
      { send: () => {} },
      "conversation",
      "Perform action",
      undefined,
      "request",
    );
    await entered;
    f.agent.handleCancelTurn("conversation", undefined, true);
    f.sql.exec("DELETE FROM messages WHERE conversation_id=?", "conversation");
    complete();
    await handling;
    expect(f.sql.exec("SELECT * FROM messages").toArray()).toEqual([]);
  });
  it("persists one copy of a completed tool exchange and its final answer", async () => {
    const f = await fixture();
    let requests = 0;
    f.agent.ensureTools = async () => ({
      effect: tool({
        description: "action",
        inputSchema: z.object({}),
        execute: async () => ({ changed: true }),
      }),
    });
    vi.stubGlobal("fetch", async () =>
      ++requests === 1
        ? sse(
            [
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "complete-call",
                    type: "function",
                    function: { name: "effect", arguments: "{}" },
                  },
                ],
              },
            ],
            "tool_calls",
          )
        : sse([{ content: "Finished the action" }]),
    );
    await f.agent.handleUserMessage(
      { send: () => {} },
      "conversation",
      "Perform action",
      undefined,
      "request",
    );
    const rows = f.sql
      .exec("SELECT role,content FROM messages ORDER BY rowid")
      .toArray();
    expect(rows.map((row) => row.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(rows.at(-1)?.content).toBe("Finished the action");
    expect(
      f.agent
        .loadRecentMessages("conversation")
        .filter((message: any) => message.role === "tool"),
    ).toHaveLength(1);
  });
  it("recovers admitted tasks with an immediate dispatch job after reconstruction", async () => {
    const f = await fixture();
    f.agent.rearmAlarm = async () => {
      throw new Error("injected crash before dispatch");
    };
    await expect(
      f.agent.spawnSubagentBatch({
        origin: "chat",
        conversation_id: "conversation",
        tasks: [{ goal: "Investigate", tier: "background" }],
      }),
    ).rejects.toThrow();
    expect(f.dispatches).toHaveLength(0);
    const restored = await fixture(f.sql);
    const tasks = f.sql
      .exec("SELECT status,deadline_at FROM subagent_tasks")
      .toArray();
    const jobs = f.sql.exec("SELECT kind,run_at FROM scheduled_jobs").toArray();
    expect(tasks[0].status).toBe("queued");
    expect(
      jobs.some(
        (job) =>
          job.kind === "subagent_dispatch" &&
          Number(job.run_at) < Number(tasks[0].deadline_at),
      ),
    ).toBe(true);
    await restored.agent.runJob({
      job_id: "subagent_dispatch",
      kind: "subagent_dispatch",
      run_at: Date.now(),
      payload_json: null,
      created_at: Date.now(),
    });
    expect(restored.dispatches).toHaveLength(1);
  });
  it("retries an unacknowledged dispatch after reconstruction with the same task identity", async () => {
    const f = await fixture();
    const attempts: string[] = [];
    f.env.RESEARCH_SUBAGENT.get = (id: string) => ({
      fetch: async () => {
        attempts.push(id);
        throw new Error("Temporary transport failure");
      },
    });
    await f.agent.spawnSubagentBatch({
      origin: "chat",
      conversation_id: "conversation",
      tasks: [{ goal: "Investigate", tier: "background" }],
    });
    expect(attempts).toHaveLength(1);
    expect(
      f.sql.exec("SELECT status,attempt FROM subagent_tasks").toArray(),
    ).toEqual([{ status: "dispatched", attempt: 1 }]);
    const restarted = await fixture(f.sql);
    await restarted.agent.runJob({ kind: "subagent_dispatch" });
    expect(restarted.dispatches).toEqual(attempts);
    expect(
      f.sql.exec("SELECT status,attempt FROM subagent_tasks").toArray(),
    ).toEqual([{ status: "running", attempt: 2 }]);
  });
  it("continues bounded dispatch slices without waiting for a child callback", async () => {
    const f = await fixture();
    await f.agent.spawnSubagentBatch({
      origin: "chat",
      conversation_id: "conversation",
      tasks: Array.from({ length: 30 }, (_, i) => ({
        goal: `Research ${i}`,
        tier: "background",
      })),
    });
    expect(f.dispatches).toHaveLength(25);
    expect(
      f.sql
        .exec("SELECT kind FROM scheduled_jobs WHERE kind='subagent_dispatch'")
        .toArray(),
    ).toHaveLength(1);
    await f.agent.runJob({ kind: "subagent_dispatch" });
    expect(f.dispatches).toHaveLength(30);
    expect(new Set(f.dispatches).size).toBe(30);
    expect(
      f.sql
        .exec("SELECT kind FROM scheduled_jobs WHERE kind='subagent_dispatch'")
        .toArray(),
    ).toHaveLength(0);
  });
  it("bounds an unresponsive child dispatch and leaves durable retry intent", async () => {
    const f = await fixture();
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => (started = resolve));
    f.env.RESEARCH_SUBAGENT.get = () => ({
      fetch: () => {
        started();
        return new Promise<Response>(() => {});
      },
    });
    vi.useFakeTimers();
    const spawning = f.agent.spawnSubagentBatch({
      origin: "chat",
      conversation_id: "conversation",
      tasks: [{ goal: "Investigate", tier: "background" }],
    });
    await fetching;
    await vi.advanceTimersByTimeAsync(5001);
    await spawning;
    expect(
      f.sql.exec("SELECT status,attempt FROM subagent_tasks").toArray(),
    ).toEqual([{ status: "dispatched", attempt: 1 }]);
    expect(
      f.sql
        .exec("SELECT kind FROM scheduled_jobs WHERE kind='subagent_dispatch'")
        .toArray(),
    ).toHaveLength(1);
  });
  it("honors Stop while an earlier message waits for authority", async () => {
    const f = await fixture();
    let resolveFirst!: (value: Response) => void;
    let authorizations = 0,
      modelRequests = 0;
    (f.env as any).AUTH = {
      fetch: () =>
        ++authorizations === 1
          ? new Promise<Response>((resolve) => (resolveFirst = resolve))
          : Promise.resolve(
              Response.json({
                userId: "owner",
                workspaceId: "workspace",
                role: "owner",
              }),
            ),
    };
    f.agent.ensureTools = async () => ({});
    const frames: any[] = [];
    f.agent.sendToConversation = (_id: string, frame: any) =>
      frames.push(frame);
    vi.stubGlobal("fetch", async () => {
      modelRequests++;
      return sse([{ content: "Started after Stop" }]);
    });
    const socket = {
      deserializeAttachment: () => ({ conversation_id: "conversation" }),
      send: () => {},
      close: () => {},
    };
    const pending = f.agent.webSocketMessage(
      socket,
      JSON.stringify({
        type: "message",
        content: "Please do this",
        request_id: "request",
      }),
    );
    await f.agent.webSocketMessage(
      socket,
      JSON.stringify({ type: "cancel", request_id: "request" }),
    );
    expect(frames).toEqual([
      expect.objectContaining({ type: "assistant_end", stopped: true }),
    ]);
    resolveFirst(
      Response.json({
        userId: "owner",
        workspaceId: "workspace",
        role: "owner",
      }),
    );
    await pending;
    expect(modelRequests).toBe(0);
    expect(frames.some((frame) => frame.type === "assistant_start")).toBe(
      false,
    );
  });
  it("persists visible fallback and its tool-result anchor after tool-only completion", async () => {
    const sql = createSqliteStorage();
    const store = new ConversationHistoryStore(sql as any);
    store.ensureTables();
    store.ensureConversationRow("conversation");
    store.appendMessage({
      conversationId: "conversation",
      role: "user",
      content: "Do an action",
    });
    const id = store.appendTurnMessages(
      "conversation",
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call",
              toolName: "write_file",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call",
              toolName: "write_file",
              output: {
                type: "json",
                value: {
                  needs_confirmation: true,
                  confirmation_id: "confirmation",
                },
              },
            },
          ],
        },
      ] as any,
      "I ran out of steps",
    );
    const rows = store.loadRecentMessageRows("conversation");
    const frames: any[] = [];
    replayHistory((frame) => frames.push(frame), rows, {
      includeMessageIds: true,
    });
    expect(rows.find((r) => r.message_id === id)?.content).toBe(
      "I ran out of steps",
    );
    expect(frames.filter((f) => f.type === "assistant_message")).toHaveLength(
      1,
    );
    expect(frames.some((f) => f.type === "history_tool_result")).toBe(true);
  });
  it("settles an exhausted dispatch claim on reconstruction without another delivery", async () => {
    const f = await fixture();
    f.env.RESEARCH_SUBAGENT.get = () => ({
      fetch: async () => {
        throw new Error("Unconfirmed delivery");
      },
    });
    await f.agent.spawnSubagentBatch({
      origin: "chat",
      conversation_id: "conversation",
      tasks: [{ goal: "Investigate", tier: "background" }],
    });
    f.sql.exec("UPDATE subagent_tasks SET attempt=3");
    const restarted = await fixture(f.sql);
    await restarted.agent.runJob({ kind: "subagent_dispatch" });
    expect(restarted.dispatches).toEqual([]);
    expect(
      f.sql.exec("SELECT status,attempt FROM subagent_tasks").toArray(),
    ).toEqual([{ status: "failed", attempt: 3 }]);
    expect(
      f.sql
        .exec("SELECT kind FROM scheduled_jobs WHERE kind='batch_synthesis'")
        .toArray(),
    ).toHaveLength(1);
  });
  it("does not republish the stopped tail of a remembered turn forgotten while still running", async () => {
    const f = await fixture();
    Object.assign(f.env, {
      WORKSPACE: createMemoryBucket(),
      AI: { run: async () => ({ data: [Array(1024).fill(0.1)] }) },
      MEMORY_INDEX: {
        upsert: async () => ({ mutationId: "ok" }),
        getByIds: async () => [],
        deleteByIds: async () => ({ mutationId: "ok" }),
      },
    });
    f.agent.getPersonaSettings = () => ({
      memoryEnabled: true,
      enabledTools: null,
      disabledTools: null,
    });
    f.agent.ensureTools = async () =>
      createMemoryTools({
        env: f.env as any,
        sql: f.sql,
        user_id: "owner",
        tenant_binding: "workspace",
        conversation_id: "conversation",
        onForget: () => f.agent.invalidatePendingMemory(),
        getWriteVersion: () => f.agent.memoryWriteEpoch,
        stillValid: () => true,
        onDeletionPending: () => f.agent.queueMemoryDeletionCleanup(),
      });
    let calls = 0;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal("fetch", async () => {
      if (++calls === 1)
        return sse(
          [
            {
              tool_calls: [
                {
                  index: 0,
                  id: "remember-call",
                  type: "function",
                  function: {
                    name: "remember",
                    arguments: JSON.stringify({
                      fact: "Synthetic cobalt preference",
                      scope: "global",
                    }),
                  },
                },
              ],
            },
          ],
          "tool_calls",
        );
      return new Response(
        new ReadableStream({
          start(controller) {
            stream = controller;
            controller.enqueue(
              new TextEncoder().encode(
                "data: " +
                  JSON.stringify({
                    id: "answer",
                    created: 0,
                    model: "test-model",
                    choices: [
                      {
                        index: 0,
                        delta: {
                          content:
                            "I will remember your Synthetic cobalt preference",
                        },
                        finish_reason: null,
                      },
                    ],
                  }) +
                  "\n\n",
              ),
            );
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    const handling = f.agent.handleUserMessage(
      { send: () => {} },
      "conversation",
      "Remember my Synthetic cobalt preference",
      undefined,
      "request",
    );
    await vi.waitFor(() =>
      expect(f.agent.activeTurns.get("conversation")?.text).toContain(
        "Synthetic cobalt",
      ),
    );
    const remembered = f.sql
      .exec("SELECT vector_id FROM memory_index WHERE type='memory'")
      .one();
    expect(
      (await f.agent.handleDeleteMemory(remembered.vector_id)).status,
    ).toBe(200);
    f.agent.handleCancelTurn("conversation", "request");
    stream.close();
    await handling;
    for (let i = 0; i < 20; i++)
      f.agent.appendMessage({
        conversationId: "conversation",
        role: i % 2 ? "assistant" : "user",
        content: "Unrelated later discussion " + i,
      });
    await summarizeConversation({
      env: f.env as any,
      sql: f.sql,
      user_id: "owner",
      tenant_binding: "workspace",
      conversation_id: "conversation",
      batch_size: 20,
    });
    const task = f.sql
      .exec("SELECT request_json FROM housekeeping_tasks WHERE kind='summary'")
      .one();
    expect(task.request_json).not.toContain("Synthetic cobalt");
  });
});

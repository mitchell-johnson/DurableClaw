import { createMemoryTools } from "../src/durable-objects/assistant/tools/memory";
import { recordMemorySourceMessages } from "../src/durable-objects/assistant/memorySources";
import { expect, it, vi } from "vitest";
import { createSqliteStorage } from "./helpers/sqlite";
import { createMemoryBucket } from "./helpers/memoryBucket";
import {
  MEMORY_INDEX_SCHEMA_SQL,
  indexMemory,
  beginForgetAll,
} from "../src/durable-objects/assistant/dreaming";
import { HOUSEKEEPING_SCHEMA_SQL } from "../src/durable-objects/assistant/housekeepingBatch";
import {
  summarizeConversation,
  countMessagesSinceCursor,
  applyConversationSummary,
} from "../src/durable-objects/assistant/summarizer";
import { NanoChatAgent } from "../src/durable-objects/NanoChatAgent";
function fixture() {
  const sql = createSqliteStorage();
  sql.exec(MEMORY_INDEX_SCHEMA_SQL);
  sql.exec(HOUSEKEEPING_SCHEMA_SQL);
  sql.exec(`CREATE TABLE conversations(conversation_id TEXT PRIMARY KEY,summarized_through_message_id TEXT);
 CREATE TABLE messages(message_id TEXT PRIMARY KEY,conversation_id TEXT,role TEXT,content TEXT,vector_id TEXT,created_at INTEGER);
 CREATE TABLE memory_links(vector_id TEXT,entity_type TEXT,entity_id TEXT,conversation_id TEXT,created_at INTEGER);`);
  sql.exec("INSERT INTO conversations VALUES (?,NULL)", "c");
  for (let i = 0; i < 22; i++)
    sql.exec(
      "INSERT INTO messages VALUES (?,?,?,?,?,?)",
      "m" + i,
      "c",
      i % 2 ? "assistant" : "user",
      i < 2
        ? "Synthetic forgotten blue preference"
        : "Generic later discussion",
      i === 1 ? "raw-forgotten" : null,
      i,
    );
  indexMemory(sql, {
    vector_id: "raw-forgotten",
    type: "raw",
    content: "Synthetic forgotten blue preference",
    conversation_id: "c",
  });
  const env: any = {
    WORKSPACE: createMemoryBucket(),
    AI: { run: vi.fn().mockResolvedValue({ data: [Array(1024).fill(0.1)] }) },
    MEMORY_INDEX: {
      upsert: vi.fn().mockResolvedValue({ mutationId: "ok" }),
      getByIds: async () => [],
      deleteByIds: async () => ({ mutationId: "ok" }),
    },
  };
  const agent: any = Object.create(NanoChatAgent.prototype);
  Object.assign(agent, {
    sql,
    env,
    context: { user_id: "owner", tenant_binding: "default" },
    invalidatePendingMemory: () => {},
    queueMemoryDeletionCleanup: () => {},
  });
  return {
    sql,
    env,
    agent,
    user_id: "owner",
    tenant_binding: "default",
    conversation_id: "c",
  };
}
it("individual raw forgetting excludes its full source turn from newly prepared summaries", async () => {
  const f = fixture();
  expect((await f.agent.handleDeleteMemory("raw-forgotten")).status).toBe(200);
  await summarizeConversation({ ...f, batch_size: 20 });
  const task: any = f.sql.exec("SELECT * FROM housekeeping_tasks").one();
  expect(task.request_json).not.toContain("Synthetic forgotten");
  expect(JSON.parse(task.payload_json).messages).toHaveLength(20);
  expect(f.sql.exec("SELECT message_id FROM messages").toArray()).toHaveLength(
    22,
  );
});
it("forget-all excludes all existing transcript sources without erasing the transcript", () => {
  const f = fixture();
  beginForgetAll(f);
  expect(countMessagesSinceCursor(f.sql, "c", null)).toBe(0);
  expect(f.sql.exec("SELECT message_id FROM messages").toArray()).toHaveLength(
    22,
  );
});
it("forgetting a summary excludes its full window including messages that never had raw vectors", async () => {
  const f = fixture();
  await summarizeConversation({ ...f, batch_size: 20 });
  const task: any = f.sql.exec("SELECT * FROM housekeeping_tasks").one();
  const result = await applyConversationSummary({
    ...f,
    payload: JSON.parse(task.payload_json),
    taskId: task.task_id,
    text: "A synthetic summary.",
    stillValid: () => true,
  });
  expect(result.summarized).toBe(true);
  expect(
    (await f.agent.handleDeleteMemory(result.summary_vector_id)).status,
  ).toBe(200);
  f.sql.exec("UPDATE conversations SET summarized_through_message_id=NULL");
  expect(countMessagesSinceCursor(f.sql, "c", null)).toBe(2);
});
it("does not begin automatic publication for a turn admitted before forgetting", async () => {
  const f = fixture();
  Object.assign(f.agent, {
    memoryWriteEpoch: 2,
    getPersonaSettings: () => ({ memoryEnabled: true }),
    getConversationRow: () => ({ conversation_id: "c" }),
    state: { waitUntil: () => {} },
    getWriteVersion: () => 2,
  });
  await f.agent.persistMemoryForTurn({
    conversationId: "c",
    assistantMessageId: "m21",
    memoryEnabled: true,
    memoryEpoch: 1,
    userMessage: "Synthetic old context",
    fullText: "Old result",
    finishReason: "stop",
    toolCallTrace: [],
  });
  expect(f.env.AI.run).not.toHaveBeenCalled();
  expect(f.env.MEMORY_INDEX.upsert).not.toHaveBeenCalled();
});

function rememberFixture() {
  const f = fixture();
  f.sql.exec("DELETE FROM messages");
  f.sql.exec("DELETE FROM memory_index");
  f.sql.exec(
    "INSERT INTO messages VALUES (?,?,?,?,?,?)",
    "original-user",
    "c",
    "user",
    "Remember my blue preference",
    null,
    1,
  );
  return f;
}
it("keeps remember provenance on its original turn when Stop permits a newer request during publication", async () => {
  const f = rememberFixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.env.AI.run = async () => {
    entered();
    await paused;
    return { data: [Array(1024).fill(0.1)] };
  };
  const saving = createMemoryTools(f).remember.execute({
    fact: "Blue preference",
    scope: "global",
  });
  await started;
  // Stop leaves the transcript and allows the next user turn while the admitted tool finishes.
  f.sql.exec(
    "INSERT INTO messages VALUES (?,?,?,?,?,?)",
    "original-stop",
    "c",
    "assistant",
    "Stopped",
    null,
    2,
  );
  f.sql.exec(
    "INSERT INTO messages VALUES (?,?,?,?,?,?)",
    "next-user",
    "c",
    "user",
    "Unrelated request",
    null,
    3,
  );
  release();
  const saved = JSON.parse(await saving);
  const sources = f.sql
    .exec(
      "SELECT message_id FROM memory_source_messages WHERE vector_id=?",
      saved.vector_id,
    )
    .toArray()
    .map((row) => row.message_id);
  expect(sources).toContain("original-user");
  expect(sources).not.toContain("next-user");
  expect((await f.agent.handleDeleteMemory(saved.vector_id)).status).toBe(200);
  const excluded = f.sql
    .exec("SELECT message_id FROM memory_excluded_messages")
    .toArray()
    .map((row) => row.message_id);
  expect(excluded).toContain("original-user");
  expect(excluded).not.toContain("next-user");
});
it.each([false, true])(
  "forgetting an explicit memory excludes its later reply and preserves unrelated turns (raw copy: %s)",
  async (hasRaw) => {
    const f = rememberFixture();
    const saved = JSON.parse(
      await createMemoryTools(f).remember.execute({
        fact: "Blue preference",
        scope: "global",
      }),
    );
    f.sql.exec(
      "INSERT INTO messages VALUES (?,?,?,?,?,?)",
      "original-answer",
      "c",
      "assistant",
      "I will remember your blue preference",
      hasRaw ? "raw-turn" : null,
      2,
    );
    f.sql.exec(
      "INSERT INTO messages VALUES (?,?,?,?,?,?)",
      "next-user",
      "c",
      "user",
      "Unrelated request",
      null,
      3,
    );
    f.sql.exec(
      "INSERT INTO messages VALUES (?,?,?,?,?,?)",
      "next-answer",
      "c",
      "assistant",
      "Unrelated response",
      null,
      4,
    );
    if (hasRaw) {
      indexMemory(f.sql, {
        vector_id: "raw-turn",
        type: "raw",
        content: "Blue preference",
        conversation_id: "c",
      });
      recordMemorySourceMessages(f.sql, "raw-turn", [
        "original-user",
        "original-answer",
      ]);
    }
    indexMemory(f.sql, {
      vector_id: "overlapping-summary",
      type: "summary",
      content: "Combined old and new turns",
      conversation_id: "c",
    });
    recordMemorySourceMessages(f.sql, "overlapping-summary", [
      "original-user",
      "original-answer",
      "next-user",
      "next-answer",
    ]);
    expect((await f.agent.handleDeleteMemory(saved.vector_id)).status).toBe(
      200,
    );
    expect(
      f.sql
        .exec(
          "SELECT message_id FROM memory_excluded_messages ORDER BY message_id",
        )
        .toArray(),
    ).toEqual([
      { message_id: "original-answer" },
      { message_id: "original-user" },
    ]);
    expect(countMessagesSinceCursor(f.sql, "c", null)).toBe(2);
    expect(f.sql.exec("SELECT vector_id FROM memory_index").toArray()).toEqual(
      [],
    );
    expect(
      f.sql.exec("SELECT message_id FROM messages").toArray(),
    ).toHaveLength(4);
  },
);

it("inherits excluded user anchors for late rows with equal timestamps and respects the next user boundary", async () => {
  const f = rememberFixture();
  const saved = JSON.parse(
    await createMemoryTools(f).remember.execute({
      fact: "Blue preference",
      scope: "global",
    }),
  );
  await f.agent.handleDeleteMemory(saved.vector_id);
  for (const [id, role] of [
    ["late-answer", "assistant"],
    ["next-user", "user"],
    ["next-answer", "assistant"],
  ])
    f.sql.exec(
      "INSERT INTO messages VALUES (?,?,?,?,?,?)",
      id,
      "c",
      role,
      "Later text",
      null,
      1,
    );
  expect(countMessagesSinceCursor(f.sql, "c", null)).toBe(2);
  expect(countMessagesSinceCursor(f.sql, "c", "original-user")).toBe(2);
});

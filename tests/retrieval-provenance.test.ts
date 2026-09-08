import { describe, expect, it, vi } from "vitest";
import { createRetrievalTools } from "../src/action-library/tools/retrieval";
import { extractEntities } from "../src/durable-objects/assistant/entityExtraction";
import { writeToolCallMemory } from "../src/durable-objects/assistant/memory";
import { MEMORY_INDEX_SCHEMA_SQL } from "../src/durable-objects/assistant/dreaming";
import { createSqliteStorage } from "./helpers/sqlite";
import { createMemoryBucket } from "./helpers/memoryBucket";
import { workspacePrefix } from "../src/storage/workspace";
import { buildNamespace } from "../src/utils/memoryClient";

describe("retrieval provenance from actual tool outputs", () => {
  it.each(["search_records", "search_vectors"])(
    "preserves explicit references and useful metadata from %s through persisted memory links",
    async (name) => {
      const bucket = createMemoryBucket();
      const path = "notes/research.md";
      await bucket.put(
        workspacePrefix("owner", "default") + path,
        "document body",
      );
      const env = {
        AGENT_TOKEN: "test-only",
        WORKSPACE: bucket,
        AI: {
          run: vi.fn().mockResolvedValue({ data: [Array(1024).fill(0.1)] }),
        },
        MEMORY_INDEX: {
          upsert: vi.fn().mockResolvedValue({ mutationId: "accepted" }),
        },
        DOCUMENT_INDEX: {
          query: vi.fn().mockResolvedValue({
            matches: [
              {
                id: "vector-doc",
                score: 0.876543,
                metadata: {
                  path,
                  text: "Relevant document excerpt",
                  user_namespace: buildNamespace("owner", "default"),
                },
              },
            ],
          }),
        },
      } as any;
      const tool = createRetrievalTools({
        env,
        tenantBinding: "default",
        tenantDB: {} as any,
        principal: { userId: "owner", userRole: "owner", permissions: [] },
        telemetryTag: "test",
      })[name];
      const output = await (tool.execute as any)({ query: "research" });
      expect(extractEntities(name, {}, output)).toEqual([
        { entity_type: "file", entity_id: path },
      ]);
      const result = JSON.parse(output);
      if (name === "search_vectors")
        expect(result[0].metadata.text).toBe("Relevant document excerpt");
      else expect(result[0].metadata.name).toBe(path);
      const sql = createSqliteStorage();
      sql.exec(MEMORY_INDEX_SCHEMA_SQL);
      sql.exec(
        "CREATE TABLE memory_links (vector_id TEXT, entity_type TEXT, entity_id TEXT, conversation_id TEXT, created_at INTEGER, PRIMARY KEY (vector_id, entity_type, entity_id))",
      );
      await writeToolCallMemory(env, sql, {
        user_message: "Find research notes",
        user_id: "owner",
        tenant_binding: "default",
        conversation_id: "conversation",
        tool_name: name,
        tool_args: { query: "research" },
        tool_output: output,
      });
      expect(
        sql.exec("SELECT entity_type, entity_id FROM memory_links").toArray(),
      ).toEqual([{ entity_type: "file", entity_id: path }]);
    },
  );
});

import { expect, it } from "vitest";
import { GroupMemory } from "../../src/agent/memory";
import { createSqliteStorage } from "../helpers/sqlite";
it("preserves reserved JavaScript property names in legacy saved memories", () => {
  const sql = createSqliteStorage();
  sql.exec(
    "CREATE TABLE group_memory (key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)",
  );
  const memory = new GroupMemory(sql as any);
  memory.set("__proto__", "A saved fact");
  memory.set("constructor", "Another saved fact");
  expect(Object.entries(memory.getAll())).toEqual([
    ["__proto__", "A saved fact"],
    ["constructor", "Another saved fact"],
  ]);
  expect(memory.getContext()).toContain("__proto__: A saved fact");
});

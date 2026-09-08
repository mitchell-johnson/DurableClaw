import { expect, it } from "vitest";
import { mcpToolId } from "../src/durable-objects/assistant/mcpToolId";
it("keeps remote names provider-safe without ambiguous tuple collisions", () => {
  const id = mcpToolId("s".repeat(128), "namespace." + "t".repeat(128));
  expect(id.length).toBeLessThanOrEqual(64);
  expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  expect(mcpToolId("a_b", "c")).not.toBe(mcpToolId("a", "b_c"));
  expect(mcpToolId("s", "read.file")).not.toBe(mcpToolId("s", "read_file"));
  expect(mcpToolId("s", "read.file")).toBe(mcpToolId("s", "read.file"));
});

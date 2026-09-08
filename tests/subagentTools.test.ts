import { afterEach, describe, expect, it, vi } from "vitest";
import * as retrieval from "../src/action-library/tools/retrieval";
import {
  buildSubagentToolset,
  SUBAGENT_TOOL_IDS,
} from "../src/durable-objects/assistant/subagentTools";
const context = {
  env: {},
  principal: { userId: "user" },
  tenantBinding: "workspace",
  telemetryTag: "research",
} as any;
afterEach(() => vi.restoreAllMocks());
describe("child capability boundary", () => {
  it("fails closed without an authorized retrieval context", () => {
    expect(buildSubagentToolset({})).toEqual({});
  });
  it("exposes the complete read-only surface and no delegation or write tools", () => {
    const tools = buildSubagentToolset({ retrievalContext: context });
    expect(Object.keys(tools).sort()).toEqual([...SUBAGENT_TOOL_IDS].sort());
    for (const tool of Object.values(tools))
      expect(typeof tool.execute).toBe("function");
    expect(SUBAGENT_TOOL_IDS).not.toContain("spawn_subagents");
  });
  it("rejects mutations even when a factory accidentally publishes additional capabilities", () => {
    vi.spyOn(retrieval, "createRetrievalTools").mockReturnValue({
      search_records: { execute: async () => "safe" },
      write_file: { execute: async () => "unsafe" },
      spawn_subagents: { execute: async () => "unsafe" },
    } as any);
    const tools = buildSubagentToolset({ retrievalContext: context });
    expect(tools).toHaveProperty("search_records");
    expect(tools).not.toHaveProperty("write_file");
    expect(tools).not.toHaveProperty("spawn_subagents");
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createSubagentTools,
  MAX_TASKS_PER_CALL,
} from "../src/durable-objects/assistant/tools/subagents";
describe("conversation-bound research delegation", () => {
  it("binds spawning to the conversation for which the tool was created", async () => {
    const spawn = vi.fn(async () => ({ batch_id: "batch", queued: 1 }));
    const one = createSubagentTools({ spawn, conversation_id: "one" });
    const two = createSubagentTools({ spawn, conversation_id: "two" });
    await two.spawn_subagents.execute({ tasks: [{ goal: "Second request" }] });
    await one.spawn_subagents.execute({
      tasks: [{ goal: "First request", tier: "" }],
    });
    expect(spawn.mock.calls.map((call) => call[0])).toEqual([
      {
        origin: "chat",
        conversation_id: "two",
        tasks: [{ goal: "Second request", tier: "background" }],
      },
      {
        origin: "chat",
        conversation_id: "one",
        tasks: [{ goal: "First request", tier: "background" }],
      },
    ]);
  });
  it.each([
    {},
    { tasks: null },
    { tasks: "task" },
    { tasks: [] },
    { tasks: [null] },
    { tasks: [{ goal: 42 }] },
    { tasks: [{ goal: "   " }] },
    { tasks: [{ goal: "Research", tier: "unknown" }] },
    { tasks: [{ goal: "x".repeat(32_001) }] },
    {
      tasks: Array.from({ length: MAX_TASKS_PER_CALL + 1 }, () => ({
        goal: "Research",
      })),
    },
  ])(
    "rejects malformed and unbounded requests before spawning",
    async (input) => {
      const spawn = vi.fn(async () => ({ batch_id: "batch", queued: 1 }));
      expect(
        await createSubagentTools({ spawn }).spawn_subagents.execute(input),
      ).toMatch(/^Error:/);
      expect(spawn).not.toHaveBeenCalled();
    },
  );
});

import { describe, it, expect } from "vitest";
import { replayHistory } from "../../src/agent-core/replay";
import type { AgentMessageRow } from "../../src/agent-core/history";

function row(partial: Partial<AgentMessageRow>): AgentMessageRow {
  return {
    message_id: crypto.randomUUID(),
    conversation_id: "c1",
    role: "user",
    content: "",
    tool_calls: null,
    tool_call_id: null,
    tool_name: null,
    vector_id: null,
    created_at: Date.now(),
    ...partial,
  };
}

describe("agent-core replayHistory", () => {
  it("replays user and assistant messages in order", () => {
    const frames: any[] = [];
    replayHistory(
      (f) => frames.push(f),
      [
        row({ role: "user", content: "q1" }),
        row({ role: "assistant", content: "a1" }),
      ],
    );
    expect(frames).toEqual([
      { type: "history_user_message", content: "q1" },
      { type: "assistant_message", content: "a1" },
    ]);
  });

  it("attaches tool results to the owning assistant turn index", () => {
    const frames: any[] = [];
    replayHistory(
      (f) => frames.push(f),
      [
        row({ role: "user", content: "q1" }), // client index 0
        row({ role: "assistant", content: "a1" }), // client index 1
        row({ role: "tool", content: '{"x":1}', tool_name: "get_schema" }),
      ],
    );
    const toolFrame = frames.find((f) => f.type === "history_tool_result");
    expect(toolFrame).toMatchObject({
      turn: 1,
      toolName: "get_schema",
      rawJson: '{"x":1}',
    });
  });

  it("drops orphan tool rows that precede any assistant turn", () => {
    const frames: any[] = [];
    replayHistory(
      (f) => frames.push(f),
      [row({ role: "tool", content: '{"x":1}', tool_name: "get_schema" })],
    );
    expect(frames).toEqual([]);
  });

  it("points a leading pure tool-call step at the index its text will occupy", () => {
    // The turn opened with tool calls and has not produced text yet, so the
    // assistant bubble the widgets belong to is the NEXT client index (1),
    // not the user message at 0.
    const frames: any[] = [];
    replayHistory(
      (f) => frames.push(f),
      [
        row({ role: "user", content: "q1" }), // index 0
        row({ role: "assistant", content: "" }), // pure tool-call step
        row({ role: "tool", content: '{"x":1}', tool_name: "get_schema" }),
      ],
    );
    const toolFrame = frames.find((f) => f.type === "history_tool_result");
    expect(toolFrame.turn).toBe(1);
  });

  it("keeps a trailing pure tool-call step attached to the turn that already produced text", () => {
    const frames: any[] = [];
    replayHistory(
      (f) => frames.push(f),
      [
        row({ role: "user", content: "q1" }), // index 0
        row({ role: "assistant", content: "a1" }), // index 1 — the bubble
        row({ role: "assistant", content: "" }), // pure tool-call step, same turn
        row({ role: "tool", content: '{"x":1}', tool_name: "get_schema" }),
      ],
    );
    const toolFrame = frames.find((f) => f.type === "history_tool_result");
    expect(toolFrame.turn).toBe(1);
  });

  it("opts into durable message identities without changing tool indices", () => {
    const frames: any[] = [];
    replayHistory(
      (frame) => frames.push(frame),
      [
        row({ message_id: "user-id", role: "user", content: "Research" }),
        row({ message_id: "answer-id", role: "assistant", content: "Answer" }),
        row({ role: "tool", content: "{}", tool_name: "search_records" }),
      ],
      { includeMessageIds: true },
    );
    expect(frames).toEqual([
      {
        type: "history_user_message",
        content: "Research",
        message_id: "user-id",
      },
      { type: "assistant_message", content: "Answer", message_id: "answer-id" },
      {
        type: "history_tool_result",
        turn: 1,
        toolName: "search_records",
        rawJson: "{}",
      },
    ]);
  });

  it("replays stopped metadata once while preserving literal marker text elsewhere", () => {
    const frames: any[] = [];
    replayHistory(
      (frame) => frames.push(frame),
      [
        row({
          message_id: "partial",
          role: "assistant",
          content: "Partial answer\n\n_(Stopped)_",
        }),
        row({
          message_id: "empty-stop",
          role: "assistant",
          content: "\n\n_(Stopped)_",
        }),
        row({
          message_id: "literal",
          role: "assistant",
          content: "Mention _(Stopped)_ in prose.",
        }),
      ],
      { includeMessageIds: true },
    );
    expect(frames).toEqual([
      {
        type: "assistant_message",
        content: "Partial answer",
        message_id: "partial",
        stopped: true,
      },
      {
        type: "assistant_message",
        content: "",
        message_id: "empty-stop",
        stopped: true,
      },
      {
        type: "assistant_message",
        content: "Mention _(Stopped)_ in prose.",
        message_id: "literal",
      },
    ]);
    const legacy: any[] = [];
    replayHistory(
      (frame) => legacy.push(frame),
      [row({ role: "assistant", content: "Partial\n\n_(Stopped)_" })],
    );
    expect(legacy).toEqual([
      { type: "assistant_message", content: "Partial\n\n_(Stopped)_" },
    ]);
  });
});

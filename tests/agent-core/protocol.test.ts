/**
 * The frame-type constant is only worth anything if it actually describes
 * what the kernel emits. Rather than restate the list (which would pass by
 * construction), these tests drive the two real producers — `runAgentTurn`
 * and `replayHistory` — through capturing sinks and check every frame they
 * emit is a declared type.
 *
 * One-directional on purpose: a declared type with no producer here is fine
 * (`ready` and `cleared` are sent by the DO itself, and domain flows add
 * frames of their own), so this asserts "nothing undeclared escapes", not
 * "everything declared is used".
 */
import { describe, it, expect, vi } from "vitest";

const runToolLoopMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/action-library/loop", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/action-library/loop")>();
  return { ...actual, runToolLoop: runToolLoopMock };
});

import { CORE_SERVER_FRAME_TYPES } from "../../src/agent-core/protocol";
import { runAgentTurn } from "../../src/agent-core/turn";
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

const declared: readonly string[] = CORE_SERVER_FRAME_TYPES;

describe("agent-core protocol", () => {
  it("every frame runAgentTurn emits is a declared server frame type", async () => {
    runToolLoopMock.mockImplementation(async (p: any) => {
      p.onEvent({ type: "text_delta", content: "hi" });
      p.onEvent({
        type: "tool_call",
        toolName: "get_schema",
        toolCallId: "c1",
      });
      p.onEvent({
        type: "tool_result",
        toolName: "get_schema",
        toolCallId: "c1",
        output: {},
        rawJson: "{}",
      });
      return {
        text: "",
        finishReason: "tool-calls",
        toolCalls: [],
        responseMessages: [],
        usage: null,
        chunkCount: 0,
      };
    });

    const frames: any[] = [];
    await runAgentTurn({
      env: {} as any,
      model: "test-model",
      system: "sys",
      messages: [],
      tools: {},
      maxSteps: 5,
      telemetryTag: "test",
      emit: (f) => frames.push(f),
    });

    // Covers the fallback delta too, since the loop above returns no text.
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(declared).toContain(frame.type);
    }
  });

  it("every frame replayHistory emits is a declared server frame type", () => {
    const frames: any[] = [];
    replayHistory(
      (f) => frames.push(f),
      [
        row({ role: "user", content: "q1" }),
        row({ role: "assistant", content: "a1" }),
        row({ role: "tool", content: '{"x":1}', tool_name: "get_schema" }),
      ],
    );

    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(declared).toContain(frame.type);
    }
  });
});

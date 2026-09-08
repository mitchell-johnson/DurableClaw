import { describe, it, expect, vi, beforeEach } from "vitest";

const runToolLoopMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/action-library/loop", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/action-library/loop")>();
  return { ...actual, runToolLoop: runToolLoopMock };
});

import { runAgentTurn } from "../../src/agent-core/turn";

function loopResult(partial: Record<string, unknown> = {}) {
  return {
    text: "",
    finishReason: "stop",
    toolCalls: [],
    responseMessages: [],
    usage: null,
    chunkCount: 0,
    ...partial,
  };
}

const baseParams = () => ({
  env: {} as any,
  model: "test-model",
  system: "sys",
  messages: [],
  tools: {},
  maxSteps: 5,
  telemetryTag: "test",
});

describe("runAgentTurn", () => {
  // Block body, deliberately: a concise arrow would RETURN the mock (mockReset
  // is chainable), and vitest treats a function returned from beforeEach as a
  // teardown hook — it would then call the mock with zero arguments after each
  // test, running whatever implementation the test installed with an undefined
  // params object.
  beforeEach(() => {
    runToolLoopMock.mockReset();
  });

  it("brackets the turn with assistant_start / assistant_end and maps deltas", async () => {
    runToolLoopMock.mockImplementation(async (p: any) => {
      p.onEvent({ type: "text_delta", content: "hel" });
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
      p.onEvent({ type: "text_delta", content: "lo" });
      return loopResult({ text: "hello" });
    });
    const frames: any[] = [];
    const result = await runAgentTurn({
      ...baseParams(),
      emit: (f) => frames.push(f),
    });
    expect(frames.map((f) => f.type)).toEqual([
      "assistant_start",
      "assistant_delta",
      "tool_call",
      "tool_result",
      "assistant_delta",
      "assistant_end",
    ]);
    expect(frames[2]).toMatchObject({
      toolName: "get_schema",
      toolCallId: "c1",
    });
    expect(result.fullText).toBe("hello");
  });

  it("emits the default fallback for an empty non-stop turn", async () => {
    runToolLoopMock.mockResolvedValue(
      loopResult({ text: "", finishReason: "tool-calls" }),
    );
    const frames: any[] = [];
    const result = await runAgentTurn({
      ...baseParams(),
      emit: (f) => frames.push(f),
    });
    const delta = frames.find((f) => f.type === "assistant_delta");
    expect(delta.content).toContain("ran out of steps");
    expect(result.fullText).toBe(delta.content);
  });

  it("suppresses the fallback when fallbackText returns null", async () => {
    runToolLoopMock.mockResolvedValue(
      loopResult({ text: "", finishReason: "tool-calls" }),
    );
    const frames: any[] = [];
    const result = await runAgentTurn({
      ...baseParams(),
      emit: (f) => frames.push(f),
      fallbackText: () => null,
    });
    expect(frames.map((f) => f.type)).toEqual([
      "assistant_start",
      "assistant_end",
    ]);
    expect(result.fullText).toBe("");
  });

  it("uses a custom fallback string when provided", async () => {
    runToolLoopMock.mockResolvedValue(
      loopResult({ text: "", finishReason: "error" }),
    );
    const frames: any[] = [];
    const result = await runAgentTurn({
      ...baseParams(),
      emit: (f) => frames.push(f),
      fallbackText: () => "custom fallback",
    });
    expect(result.fullText).toBe("custom fallback");
    expect(frames.find((f) => f.type === "assistant_delta").content).toBe(
      "custom fallback",
    );
  });

  it("does not emit a fallback when the turn produced text, whatever the finish reason", async () => {
    // A step-capped turn that still said something needs no apology bolted
    // onto the end of it — the fallback is for SILENT turns only.
    runToolLoopMock.mockResolvedValue(
      loopResult({ text: "here is what I found", finishReason: "tool-calls" }),
    );
    const frames: any[] = [];
    const result = await runAgentTurn({
      ...baseParams(),
      emit: (f) => frames.push(f),
    });
    expect(frames.map((f) => f.type)).toEqual([
      "assistant_start",
      "assistant_end",
    ]);
    expect(result.fullText).toBe("here is what I found");
  });

  it("forwards the turn configuration through to runToolLoop", async () => {
    runToolLoopMock.mockResolvedValue(loopResult({ text: "ok" }));
    const stopWhen = [() => true] as any;
    const controller = new AbortController();
    const messages = [{ role: "user", content: "hi" }] as any;
    const tools = { get_schema: {} } as any;

    await runAgentTurn({
      ...baseParams(),
      system: "the system prompt",
      messages,
      tools,
      maxSteps: 9,
      stopWhen,
      abortSignal: controller.signal,
      emit: () => {},
    });

    expect(runToolLoopMock.mock.calls[0][0]).toMatchObject({
      system: "the system prompt",
      messages,
      tools,
      maxSteps: 9,
      stopWhen,
      abortSignal: controller.signal,
    });
  });

  it("does not emit a fallback when finishReason is stop", async () => {
    runToolLoopMock.mockResolvedValue(
      loopResult({ text: "", finishReason: "stop" }),
    );
    const frames: any[] = [];
    const result = await runAgentTurn({
      ...baseParams(),
      emit: (f) => frames.push(f),
    });
    expect(frames.map((f) => f.type)).toEqual([
      "assistant_start",
      "assistant_end",
    ]);
    expect(result.fullText).toBe("");
  });

  it("forwards raw events to onEvent after frame emission", async () => {
    runToolLoopMock.mockImplementation(async (p: any) => {
      p.onEvent({
        type: "tool_result",
        toolName: "get_schema",
        output: { tables: [] },
        rawJson: '{"tables":[]}',
      });
      return loopResult({ text: "ok" });
    });
    const seen: any[] = [];
    await runAgentTurn({
      ...baseParams(),
      emit: () => {},
      onEvent: (e) => seen.push(e),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].output).toEqual({ tables: [] });
  });
});

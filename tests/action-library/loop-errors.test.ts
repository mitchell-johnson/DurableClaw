import { afterEach, describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import { CHAT_MODEL } from "../../src/config";
import { runToolLoop } from "../../src/action-library/loop";

vi.mock("../../src/telemetry/logger", () => ({ logError: vi.fn() }));
const params = {
  env: { OPENROUTER_API_KEY: "test-key", CHAT_MODEL: "unit-test-model" } as any,
  model: CHAT_MODEL,
  system: "Research",
  messages: [{ role: "user" as const, content: "Find records" }],
  tools: {},
  maxSteps: 2,
};
function sse(
  deltas: Record<string, unknown>[],
  finish = "stop",
  error?: string,
) {
  const lines = deltas.map((delta) => ({
    id: "completion",
    created: 0,
    model: CHAT_MODEL,
    choices: [{ index: 0, delta, finish_reason: null }],
  }));
  const tail = error
    ? {
        error: {
          message: error,
          type: "server_error",
          code: "provider_failure",
        },
      }
    : {
        id: "completion",
        created: 0,
        model: CHAT_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
      };
  return new Response(
    [...lines, tail]
      .map((line) => `data: ${JSON.stringify(line)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}
afterEach(() => vi.unstubAllGlobals());
describe("real SDK generation failure propagation", () => {
  it.each(["", "Partial answer"])(
    "rejects a provider EOF without a completion marker after %j",
    async (text) => {
      const deltas: Record<string, unknown>[] = [{ role: "assistant" }];
      if (text) deltas.push({ content: text });
      const body = deltas
        .map(
          (delta) =>
            `data: ${JSON.stringify({
              id: "incomplete",
              created: 0,
              model: CHAT_MODEL,
              choices: [{ index: 0, delta, finish_reason: null }],
            })}\n\n`,
        )
        .join("");
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(body, {
            headers: { "Content-Type": "text/event-stream" },
          }),
      );
      await expect(runToolLoop(params)).rejects.toMatchObject({
        name: "ToolLoopGenerationError",
        partialResult: { text, finishReason: "error" },
      });
    },
  );

  it("rejects an upstream HTTP failure instead of reporting successful empty research", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json(
        { error: { message: "invalid key", type: "authentication_error" } },
        { status: 401 },
      ),
    );
    await expect(runToolLoop(params)).rejects.toMatchObject({
      name: "ToolLoopGenerationError",
      partialResult: { text: "", finishReason: "error" },
    });
  });
  it("retains partial text when a provider stream fails", async () => {
    vi.stubGlobal("fetch", async () =>
      sse([{ content: "One record found" }], "stop", "upstream interrupted"),
    );
    await expect(runToolLoop(params)).rejects.toMatchObject({
      name: "ToolLoopGenerationError",
      partialResult: { text: "One record found", finishReason: "error" },
    });
  });
  it("retains completed tool output when the next provider step fails", async () => {
    let calls = 0;
    const execute = vi.fn(async () => ({ count: 1 }));
    vi.stubGlobal("fetch", async () =>
      ++calls === 1
        ? sse(
            [
              {
                tool_calls: [
                  {
                    index: 0,
                    id: "call-1",
                    type: "function",
                    function: { name: "inspect", arguments: "{}" },
                  },
                ],
              },
            ],
            "tool_calls",
          )
        : Response.json(
            { error: { message: "invalid key", type: "authentication_error" } },
            { status: 401 },
          ),
    );
    await expect(
      runToolLoop({
        ...params,
        tools: { inspect: tool({ inputSchema: z.object({}), execute }) },
      }),
    ).rejects.toMatchObject({
      name: "ToolLoopGenerationError",
      partialResult: {
        toolCalls: [{ toolName: "inspect", output: { count: 1 } }],
      },
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("allows a genuinely empty completed response", async () => {
    vi.stubGlobal("fetch", async () => sse([]));
    await expect(runToolLoop(params)).resolves.toMatchObject({
      text: "",
      finishReason: "stop",
    });
  });
  it("preserves step exhaustion as an incomplete successful generation", async () => {
    vi.stubGlobal("fetch", async () =>
      sse(
        [
          {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: { name: "inspect", arguments: "{}" },
              },
            ],
          },
        ],
        "tool_calls",
      ),
    );
    await expect(
      runToolLoop({
        ...params,
        maxSteps: 1,
        tools: {
          inspect: tool({
            inputSchema: z.object({}),
            execute: async () => ({ count: 1 }),
          }),
        },
      }),
    ).resolves.toMatchObject({ text: "", finishReason: "tool-calls" });
  });
  it("keeps a caller abort distinguishable from a provider error", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Cancelled", "AbortError"));
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      runToolLoop({ ...params, abortSignal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("preserves caller cancellation after partial streaming text", async () => {
    const controller = new AbortController();
    const partial: string[] = [];
    vi.stubGlobal("fetch", async () =>
      sse([{ content: "Partial answer" }, { content: "should stop" }]),
    );
    await expect(
      runToolLoop({
        ...params,
        abortSignal: controller.signal,
        onEvent: (event) => {
          if (event.type === "text_delta") {
            partial.push(event.content);
            controller.abort(new DOMException("Cancelled", "AbortError"));
          }
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(partial[0]).toBe("Partial answer");
  });
});

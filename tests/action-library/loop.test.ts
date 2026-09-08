/**
 * Shared tool-loop tests.
 *
 * The loop is driven by a scripted fake model rather than a real provider, so
 * these pin the behaviours that are easy to get subtly wrong and expensive to
 * discover in production:
 *
 *   - a tool returning a value does NOT end an AI SDK loop (stop conditions do)
 *   - events reach the caller in order, so a WS UI can narrate the turn
 *   - tool calls are paired with their results for post-turn memory writes
 *   - a step-capped turn produces a usable message rather than silence
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const streamTextMock = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (...args: unknown[]) => streamTextMock(...args),
  };
});

vi.mock("../../src/utils/aiProvider", () => ({
  createAISDKProvider: vi.fn(() => ({ chat: (m: string) => ({ modelId: m }) })),
}));

import {
  runToolLoop,
  finishReasonFallback,
  createStreamNormalizingProvider,
} from "../../src/action-library/loop";
import type { ToolLoopEvent } from "../../src/action-library/loop";
import { CHAT_MODEL } from "../../src/config";

/**
 * Build a fake `streamText` return value. `onStepFinish` is invoked with the
 * scripted steps so the loop's pairing/event logic runs for real.
 */
function scriptModel(options: {
  chunks?: string[];
  steps?: Array<{ toolCalls?: any[]; toolResults?: any[] }>;
  finishReason?: string;
  usage?: { inputTokens: number; outputTokens: number };
  totalUsage?: { inputTokens: number; outputTokens: number };
}) {
  streamTextMock.mockImplementation((config: any) => {
    for (const step of options.steps ?? []) {
      config.onStepFinish?.(step);
    }
    const usage = options.usage ?? { inputTokens: 10, outputTokens: 5 };
    return {
      textStream: (async function* () {
        for (const c of options.chunks ?? []) yield c;
      })(),
      response: Promise.resolve({
        messages: [{ role: "assistant", content: "x" }],
      }),
      finishReason: Promise.resolve(options.finishReason ?? "stop"),
      // `usage` and `totalUsage` are DIFFERENT quantities in the AI SDK:
      // `usage` is the LAST step's, `totalUsage` is the sum across steps
      // (ai@6 `index.d.ts`: "The token usage of the last step" vs "the sum of
      // all step usages"). A fake that returns one object for both makes them
      // indistinguishable and hides which one the loop reads — which is how a
      // multi-step turn came to report only its final step's tokens.
      usage: Promise.resolve(usage),
      totalUsage: Promise.resolve(options.totalUsage ?? usage),
    };
  });
}

const baseParams = {
  env: { OPENROUTER_API_KEY: "sk-or-test" } as any,
  model: CHAT_MODEL,
  system: "you are a test",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: {},
  maxSteps: 6,
};

beforeEach(() => vi.clearAllMocks());

describe("runToolLoop", () => {
  it.each(["foreground", "background"] as const)(
    "passes the %s request purpose to its provider",
    async (purpose) => {
      scriptModel({ chunks: ["done"] });
      await runToolLoop({ ...baseParams, purpose });
      const { createAISDKProvider } =
        await import("../../src/utils/aiProvider");
      expect(createAISDKProvider).toHaveBeenCalledWith(
        baseParams.env,
        expect.objectContaining({ purpose }),
      );
    },
  );

  it("streams text and reports usage", async () => {
    scriptModel({
      chunks: ["Hel", "lo"],
      usage: { inputTokens: 42, outputTokens: 7 },
    });

    const result = await runToolLoop(baseParams);

    expect(result.text).toBe("Hello");
    expect(result.chunkCount).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 7 });
  });

  // `usage` is documented as the LAST step's tokens; `totalUsage` is the sum
  // across steps. Reading the wrong one silently under-reports every
  // multi-step turn by (steps-1)/steps — and `ToolLoopResult.usage` feeds
  // DurableClaw's `gen_ai.usage.cost_usd` and semantic search's `search.baseline`
  // token keys, the latter being the Phase 4 acceptance gate against a
  // pre-cutover metric that explicitly SUMMED both of its LLM calls.
  it("reports the loop total, not just the final step", async () => {
    scriptModel({
      chunks: ["done"],
      usage: { inputTokens: 6000, outputTokens: 800 },
      totalUsage: { inputTokens: 9000, outputTokens: 1000 },
    });

    const result = await runToolLoop(baseParams);

    expect(result.usage).toEqual({ inputTokens: 9000, outputTokens: 1000 });
  });

  it("falls back to last-step usage when the provider omits a total", async () => {
    // `totalUsage` is a v6 field. A provider or a stub that predates it must
    // degrade to a number rather than to null.
    streamTextMock.mockImplementation(() => ({
      textStream: (async function* () {
        yield "hi";
      })(),
      response: Promise.resolve({ messages: [] }),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve({ inputTokens: 11, outputTokens: 3 }),
    }));

    const result = await runToolLoop(baseParams);

    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
  });

  it("emits events in order for a tool-calling turn", async () => {
    scriptModel({
      chunks: ["done"],
      steps: [
        {
          toolCalls: [
            {
              toolName: "search_vectors",
              toolCallId: "t1",
              input: { query: "x" },
            },
          ],
          toolResults: [
            {
              toolName: "search_vectors",
              toolCallId: "t1",
              output: '{"results":[]}',
            },
          ],
        },
      ],
    });

    const events: ToolLoopEvent[] = [];
    await runToolLoop({ ...baseParams, onEvent: (e) => events.push(e) });

    expect(events.map((e) => e.type)).toEqual([
      "tool_call",
      "tool_result",
      "text_delta",
    ]);
  });

  it("pairs each tool result with its call arguments by id", async () => {
    scriptModel({
      steps: [
        {
          toolCalls: [
            { toolName: "a", toolCallId: "t1", input: { n: 1 } },
            { toolName: "b", toolCallId: "t2", input: { n: 2 } },
          ],
          // Deliberately out of order: pairing must use the id, not position.
          toolResults: [
            { toolName: "b", toolCallId: "t2", output: "B" },
            { toolName: "a", toolCallId: "t1", output: "A" },
          ],
        },
      ],
    });

    const result = await runToolLoop(baseParams);

    expect(result.toolCalls).toEqual([
      { toolName: "b", args: { n: 2 }, output: "B" },
      { toolName: "a", args: { n: 1 }, output: "A" },
    ]);
  });

  it("parses JSON tool output but leaves plain strings alone", async () => {
    scriptModel({
      steps: [
        {
          toolCalls: [
            { toolName: "j", toolCallId: "t1" },
            { toolName: "p", toolCallId: "t2" },
          ],
          toolResults: [
            { toolName: "j", toolCallId: "t1", output: '{"ok":true}' },
            {
              toolName: "p",
              toolCallId: "t2",
              output: "search unavailable: boom",
            },
          ],
        },
      ],
    });

    const result = await runToolLoop(baseParams);

    expect(result.toolCalls[0].output).toEqual({ ok: true });
    expect(result.toolCalls[1].output).toBe("search unavailable: boom");
  });

  it("always includes the step cap in stopWhen, plus any caller conditions", async () => {
    scriptModel({ chunks: ["x"] });
    const extra = vi.fn() as any;

    await runToolLoop({ ...baseParams, stopWhen: [extra] });

    const config = streamTextMock.mock.calls[0][0];
    // A tool returning a value does not end the loop, so a submit-style tool
    // depends on its condition surviving alongside the cap.
    expect(Array.isArray(config.stopWhen)).toBe(true);
    expect(config.stopWhen).toHaveLength(2);
    expect(config.stopWhen[1]).toBe(extra);
  });

  it("omits providerOptions entirely when no reasoning effort is set", async () => {
    // The loop is shared by Quick Note, Workflow and semantic search, none
    // of which opt in. Their request bodies must be byte-identical to what
    // they were before the option existed — an empty `providerOptions` object
    // is not the same thing as no key.
    scriptModel({ chunks: ["x"] });

    await runToolLoop(baseParams);

    const config = streamTextMock.mock.calls[0][0];
    expect("providerOptions" in config).toBe(false);
  });

  it("passes a set reasoning effort through as an openai provider option", async () => {
    scriptModel({ chunks: ["x"] });

    await runToolLoop({ ...baseParams, reasoningEffort: "high" });

    const config = streamTextMock.mock.calls[0][0];
    expect(config.providerOptions).toEqual({
      openai: { reasoningEffort: "high" },
    });
  });

  it('surfaces a step-capped turn as finishReason "tool-calls"', async () => {
    scriptModel({ chunks: [], finishReason: "tool-calls" });

    const result = await runToolLoop(baseParams);

    expect(result.text).toBe("");
    expect(result.finishReason).toBe("tool-calls");
  });

  it("propagates a provider construction failure instead of returning silence", async () => {
    // createAISDKProvider throws on a missing OPENROUTER_API_KEY, where
    // createOpenAI used to construct fine and fail at request time. The DO's
    // turn handler wraps this call in a try/catch that sends `type: 'error'`
    // over the socket, so the error MUST propagate — resolving with empty
    // text here would show the user a silent dead turn instead.
    const { createAISDKProvider } = await import("../../src/utils/aiProvider");
    vi.mocked(createAISDKProvider).mockImplementationOnce(() => {
      throw new Error("OPENROUTER_API_KEY is required for OpenRouter");
    });

    await expect(runToolLoop(baseParams)).rejects.toThrow(/OPENROUTER_API_KEY/);
  });

  it("reports rejected generation metadata as failure with the partial result", async () => {
    streamTextMock.mockImplementation(() => ({
      textStream: (async function* () {
        yield "partial";
      })(),
      response: Promise.reject(new Error("no response")),
      finishReason: Promise.reject(new Error("no reason")),
      usage: Promise.reject(new Error("no usage")),
    }));

    await expect(runToolLoop(baseParams)).rejects.toMatchObject({
      name: "ToolLoopGenerationError",
      partialResult: {
        text: "partial",
        finishReason: "error",
        usage: null,
        responseMessages: [],
      },
    });
  });
});

describe("createStreamNormalizingProvider", () => {
  it("builds a provider without needing a thought-signature map", () => {
    // Replay state is internal to each provider; callers need no shared map.
    const provider = createStreamNormalizingProvider(
      { OPENROUTER_API_KEY: "sk-or-test" } as any,
      "test",
    );
    expect(typeof provider.chat).toBe("function");
  });
});

describe("finishReasonFallback", () => {
  it("explains a step-capped turn rather than returning silence", () => {
    expect(finishReasonFallback("tool-calls")).toMatch(/ran out of steps/i);
  });

  it("explains a context-length stop", () => {
    expect(finishReasonFallback("length")).toMatch(/context window/i);
  });

  it("has a generic fallback for unknown reasons", () => {
    expect(finishReasonFallback(null)).toMatch(/wasn't able to produce/i);
  });
});

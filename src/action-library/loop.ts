/**
 * Shared agent loop.
 *
 * The `streamText` turn loop, lifted out of `NanoChatAgent` so every
 * conversational flow runs one implementation instead of four. Callers supply
 * their own system prompt, tools, model, stop conditions, and event sink; the
 * loop owns the parts that are easy to get subtly wrong:
 *
 *   - SSE tool-call delta normalization (below),
 *   - stop conditions (a tool returning a value does NOT end an AI SDK loop),
 *   - finish-reason fallbacks, so a step-capped turn says something useful.
 */

import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
  type StopCondition,
} from "ai";
import type { RequestPurpose } from "../config";
import { OpenRouterToolReplay } from "./openrouterReplay";
import { createAISDKProvider } from "../utils/aiProvider";
import type { Env } from "../types";
import { logError } from "../telemetry/logger";

/**
 * Reasoning-effort levels accepted by `@ai-sdk/openai`'s chat provider
 * options. Mirrors that package's `reasoningEffort` union — kept as a local
 * type because the SDK exposes it only inside an inferred schema.
 */
export type ReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** A lifecycle event the caller may forward to a WebSocket, log, or ignore. */
export type ToolLoopEvent =
  | { type: "text_delta"; content: string }
  | {
      type: "tool_call";
      toolName: string;
      input?: unknown;
      toolCallId?: string;
    }
  | {
      type: "tool_result";
      toolName: string;
      output: unknown;
      rawJson: string;
      toolCallId?: string;
    };

export interface ToolLoopParams {
  env: Env;
  /** A configured model alias, or an explicit provider model ID. */
  model: string;
  /** Foreground by default; background requests receive the background reasoning policy. */
  purpose?: RequestPurpose;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  /** Step ceiling. Always combined with any `stopWhen` conditions supplied. */
  maxSteps: number;
  /** Names the calling flow in telemetry (e.g. 'agent', 'research'). */
  telemetryTag?: string;
  /**
   * Extra stop conditions. IMPORTANT: a tool returning a value does not end
   * an AI SDK loop, so a flow with a submit-style output tool must pass a
   * condition here or it will run to the step cap every turn.
   *
   * Key that condition on the submission having LANDED — a closure over the
   * flow's own state, `() => submit.getSubmitted() !== null` — NOT on
   * `hasToolCall('<name>')`. When a model truncates its arguments mid-JSON the
   * SDK still records a `tool-call` part (with `invalid: true`) and skips
   * `execute`, so `hasToolCall` matches on the NAME and ends the turn with
   * nothing submitted and the step budget unspent. State-based conditions let
   * the loop retry and land it on the next step. Regression tests exercise both the valid and truncated-input cases.
   */
  stopWhen?: StopCondition<ToolSet>[];
  /**
   * Per-request reasoning effort, forwarded as
   * `providerOptions.openai.reasoningEffort` (OpenRouter reads it as
   * `reasoning_effort`). DurableClaw sets it from the user's persona; every other
   * flow leaves it undefined.
   *
   * When undefined the loop omits `providerOptions` ENTIRELY — no empty
   * object, no key — so a caller that never opts in produces exactly the
   * request body it produced before this option existed.
   */
  reasoningEffort?: ReasoningEffort;
  onEvent?: (event: ToolLoopEvent) => void;
  /** Cumulative completed provider messages, before the next step can start. */
  onStepComplete?: (messages: ModelMessage[]) => void;
  /** Durable invocation/result hooks run even when a stream stops mid-tool. */
  onToolStart?: (message: ModelMessage) => void;
  onToolComplete?: (toolCallId: string, output: unknown) => void;
  retainToolExecution?: (execution: Promise<unknown>) => void;
  abortSignal?: AbortSignal;
}

export interface ToolLoopResult {
  text: string;
  finishReason: string | null;
  /** Tool calls paired with their results, in call order. */
  toolCalls: Array<{ toolName: string; args: unknown; output: unknown }>;
  /** Provider messages, for callers that persist conversation history. */
  responseMessages: ModelMessage[];
  /** Token usage, for cost accounting. Null when the provider omits it. */
  usage: { inputTokens: number; outputTokens: number } | null;
  /** Streamed text chunks — telemetry only. */
  chunkCount: number;
}

/** A failed generation may still contain useful, explicitly incomplete work. */
export class ToolLoopGenerationError extends Error {
  constructor(
    cause: unknown,
    readonly partialResult: ToolLoopResult,
  ) {
    super("Model generation failed", { cause });
    this.name = "ToolLoopGenerationError";
  }
}

/**
 * Build a provider whose fetch normalizes streamed tool-call deltas.
 *
 * Some providers omit `tc.index` on SSE tool-call deltas, which the AI SDK
 * needs in order to assemble a call — that back-fill is why this wrapper
 * exists. Non-OK responses log structural status metadata without retaining request data.
 *
 * Captures signed reasoning and original tool arguments before the SDK drops
 * them, then restores them when subsequent steps replay assistant tool calls.
 */
export function createStreamNormalizingProvider(
  env: Env,
  /** Caller identity for telemetry. This module is shared by every
   *  conversational flow, so a hardcoded name would misattribute errors. */
  telemetryTag = "runToolLoop",
  /** Resolved reasoning effort for this turn, for telemetry only. Omitted from
   *  the attributes entirely when unset, mirroring `providerOptions`. */
  reasoningEffort?: ReasoningEffort,
  purpose: RequestPurpose = "foreground",
  replay = new OpenRouterToolReplay(),
) {
  return createAISDKProvider(env, {
    purpose,
    fetch: async (url, init) => {
      const captureChoice = replay.beginResponse();
      const resp = await fetch(url, replay.restoreRequest(init));
      if (!resp.ok) {
        logError("Model provider returned an error", undefined, {
          "loop.caller": telemetryTag,
          ...(reasoningEffort
            ? { "loop.reasoning_effort": reasoningEffort }
            : {}),
          "openrouter.status": resp.status,
        });
        return resp;
      }
      if (!resp.body) return resp;

      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let sseBuffer = "";
      const transform = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          sseBuffer += decoder.decode(chunk, { stream: true });
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try {
                const json = JSON.parse(line.slice(6));
                if (json.choices) {
                  for (const choice of json.choices) {
                    captureChoice(choice);
                    if (choice.delta?.tool_calls) {
                      for (let i = 0; i < choice.delta.tool_calls.length; i++) {
                        const tc = choice.delta.tool_calls[i];
                        if (tc.index === undefined) {
                          tc.index = i;
                        }
                        // Late signature-only deltas are valid OpenRouter
                        // metadata. The OpenAI SDK still requires a function
                        // object even when there are no new argument bytes.
                        if (tc.function === undefined && tc.extra_content) {
                          tc.function = {};
                        }
                      }
                    }
                  }
                }
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(json)}\n`),
                );
              } catch {
                controller.enqueue(encoder.encode(line + "\n"));
              }
            } else {
              controller.enqueue(encoder.encode(line + "\n"));
            }
          }
        },
        flush(controller) {
          if (sseBuffer) {
            controller.enqueue(encoder.encode(sseBuffer + "\n"));
          }
        },
      });
      const patchedBody = resp.body.pipeThrough(transform);
      return new Response(patchedBody, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
    },
  });
}

/** The marker a confirm tool's preview-phase result carries (). */
export const NEEDS_CONFIRMATION_MARKER = "needs_confirmation";

/**
 * True when `output` — a tool result as recorded on an AI SDK step, either
 * the parsed value or the raw JSON string our tools return — carries the
 * given top-level marker flag.
 */
export function toolResultHasMarker(output: unknown, marker: string): boolean {
  let value = output;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }
  }
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>)[marker] === true
  );
}

/**
 * A stop condition that ends the turn once any tool result has landed with
 * `needs_confirmation: true` (Stage A).
 *
 * This exists BECAUSE a tool returning a value does not end an AI SDK loop:
 * without it the model would see its own needs_confirmation result fed back
 * as step input and re-call inside the same autonomous turn — which was the
 * whole vulnerability. Keyed on the marker having LANDED on a recorded step,
 * per the loop convention for submit-style conditions.
 *
 * Note the deliberate asymmetry with `hasToolCall`: this inspects RESULTS,
 * so a truncated/invalid call that never executed cannot trigger it.
 */
export function stopOnNeedsConfirmation(): StopCondition<ToolSet> {
  return ({ steps }: { steps?: Array<{ toolResults?: unknown }> }) =>
    (steps ?? []).some((step) =>
      ((step.toolResults ?? []) as Array<{ output?: unknown }>).some((result) =>
        toolResultHasMarker(result?.output, NEEDS_CONFIRMATION_MARKER),
      ),
    );
}

/**
 * Human-readable message for a turn that produced no text.
 *
 * A silent empty response reads as a bug; naming the reason lets the user
 * adjust (shorten the question, break up the task) instead of retrying blind.
 */
export function finishReasonFallback(finishReason: string | null): string {
  switch (finishReason) {
    case "tool-calls":
      return "I tried my best but ran out of steps before producing an answer — the task may be too complex for a single request. Try breaking it into smaller questions, or ask me to focus on one part at a time.";
    case "length":
      return "I ran out of context window space before I could produce an answer. Try asking a shorter or more focused question, or start a new conversation.";
    case "error":
      return "I hit an error while generating a response. Please try again.";
    default:
      return "I wasn't able to produce a response. Please try rephrasing.";
  }
}

/**
 * Run one tool-calling turn to completion, streaming text through `onEvent`.
 */
export async function runToolLoop(
  params: ToolLoopParams,
): Promise<ToolLoopResult> {
  params.abortSignal?.throwIfAborted();
  const replay = new OpenRouterToolReplay(params.messages);
  const openai = createStreamNormalizingProvider(
    params.env,
    params.telemetryTag,
    params.reasoningEffort,
    params.purpose,
    replay,
  );

  const toolCalls: ToolLoopResult["toolCalls"] = [];
  let generationError: unknown;
  const tools =
    params.onToolStart || params.onToolComplete
      ? (Object.fromEntries(
          Object.entries(params.tools).map(([toolName, definition]) => {
            if (!definition.execute) return [toolName, definition];
            const execute = definition.execute;
            return [
              toolName,
              {
                ...definition,
                execute: (
                  input: unknown,
                  options: Parameters<typeof execute>[1],
                ) => {
                  params.abortSignal?.throwIfAborted();
                  params.onToolStart?.(
                    replay.preserveMessages([
                      {
                        role: "assistant",
                        content: [
                          {
                            type: "tool-call",
                            toolCallId: options.toolCallId,
                            toolName,
                            input,
                          },
                        ],
                      } as ModelMessage,
                    ])[0],
                  );
                  const execution = (async () => {
                    try {
                      const output = await execute(input, options);
                      params.onToolComplete?.(options.toolCallId, {
                        type: "text",
                        value:
                          typeof output === "string"
                            ? output
                            : (JSON.stringify(output) ?? ""),
                      });
                      return output;
                    } catch (error) {
                      params.onToolComplete?.(options.toolCallId, {
                        type: "error-text",
                        value:
                          "Tool execution failed; any external effects may be incomplete.",
                      });
                      throw error;
                    }
                  })();
                  params.retainToolExecution?.(execution.catch(() => {}));
                  return execution;
                },
              },
            ];
          }),
        ) as ToolSet)
      : params.tools;

  const result = streamText({
    model: openai.chat(params.model),
    system: params.system,
    messages: params.messages,
    tools,
    stopWhen: [stepCountIs(params.maxSteps), ...(params.stopWhen ?? [])],
    abortSignal: params.abortSignal,
    // AI SDK textStream omits error parts; its onError hook is the primary
    // signal for failures after HTTP success or after an earlier tool step.
    onError: ({ error }) => {
      generationError ??= error;
    },
    // Spread rather than assign: an unset effort must leave `providerOptions`
    // off the call altogether, not present-but-empty.
    ...(params.reasoningEffort
      ? {
          providerOptions: {
            openai: { reasoningEffort: params.reasoningEffort },
          },
        }
      : {}),
    onStepFinish: (event) => {
      params.onStepComplete?.(
        replay.preserveMessages(event.response.messages as ModelMessage[]),
      );
      for (const call of event.toolCalls ?? []) {
        params.onEvent?.({
          type: "tool_call",
          toolName: call.toolName,
          input: (call as any).input ?? (call as any).args,
          toolCallId: (call as any).toolCallId,
        });
      }

      for (const toolResult of event.toolResults ?? []) {
        const rawOutput = (toolResult as any).output;
        const rawJson =
          typeof rawOutput === "string"
            ? rawOutput
            : JSON.stringify(rawOutput) || "";

        let parsedOutput: unknown = rawOutput;
        if (typeof rawOutput === "string") {
          try {
            parsedOutput = JSON.parse(rawOutput);
          } catch {
            parsedOutput = rawOutput;
          }
        }

        params.onEvent?.({
          type: "tool_result",
          toolName: toolResult.toolName,
          output: parsedOutput,
          rawJson,
          toolCallId: (toolResult as any).toolCallId,
        });

        // Pair the result with its arguments by toolCallId. AI SDK v6 exposes
        // arguments as `input` (v4 was `args`); keep the fallback so traces
        // don't silently lose them on an older shape.
        const meta = (event.toolCalls ?? []).find(
          (c: any) => c.toolCallId === (toolResult as any).toolCallId,
        ) as any | undefined;
        toolCalls.push({
          toolName: toolResult.toolName,
          args: meta ? (meta.input ?? meta.args) : undefined,
          output: parsedOutput,
        });
      }
    },
  });

  let text = "";
  let chunkCount = 0;
  try {
    for await (const chunk of result.textStream) {
      text += chunk;
      chunkCount++;
      params.onEvent?.({ type: "text_delta", content: chunk });
    }
  } catch (error) {
    generationError ??= error;
  }

  const response = await Promise.resolve(result.response).catch((error) => {
    generationError ??= error;
    return { messages: [] as ModelMessage[] };
  });
  const finishReason = await Promise.resolve(result.finishReason).catch(
    (error) => {
      generationError ??= error;
      return null;
    },
  );
  // `totalUsage`, NOT `usage`. In the AI SDK these are different quantities:
  // `usage` resolves to `finalStep.usage` — the LAST step only — while
  // `totalUsage` is the sum across every step of the loop (ai@6 `index.d.ts`:
  // "The token usage of the last step" vs "the sum of all step usages").
  //
  // Fall back to `usage` if a provider (or an older stub) does not expose a
  // total — a slightly low number beats null.
  type TokenUsage = { inputTokens?: number; outputTokens?: number };
  const totalUsage = (result as { totalUsage?: PromiseLike<TokenUsage> })
    .totalUsage;
  const rawUsage: TokenUsage | null =
    (await Promise.resolve(totalUsage).catch(() => null)) ??
    (await Promise.resolve<TokenUsage | null>(result.usage).catch(() => null));

  const completed: ToolLoopResult = {
    text,
    finishReason: finishReason ?? null,
    toolCalls,
    responseMessages: replay.preserveMessages(
      (response?.messages ?? []) as ModelMessage[],
    ),
    usage: rawUsage
      ? {
          inputTokens: rawUsage.inputTokens ?? 0,
          outputTokens: rawUsage.outputTokens ?? 0,
        }
      : null,
    chunkCount,
  };
  // Cancellation remains a caller-owned outcome. It must never become a
  // provider failure or a successful empty response after the stream closes.
  params.abortSignal?.throwIfAborted();
  // An HTTP-200 SSE body can end without a finish marker. AI SDK maps that
  // transport truncation to `other` and invokes no error hook, even when it
  // already emitted text. Only explicit, recognized completions are success.
  const completedNormally =
    finishReason !== null &&
    ["stop", "length", "tool-calls", "content-filter"].includes(finishReason);
  if (generationError !== undefined || !completedNormally) {
    throw new ToolLoopGenerationError(
      generationError ?? new Error("Provider did not complete generation"),
      {
        ...completed,
        finishReason: "error",
      },
    );
  }
  return completed;
}

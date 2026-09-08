/**
 * One streaming conversation turn: wraps the shared runToolLoop and bridges
 * its events onto the canonical frame protocol
 * (assistant_start → deltas/tool frames → assistant_end).
 *
 * The caller owns everything around the turn: history persistence, locks,
 * rate limits, memory writes, and any domain frames (preview_update etc.).
 */
import type { ModelMessage, ToolSet, StopCondition } from "ai";
import {
  runToolLoop,
  finishReasonFallback,
  type ToolLoopEvent,
  type ToolLoopResult,
  type ReasoningEffort,
} from "../action-library/loop";
import type { Env } from "../types";
import type { FrameSink } from "./protocol";

export interface AgentTurnParams {
  env: Env;
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  maxSteps: number;
  telemetryTag: string;
  stopWhen?: StopCondition<ToolSet>[];
  reasoningEffort?: ReasoningEffort;
  /** Cancels the in-flight turn. Forwarded straight to `runToolLoop`. */
  abortSignal?: AbortSignal;
  /**
   * Conversation-scoped frame sender (caller decides socket fan-out).
   *
   * This sink is also the caller's DECORATION POINT: every frame the kernel
   * produces passes through it before reaching a socket, so a flow can add
   * fields to, rewrite, or drop any frame — including the terminal
   * `assistant_end` — without the kernel needing a hook for it. A flow that
   * wants to stamp a turn id on every frame, or to withhold `assistant_end`
   * until its own post-turn work lands, does that here.
   */
  emit: FrameSink;
  /**
   * Fallback copy for a turn that produced no text and did not finish with
   * 'stop'. Return null to SUPPRESS the fallback entirely — the caller will
   * compose its own post-turn message (the workflow flow does this after a
   * successful submission, whose finishReason is 'tool-calls').
   * Default: finishReasonFallback from action-library/loop.
   */
  fallbackText?: (finishReason: string | null) => string | null;
  /** Domain hook, called AFTER the corresponding frame is emitted. */
  onEvent?: (event: ToolLoopEvent) => void;
}

export interface AgentTurnResult extends ToolLoopResult {
  /** loop text, or the emitted fallback when the loop produced none. */
  fullText: string;
}

export async function runAgentTurn(
  params: AgentTurnParams,
): Promise<AgentTurnResult> {
  params.emit({ type: "assistant_start" });

  const loop = await runToolLoop({
    env: params.env,
    model: params.model,
    system: params.system,
    messages: params.messages,
    tools: params.tools,
    maxSteps: params.maxSteps,
    telemetryTag: params.telemetryTag,
    stopWhen: params.stopWhen,
    reasoningEffort: params.reasoningEffort,
    abortSignal: params.abortSignal,
    onEvent: (event) => {
      // Each branch maps one known event to its frame. An event type this
      // kernel does not know gets NO frame — but still reaches `onEvent`
      // below, so a flow can handle it without the kernel inventing a
      // malformed `tool_result` for it.
      if (event.type === "text_delta") {
        params.emit({ type: "assistant_delta", content: event.content });
      } else if (event.type === "tool_call") {
        params.emit({
          type: "tool_call",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        });
      } else if (event.type === "tool_result") {
        params.emit({
          type: "tool_result",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          rawJson: event.rawJson,
        });
      }
      params.onEvent?.(event);
    },
  });

  let fullText = loop.text;
  if (!fullText && loop.finishReason !== "stop") {
    const fallbackFor = params.fallbackText ?? finishReasonFallback;
    const fallback = fallbackFor(loop.finishReason);
    if (fallback) {
      params.emit({ type: "assistant_delta", content: fallback });
      fullText = fallback;
    }
  }

  params.emit({ type: "assistant_end" });

  return { ...loop, fullText };
}

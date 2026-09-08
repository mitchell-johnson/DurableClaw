/**
 * Preserve the OpenRouter fields that the OpenAI-compatible AI SDK discards.
 * Gemini validates signed reasoning against the original tool arguments, so
 * parsing then serializing those arguments is not safe (even key order matters).
 * State belongs to one loop; durable history carries it on tool-call parts.
 */
import type { JSONValue, ModelMessage } from "ai";

type ToolReplay = {
  index: number;
  arguments: string;
  reasoningDetails: JSONValue[];
  extraContent?: JSONValue;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class OpenRouterToolReplay {
  private readonly calls = new Map<string, ToolReplay>();

  constructor(messages: ModelMessage[] = []) {
    for (const message of messages) {
      if (message.role !== "assistant" || !Array.isArray(message.content))
        continue;
      for (const part of message.content) {
        if (part.type !== "tool-call") continue;
        const saved = record(part.providerOptions?.openrouter?.toolReplay);
        if (
          typeof saved?.arguments !== "string" ||
          !Array.isArray(saved.reasoningDetails)
        )
          continue;
        this.calls.set(part.toolCallId, {
          index: typeof saved.index === "number" ? saved.index : 0,
          arguments: saved.arguments,
          reasoningDetails: saved.reasoningDetails as JSONValue[],
          ...(saved.extraContent !== undefined
            ? { extraContent: saved.extraContent as JSONValue }
            : {}),
        });
      }
    }
  }

  /** Each HTTP response has its own delta indexes and reasoning sequence. */
  beginResponse(): (choice: unknown) => void {
    const choices = new Map<
      number,
      {
        reasoningDetails: JSONValue[];
        calls: Map<number, { id?: string; replay: ToolReplay }>;
      }
    >();
    return (value) => {
      const choice = record(value);
      const delta = record(choice?.delta);
      if (!delta) return;
      const choiceIndex = typeof choice?.index === "number" ? choice.index : 0;
      let state = choices.get(choiceIndex);
      if (!state) {
        state = { reasoningDetails: [], calls: new Map() };
        choices.set(choiceIndex, state);
      }
      // OpenRouter defines replay as the ordered sequence of detail chunks.
      if (Array.isArray(delta.reasoning_details)) {
        state.reasoningDetails.push(
          ...(delta.reasoning_details as JSONValue[]),
        );
      }
      if (!Array.isArray(delta.tool_calls)) return;
      for (const [position, value] of delta.tool_calls.entries()) {
        const toolCall = record(value);
        if (!toolCall) continue;
        const index =
          typeof toolCall.index === "number" ? toolCall.index : position;
        let call = state.calls.get(index);
        if (!call) {
          call = {
            replay: {
              index,
              arguments: "",
              reasoningDetails: state.reasoningDetails,
            },
          };
          state.calls.set(index, call);
        }
        if (typeof toolCall.id === "string") call.id = toolCall.id;
        const fn = record(toolCall.function);
        if (typeof fn?.arguments === "string")
          call.replay.arguments += fn.arguments;
        if (toolCall.extra_content !== undefined) {
          call.replay.extraContent = toolCall.extra_content as JSONValue;
        }
        if (call.id) this.calls.set(call.id, call.replay);
      }
    };
  }

  restoreRequest(init?: RequestInit): RequestInit | undefined {
    if (typeof init?.body !== "string" || this.calls.size === 0) return init;
    try {
      const body = JSON.parse(init.body);
      if (!Array.isArray(body?.messages)) return init;
      // Gemini requires signatures only after the latest user message. Older
      // signatures can be incompatible after a provider/model change and poison
      // an otherwise valid conversation. Keep the transcript and raw arguments;
      // omit only Gemini's completed-turn reasoning metadata from the wire.
      let lastUserIndex = -1;
      for (const [index, message] of body.messages.entries()) {
        if (message?.role === "user") lastUserIndex = index;
      }
      let patched = false;
      for (const [messageIndex, message] of body.messages.entries()) {
        if (message?.role !== "assistant" || !Array.isArray(message.tool_calls))
          continue;
        // The SDK emits completed calls in completion order, which can differ
        // from the provider's original parallel-call order covered by a signature.
        message.tool_calls.sort(
          (left: { id?: string }, right: { id?: string }) =>
            (this.calls.get(left.id ?? "")?.index ?? 0) -
            (this.calls.get(right.id ?? "")?.index ?? 0),
        );
        for (const toolCall of message.tool_calls) {
          const replay = this.calls.get(toolCall?.id);
          if (!replay || !record(toolCall.function)) continue;
          toolCall.function.arguments = replay.arguments;
          if (replay.extraContent !== undefined)
            toolCall.extra_content = replay.extraContent;
          if (replay.reasoningDetails.length > 0)
            message.reasoning_details = replay.reasoningDetails;
          patched = true;
        }
        if (messageIndex < lastUserIndex) {
          if (Array.isArray(message.reasoning_details)) {
            message.reasoning_details = message.reasoning_details.filter(
              (detail: unknown) =>
                record(detail)?.format !== "google-gemini-v1",
            );
            if (message.reasoning_details.length === 0)
              delete message.reasoning_details;
          }
          for (const toolCall of message.tool_calls) {
            const extra = record(toolCall.extra_content);
            const google = record(extra?.google);
            if (!google || !("thought_signature" in google)) continue;
            // Clone metadata restored from durable replay; callers reuse it.
            const remainingGoogle = { ...google };
            delete remainingGoogle.thought_signature;
            const remainingExtra: Record<string, unknown> = {
              ...extra,
              google: remainingGoogle,
            };
            if (Object.keys(remainingGoogle).length === 0)
              delete remainingExtra.google;
            if (Object.keys(remainingExtra).length === 0)
              delete toolCall.extra_content;
            else toolCall.extra_content = remainingExtra;
          }
        }
      }
      return patched ? { ...init, body: JSON.stringify(body) } : init;
    } catch {
      return init;
    }
  }

  /** Tool-call parts are already JSON-persisted by the shared history store. */
  preserveMessages(messages: ModelMessage[]): ModelMessage[] {
    return messages.map((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.content))
        return message;
      return {
        ...message,
        content: message.content.map((part) => {
          if (part.type !== "tool-call") return part;
          const replay = this.calls.get(part.toolCallId);
          if (!replay) return part;
          return {
            ...part,
            providerOptions: {
              ...part.providerOptions,
              openrouter: {
                ...part.providerOptions?.openrouter,
                toolReplay: replay,
              },
            },
          };
        }),
      };
    });
  }
}

/**
 * Canonical WebSocket frame protocol for conversational agents.
 *
 * The coordinator and browser share this contract across live turns and replay.
 *
 * Turn order (server → client):
 *   assistant_start → (assistant_delta | tool_call | tool_result)* → assistant_end
 *
 * Reconnect replay (server → client, before `ready`):
 *   (history_user_message | assistant_message | history_tool_result)*  → ready
 *
 * Note `assistant_message` doubles as the history-replay frame for assistant
 * turns AND as a "complete message, no streaming" frame — clients append it
 * as a finished bubble either way. This mirrors the existing DurableClaw client
 * (`useAssistantChat.ts` case 'assistant_message').
 *
 * DOMAIN FRAMES ARE ADDITIVE. A flow may emit extra `{ type: string, ... }`
 * frames (e.g. the workflow flow's `preview_update`, `status`,
 * `schema_found`). Clients must ignore frame types they don't handle.
 */

export const CORE_SERVER_FRAME_TYPES = [
  "ready",
  "history_user_message",
  "assistant_message",
  "history_tool_result",
  "assistant_start",
  "assistant_delta",
  "assistant_end",
  "tool_call",
  "tool_result",
  "cleared",
  "error",
] as const;
export type CoreServerFrameType = (typeof CORE_SERVER_FRAME_TYPES)[number];

export interface ReadyFrame {
  type: "ready";
  initialized: boolean;
}
export interface HistoryUserMessageFrame {
  type: "history_user_message";
  content: string;
  message_id?: string;
}
/** Optional for older conversational agents; DurableClaw identifies every turn. */
export interface TurnIdentity {
  request_id?: string;
  /** Durable assistant-message identity, reused by reconnect replay. */
  message_id?: string;
}
/** Complete (non-streamed) assistant message; also the history-replay frame. */
export interface AssistantMessageFrame extends TurnIdentity {
  type: "assistant_message";
  content: string;
  stopped?: boolean;
}
export interface HistoryToolResultFrame {
  type: "history_tool_result";
  /** Index of the assistant message this result's widgets attach to. */
  turn: number;
  toolName: string;
  rawJson: string;
}
export interface AssistantStartFrame extends TurnIdentity {
  type: "assistant_start";
}
export interface AssistantDeltaFrame extends TurnIdentity {
  type: "assistant_delta";
  content: string;
}
export interface AssistantEndFrame extends TurnIdentity {
  type: "assistant_end";
  stopped?: boolean;
}
export interface ToolCallFrame extends TurnIdentity {
  type: "tool_call";
  toolName: string;
  toolCallId?: string;
}
export interface ToolResultFrame extends TurnIdentity {
  type: "tool_result";
  toolName: string;
  toolCallId?: string;
  rawJson: string;
}
export interface ClearedFrame {
  type: "cleared";
}
export interface ErrorFrame extends TurnIdentity {
  type: "error";
  /**
   * User-facing copy, rendered directly in the conversation panel. Write it
   * for the person reading it — never a validator string, an exception
   * message, a stack, or any other internal detail.
   */
  error: string;
}

export type CoreServerFrame =
  | ReadyFrame
  | HistoryUserMessageFrame
  | AssistantMessageFrame
  | HistoryToolResultFrame
  | AssistantStartFrame
  | AssistantDeltaFrame
  | AssistantEndFrame
  | ToolCallFrame
  | ToolResultFrame
  | ClearedFrame
  | ErrorFrame;

export const CLIENT_FRAME_TYPES = ["message", "clear", "cancel"] as const;
export type ClientFrameType = (typeof CLIENT_FRAME_TYPES)[number];

export interface ClientMessageFrame {
  type: "message";
  content: string;
  request_id?: string;
}
export interface ClientClearFrame {
  type: "clear";
}
export interface ClientCancelFrame {
  type: "cancel";
  /** Cancel this request and its research; omission supports legacy clients. */
  request_id?: string;
}
export type ClientFrame =
  ClientMessageFrame | ClientClearFrame | ClientCancelFrame;

/**
 * A frame sender. Deliberately loose (`Record<string, unknown>`) because
 * senders mix core frames with domain frames; the interfaces above document
 * the contract rather than constrain the sink.
 */
export type FrameSink = (frame: Record<string, unknown>) => void;

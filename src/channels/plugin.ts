import type { AgentPrincipal } from "../types";

export interface MessagingEnv {
  CONTROL_DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

export type MessagingCredentials = Omit<MessagingEnv, "CONTROL_DB">;

/** Trusted deployment code must authenticate the provider before returning data.
 * Message content is never an authorization decision. */
export interface MessagingEvent {
  kind?: "message";
  eventId: string;
  senderId: string;
  chatId: string;
  content: string;
  occurredAt: number;
}

/** A provider-authenticated button event, never ordinary model input. */
export interface MessagingApprovalEvent {
  kind: "approval";
  eventId: string;
  senderId: string;
  chatId: string;
  callbackId: string;
  messageId: string;
  data: string;
  occurredAt: number;
}

export interface MessagingApproval {
  confirmationId: string;
  toolName: string;
  preview: string;
  expiresAt: number;
}

export interface MessagingReply {
  text: string;
  approvals?: MessagingApproval[];
}

export interface MessagingChannel {
  linkId: string;
  pluginId: string;
  senderId: string;
  chatId: string;
}

export interface MessagingPlugin {
  readonly id: string;
  readonly label: string;
  configured(env: MessagingCredentials): boolean;
  receive(
    request: Request,
    env: MessagingCredentials,
  ): Promise<MessagingEvent | MessagingApprovalEvent | null>;
  send(
    env: MessagingCredentials,
    reply: { chatId: string; text: string },
  ): Promise<void>;
  /** Send the complete exact preview. Never truncate approval text. */
  sendApproval?(
    env: MessagingCredentials,
    reply: {
      chatId: string;
      text: string;
      approveData: string;
      declineData: string;
    },
  ): Promise<{ messageId: string }>;
  answerCallback?(
    env: MessagingCredentials,
    reply: { callbackId: string; text: string },
  ): Promise<void>;
  clearApproval?(
    env: MessagingCredentials,
    target: { chatId: string; messageId: string },
  ): Promise<void>;
  /** Best-effort, ephemeral activity; never sends conversation content. */
  sendTyping?(
    env: MessagingCredentials,
    target: { chatId: string },
    signal: AbortSignal,
  ): Promise<void>;
}

/** The host must reauthorize the stored owner on each dispatch and execute the
 * request idempotently. Only the verified button path may supply approval. */
export type MessagingDispatch = (
  principal: AgentPrincipal,
  message: {
    conversationId: string;
    requestId: string;
    content: string;
    channel?: MessagingChannel;
    approval?: { confirmationId: string; decision: "confirmed" | "declined" };
  },
) => Promise<MessagingReply>;

export class MessagingError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** Sanitized provider feedback for retryable, ephemeral chat actions only. */
export class MessagingActivityError extends MessagingError {
  constructor(
    status: number,
    public readonly retryAfterMs = 30_000,
  ) {
    super("Messaging activity unavailable", status);
  }
}

export function boundedReply(text: string): string {
  if (!text.trim())
    return "The agent completed without a text reply. Open DurableClaw to review the conversation.";
  if (text.length <= 4096) return text;
  // Avoid splitting a UTF-16 surrogate pair. Telegram counts text after parsing;
  // this conservative bound also fits astral characters without parse_mode.
  return (
    text.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, "") +
    "\n\n[Reply shortened. Open DurableClaw for the full conversation.]"
  );
}

export function createMessagingRegistry(plugins: readonly MessagingPlugin[]) {
  const registry = new Map<string, MessagingPlugin>();
  for (const plugin of plugins) {
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(plugin.id) || registry.has(plugin.id))
      throw new Error("Invalid or duplicate messaging plugin ID");
    registry.set(plugin.id, plugin);
  }
  return Object.freeze({
    get: (id: string) => registry.get(id),
    list: () => [...registry.values()],
  });
}

export type MessagingRegistry = ReturnType<typeof createMessagingRegistry>;

import type { AgentPrincipal } from "../types";

export interface MessagingEnv {
  CONTROL_DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
}

export type MessagingCredentials = Omit<MessagingEnv, "CONTROL_DB">;

/** Trusted deployment code must authenticate the provider before returning data.
 * Only private, human-authored text events are supported. Content is never an
 * authorization decision or an action-confirmation response. */
export interface MessagingEvent {
  eventId: string;
  senderId: string;
  chatId: string;
  content: string;
  occurredAt: number;
}

export interface MessagingPlugin {
  readonly id: string;
  readonly label: string;
  configured(env: MessagingCredentials): boolean;
  receive(
    request: Request,
    env: MessagingCredentials,
  ): Promise<MessagingEvent | null>;
  send(
    env: MessagingCredentials,
    reply: { chatId: string; text: string },
  ): Promise<void>;
}

/** The host must reauthorize the stored owner on each dispatch and execute the
 * request idempotently. This interface deliberately cannot approve tools. */
export type MessagingDispatch = (
  principal: AgentPrincipal,
  message: { conversationId: string; requestId: string; content: string },
) => Promise<{ text: string }>;

export class MessagingError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
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

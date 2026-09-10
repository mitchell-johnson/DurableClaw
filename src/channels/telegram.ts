import { constantTimeEqual } from "../auth";
import { boundedJson } from "../utils/validation";
import {
  boundedReply,
  MessagingActivityError,
  MessagingError,
  type MessagingCredentials,
  type MessagingPlugin,
} from "./plugin";

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const providerId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const approvalData = (value: unknown): value is string =>
  typeof value === "string" && /^dc:[ad]:[A-Za-z0-9_-]{32}$/.test(value);
const unsupportedMessage = (message: Record<string, unknown>) =>
  [
    "sender_chat",
    "forward_origin",
    "forward_from",
    "forward_from_chat",
    "forward_sender_name",
    "forward_date",
    "is_automatic_forward",
    "via_bot",
    "business_connection_id",
    "guest_query_id",
    "guest_bot_caller_user",
    "guest_bot_caller_chat",
    "inline_message_id",
  ].some((key) => message[key] !== undefined);

async function approvalCall(
  env: MessagingCredentials,
  method: "sendMessage" | "answerCallbackQuery" | "editMessageReplyMarkup",
  payload: object,
  timeout = 10_000,
): Promise<Record<string, unknown>> {
  if (!telegramPlugin.configured(env))
    throw new MessagingError("Telegram approval unavailable", 503);
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
        redirect: "manual",
      },
    );
    const body = object(
      await boundedJson(
        new Request("https://telegram-response.internal", {
          method: "POST",
          body: response.body,
          duplex: "half",
        } as RequestInit),
        65536,
      ),
    );
    if (!response.ok || body?.ok !== true) throw new Error();
    return body;
  } catch {
    throw new MessagingError("Telegram approval unavailable", 502);
  }
}

export const telegramPlugin = Object.freeze<MessagingPlugin>({
  id: "telegram",
  label: "Telegram",
  configured: (env) =>
    /^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN || "") &&
    /^[A-Za-z0-9_-]{32,256}$/.test(env.TELEGRAM_WEBHOOK_SECRET || ""),
  async receive(request, env) {
    if (!telegramPlugin.configured(env))
      throw new MessagingError("Telegram is not configured", 503);
    const supplied = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (
      !supplied ||
      supplied.length > 256 ||
      !(await constantTimeEqual(supplied, env.TELEGRAM_WEBHOOK_SECRET!))
    )
      throw new MessagingError("Invalid webhook authentication", 401);
    const body = object(await boundedJson(request));
    if (
      !body ||
      !Number.isSafeInteger(body.update_id) ||
      Number(body.update_id) < 0
    )
      return null;
    if (body.callback_query !== undefined) {
      const callback = object(body.callback_query);
      const message = object(callback?.message);
      const from = object(callback?.from);
      const bot = object(message?.from);
      const chat = object(message?.chat);
      if (
        body.message !== undefined ||
        !callback ||
        !message ||
        !from ||
        !bot ||
        !chat ||
        callback.inline_message_id !== undefined ||
        callback.game_short_name !== undefined ||
        !providerId(callback.id) ||
        !approvalData(callback.data) ||
        chat.type !== "private" ||
        from.is_bot !== false ||
        !positiveId(from.id) ||
        !positiveId(chat.id) ||
        from.id !== chat.id ||
        bot.is_bot !== true ||
        !positiveId(bot.id) ||
        String(bot.id) !== env.TELEGRAM_BOT_TOKEN!.split(":")[0] ||
        !positiveId(message.message_id) ||
        !positiveId(message.date) ||
        unsupportedMessage(message)
      )
        return null;
      return {
        kind: "approval",
        eventId: String(body.update_id),
        senderId: String(from.id),
        chatId: String(chat.id),
        callbackId: callback.id,
        messageId: String(message.message_id),
        data: callback.data,
        occurredAt: message.date * 1000,
      };
    }
    const message = object(body?.message);
    const from = object(message?.from);
    const chat = object(message?.chat);
    if (
      !body ||
      !Number.isSafeInteger(body.update_id) ||
      Number(body.update_id) < 0 ||
      !message ||
      !from ||
      !chat ||
      chat.type !== "private" ||
      from.is_bot !== false ||
      !positiveId(from.id) ||
      !positiveId(chat.id) ||
      from.id !== chat.id ||
      unsupportedMessage(message) ||
      !positiveId(message.message_id) ||
      !positiveId(message.date) ||
      typeof message.text !== "string" ||
      !message.text.trim() ||
      message.text.length > 4096
    )
      return null;
    return {
      eventId: String(body.update_id),
      senderId: String(from.id),
      chatId: String(chat.id),
      content: message.text,
      occurredAt: message.date * 1000,
    };
  },
  async sendApproval(env, reply) {
    if (
      !/^[1-9]\d{0,15}$/.test(reply.chatId) ||
      typeof reply.text !== "string" ||
      !reply.text.trim() ||
      reply.text.length > 4096 ||
      !approvalData(reply.approveData) ||
      !reply.approveData.startsWith("dc:a:") ||
      !approvalData(reply.declineData) ||
      !reply.declineData.startsWith("dc:d:") ||
      reply.approveData.slice(5) !== reply.declineData.slice(5)
    )
      throw new MessagingError("Invalid Telegram approval", 400);
    const body = await approvalCall(env, "sendMessage", {
      chat_id: reply.chatId,
      text: reply.text,
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: reply.approveData },
            { text: "Decline", callback_data: reply.declineData },
          ],
        ],
      },
    });
    const messageId = object(body.result)?.message_id;
    if (!positiveId(messageId))
      throw new MessagingError("Telegram approval unavailable", 502);
    return { messageId: String(messageId) };
  },
  async answerCallback(env, reply) {
    if (
      !providerId(reply.callbackId) ||
      typeof reply.text !== "string" ||
      reply.text.length > 200
    )
      throw new MessagingError("Invalid Telegram callback", 400);
    await approvalCall(
      env,
      "answerCallbackQuery",
      {
        callback_query_id: reply.callbackId,
        text: reply.text,
        cache_time: 0,
      },
      3000,
    );
  },
  async clearApproval(env, target) {
    if (
      !/^[1-9]\d{0,15}$/.test(target.chatId) ||
      !/^[1-9]\d{0,15}$/.test(target.messageId)
    )
      throw new MessagingError("Invalid Telegram approval", 400);
    await approvalCall(
      env,
      "editMessageReplyMarkup",
      {
        chat_id: target.chatId,
        message_id: Number(target.messageId),
        reply_markup: { inline_keyboard: [] },
      },
      3000,
    );
  },
  async send(env, reply) {
    if (
      !telegramPlugin.configured(env) ||
      !/^[1-9]\d{0,15}$/.test(reply.chatId)
    )
      throw new MessagingError("Telegram delivery unavailable", 503);
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: reply.chatId,
            text: boundedReply(reply.text),
            link_preview_options: { is_disabled: true },
          }),
          signal: AbortSignal.timeout(10_000),
          redirect: "manual",
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("Provider rejected delivery");
      }
      // Reuse the bounded parser so even an upstream error cannot allocate an
      // unbounded response body. Never expose provider errors containing a token.
      const body = await boundedJson(
        new Request("https://telegram-response.internal", {
          method: "POST",
          body: response.body,
          duplex: "half",
        } as RequestInit),
        65536,
      );
      if (!object(body)?.ok) throw new Error("Provider rejected delivery");
    } catch {
      throw new MessagingError("Telegram delivery failed", 502);
    }
  },
  async sendTyping(env, target, signal) {
    if (
      !telegramPlugin.configured(env) ||
      !/^[1-9]\d{0,15}$/.test(target.chatId)
    )
      throw new MessagingActivityError(400);
    try {
      signal.throwIfAborted();
      const response = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: target.chatId, action: "typing" }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]),
          redirect: "manual",
        },
      );
      const body = object(
        await boundedJson(
          new Request("https://telegram-response.internal", {
            method: "POST",
            body: response.body,
            duplex: "half",
          } as RequestInit),
          65536,
        ),
      );
      if (!response.ok || body?.ok !== true) {
        const status = response.ok ? Number(body?.error_code) : response.status;
        const seconds = object(body?.parameters)?.retry_after;
        throw new MessagingActivityError(
          status,
          status === 429 &&
            typeof seconds === "number" &&
            Number.isFinite(seconds)
            ? Math.max(4000, Math.min(3600_000, Math.ceil(seconds * 1000)))
            : 30_000,
        );
      }
    } catch (error) {
      if (error instanceof MessagingActivityError) throw error;
      // Fetch errors can contain the bot token. Never pass them to logs/callers.
      throw new MessagingActivityError(502);
    }
  },
});

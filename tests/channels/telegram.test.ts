import { afterEach, describe, expect, it, vi } from "vitest";
import * as channels from "../../src/channels";

const secret = "0123456789abcdef0123456789abcdef";
const env = {
  TELEGRAM_WEBHOOK_SECRET: secret,
  TELEGRAM_BOT_TOKEN: "123456:abcdefghijk",
};
const update = (message: Record<string, unknown> = {}) => ({
  update_id: 100,
  message: {
    message_id: 7,
    date: Math.floor(Date.now() / 1000),
    from: { id: 42, is_bot: false, username: "ignored" },
    chat: { id: 42, type: "private" },
    text: "Hello",
    ...message,
  },
});
const request = (body: unknown = update(), suppliedSecret = secret) =>
  new Request("https://claw.test/api/messaging/webhooks/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": suppliedSecret,
    },
    body: JSON.stringify(body),
  });

const callbackUpdate = () => ({
  update_id: 101,
  callback_query: {
    id: "callback_1",
    from: { id: 42, is_bot: false },
    data: `dc:a:${"a".repeat(32)}`,
    message: {
      message_id: 99,
      date: Math.floor(Date.now() / 1000),
      from: { id: 123456, is_bot: true },
      chat: { id: 42, type: "private" },
      text: "Review this exact action",
    },
  },
});

afterEach(() => vi.unstubAllGlobals());

describe("Telegram messaging adapter", () => {
  it("normalizes authenticated approval buttons separately from model text", async () => {
    expect(
      await channels.telegramPlugin.receive(request(callbackUpdate()), env),
    ).toEqual({
      kind: "approval",
      eventId: "101",
      senderId: "42",
      chatId: "42",
      callbackId: "callback_1",
      messageId: "99",
      data: `dc:a:${"a".repeat(32)}`,
      occurredAt: callbackUpdate().callback_query.message.date * 1000,
    });
  });

  it("sends an intact plain-text action preview with approve and decline buttons", async () => {
    const send = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 99 } }),
    );
    vi.stubGlobal("fetch", send);
    expect(
      await channels.telegramPlugin.sendApproval!(env, {
        chatId: "42",
        text: "Send email\nTo: alice@example.test\nBody: <b>exact body</b>",
        approveData: `dc:a:${"a".repeat(32)}`,
        declineData: `dc:d:${"a".repeat(32)}`,
      }),
    ).toEqual({ messageId: "99" });
    const body = JSON.parse(
      (send.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.text).toContain("Body: <b>exact body</b>");
    expect(body.parse_mode).toBeUndefined();
    expect(body.reply_markup.inline_keyboard).toEqual([
      [
        { text: "Approve", callback_data: `dc:a:${"a".repeat(32)}` },
        { text: "Decline", callback_data: `dc:d:${"a".repeat(32)}` },
      ],
    ]);
  });
  it("exports a deployable messaging plugin", () => {
    expect(channels).toHaveProperty("telegramPlugin");
  });

  it("authenticates before normalizing stable sender and chat identities", async () => {
    await expect(
      channels.telegramPlugin.receive(request(), env),
    ).resolves.toMatchObject({
      eventId: "100",
      senderId: "42",
      chatId: "42",
      content: "Hello",
    });
    await expect(
      channels.telegramPlugin.receive(request(undefined, "wrong"), env),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      channels.telegramPlugin.receive(request(), {}),
    ).rejects.toMatchObject({ status: 503 });
  });

  it.each([
    { chat: { id: -100, type: "group" } },
    { from: { id: 42, is_bot: true } },
    { from: { id: 43, is_bot: false } },
    { from: { id: 42.5, is_bot: false } },
    { sender_chat: { id: 42 } },
    { text: "x".repeat(4097) },
    { text: "" },
    { text: null },
  ])("ignores unsupported or unsafe message %j", async (message) => {
    expect(
      await channels.telegramPlugin.receive(request(update(message)), env),
    ).toBeNull();
  });

  it("ignores edits and malformed callback queries", async () => {
    expect(
      await channels.telegramPlugin.receive(
        request({ update_id: 100, edited_message: update().message }),
        env,
      ),
    ).toBeNull();
    expect(
      await channels.telegramPlugin.receive(
        request({ update_id: 101, callback_query: { data: "approve" } }),
        env,
      ),
    ).toBeNull();
  });

  it("authenticates callback requests before accepting any button authority", async () => {
    await expect(
      channels.telegramPlugin.receive(request(callbackUpdate(), "wrong"), env),
    ).rejects.toMatchObject({ status: 401 });
  });

  it.each([
    { from: { id: 42, is_bot: true } },
    { from: { id: 43, is_bot: false } },
    { from: { id: 42.5, is_bot: false } },
    { id: "x".repeat(129) },
    { id: "" },
    { id: null },
    { data: `dc:a:${"x".repeat(65)}` },
    { data: "approve" },
    { data: `dc:a:${"😀".repeat(32)}` },
    { data: null },
    { inline_message_id: "inline" },
    { game_short_name: "game" },
    { message: null },
  ])("rejects forged or malformed callback fields %j", async (fields) => {
    const body = callbackUpdate();
    Object.assign(body.callback_query, fields);
    expect(
      await channels.telegramPlugin.receive(request(body), env),
    ).toBeNull();
  });

  it.each([
    { from: { id: 123457, is_bot: true } },
    { from: { id: 123456, is_bot: false } },
    { chat: { id: 42, type: "group" } },
    { chat: { id: 43, type: "private" } },
    { chat: { id: -42, type: "private" } },
    { message_id: 0 },
    { message_id: 0.1 },
    { date: 0 },
    { forward_origin: { type: "user" } },
    { forward_from: { id: 42 } },
    { forward_from_chat: { id: 42 } },
    { forward_sender_name: "Alice" },
    { forward_date: 1 },
    { is_automatic_forward: false },
    { sender_chat: { id: 42 } },
    { via_bot: { id: 123456 } },
    { business_connection_id: "business" },
    { guest_query_id: "guest" },
    { inline_message_id: "inline" },
  ])("rejects callbacks on untrusted message origins %j", async (fields) => {
    const body = callbackUpdate();
    Object.assign(body.callback_query.message, fields);
    expect(
      await channels.telegramPlugin.receive(request(body), env),
    ).toBeNull();
  });

  it("rejects an ambiguous callback/message update rather than dispatching text", async () => {
    expect(
      await channels.telegramPlugin.receive(
        request({ ...callbackUpdate(), message: update().message }),
        env,
      ),
    ).toBeNull();
  });

  it.each([
    "oversized-preview",
    "invalid-token",
    "mismatched-tokens",
    "invalid-chat",
  ])("rejects %s before contacting Telegram", async (scenario) => {
    const send = vi.fn();
    vi.stubGlobal("fetch", send);
    const card = {
      chatId: "42",
      text: "exact preview",
      approveData: `dc:a:${"a".repeat(32)}`,
      declineData: `dc:d:${"a".repeat(32)}`,
    };
    if (scenario === "oversized-preview") card.text = "x".repeat(4097);
    if (scenario === "invalid-token") card.approveData = "approve";
    if (scenario === "mismatched-tokens")
      card.declineData = `dc:d:${"b".repeat(32)}`;
    if (scenario === "invalid-chat") card.chatId = "@untrusted";
    await expect(
      channels.telegramPlugin.sendApproval!(env, card),
    ).rejects.toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "false-ok",
    "no-message-id",
    "zero-message-id",
    "oversized",
    "network",
    "redirect",
  ])(
    "sanitizes %s approval delivery failures without retrying",
    async (scenario) => {
      const send = vi.fn(async () => {
        if (scenario === "network") throw new Error(env.TELEGRAM_BOT_TOKEN);
        if (scenario === "oversized") return new Response("x".repeat(65537));
        if (scenario === "redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://evil.test" },
          });
        return Response.json({
          ok: scenario !== "false-ok",
          result: scenario === "zero-message-id" ? { message_id: 0 } : {},
          description: env.TELEGRAM_BOT_TOKEN,
        });
      });
      vi.stubGlobal("fetch", send);
      await expect(
        channels.telegramPlugin.sendApproval!(env, {
          chatId: "42",
          text: "exact preview",
          approveData: `dc:a:${"a".repeat(32)}`,
          declineData: `dc:d:${"a".repeat(32)}`,
        }),
      ).rejects.toThrow("Telegram approval unavailable");
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("dismisses callback progress and removes consumed buttons with fixed bounded API calls", async () => {
    const send = vi.fn(async () => Response.json({ ok: true, result: true }));
    vi.stubGlobal("fetch", send);
    await channels.telegramPlugin.answerCallback!(env, {
      callbackId: "callback_1",
      text: "Decision received.",
    });
    await channels.telegramPlugin.clearApproval!(env, {
      chatId: "42",
      messageId: "99",
    });
    expect(
      send.mock.calls.map(([url]) => String(url).split("/").at(-1)),
    ).toEqual(["answerCallbackQuery", "editMessageReplyMarkup"]);
    expect(
      JSON.parse((send.mock.calls[0][1] as RequestInit).body as string),
    ).toEqual({
      callback_query_id: "callback_1",
      text: "Decision received.",
      cache_time: 0,
    });
    expect(
      JSON.parse((send.mock.calls[1][1] as RequestInit).body as string),
    ).toEqual({
      chat_id: "42",
      message_id: 99,
      reply_markup: { inline_keyboard: [] },
    });
    expect(
      send.mock.calls.every(
        ([, init]) => (init as RequestInit).redirect === "manual",
      ),
    ).toBe(true);
  });

  it("bounds webhook input even without a content length", async () => {
    await expect(
      channels.telegramPlugin.receive(
        request({ padding: "x".repeat(65537) }),
        env,
      ),
    ).rejects.toMatchObject({ status: 413 });
  });

  it("sends one bounded plain-text message with link previews disabled", async () => {
    const send = vi.fn(async () =>
      Response.json({ ok: true, result: { message_id: 9 } }),
    );
    vi.stubGlobal("fetch", send);
    await channels.telegramPlugin.send(env, {
      chatId: "42",
      text: "<b>untrusted</b>" + "😀".repeat(5000),
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(
      "https://api.telegram.org/bot123456:abcdefghijk/sendMessage",
    );
    const init = send.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.chat_id).toBe("42");
    expect(body.text.length).toBeLessThanOrEqual(4096);
    expect(body.text).toContain("<b>untrusted</b>");
    expect(body.parse_mode).toBeUndefined();
    expect(body.link_preview_options).toEqual({ is_disabled: true });
    expect(init.redirect).toBe("manual");
  });

  it("fails without retrying ambiguous delivery and hides the bot token", async () => {
    const send = vi.fn(async () => {
      throw new Error(
        `request failed for https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      );
    });
    vi.stubGlobal("fetch", send);
    await expect(
      channels.telegramPlugin.send(env, { chatId: "42", text: "test" }),
    ).rejects.toThrow("Telegram delivery failed");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends a cancellable typing action without message content or redirects", async () => {
    const send = vi.fn(async () => Response.json({ ok: true, result: true }));
    vi.stubGlobal("fetch", send);
    const controller = new AbortController();
    await channels.telegramPlugin.sendTyping!(
      env,
      { chatId: "42" },
      controller.signal,
    );
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: "42",
      action: "typing",
    });
    expect(init.redirect).toBe("manual");
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
    await expect(
      channels.telegramPlugin.sendTyping!(
        env,
        { chatId: "42" },
        controller.signal,
      ),
    ).rejects.toThrow("Messaging activity unavailable");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["-100", "@someone", "https://evil.test", "0"])(
    "rejects an unsafe typing recipient %s",
    async (chatId) => {
      const send = vi.fn();
      vi.stubGlobal("fetch", send);
      await expect(
        channels.telegramPlugin.sendTyping!(
          env,
          { chatId },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 429, 500])(
    "returns sanitized typing feedback for HTTP %s",
    async (status) => {
      const send = vi.fn(async () =>
        Response.json(
          {
            ok: false,
            description: env.TELEGRAM_BOT_TOKEN,
            parameters: { retry_after: 42 },
          },
          { status },
        ),
      );
      vi.stubGlobal("fetch", send);
      await expect(
        channels.telegramPlugin.sendTyping!(
          env,
          { chatId: "42" },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({
        status,
        retryAfterMs: status === 429 ? 42000 : 30000,
        message: "Messaging activity unavailable",
      });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["invalid-json", "oversized", "network"])(
    "sanitizes a %s typing failure",
    async (failure) => {
      vi.stubGlobal("fetch", async () => {
        if (failure === "network") throw new Error(env.TELEGRAM_BOT_TOKEN);
        return new Response(
          failure === "oversized" ? "x".repeat(65537) : "not json",
        );
      });
      await expect(
        channels.telegramPlugin.sendTyping!(
          env,
          { chatId: "42" },
          new AbortController().signal,
        ),
      ).rejects.toThrow("Messaging activity unavailable");
    },
  );
});

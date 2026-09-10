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

afterEach(() => vi.unstubAllGlobals());

describe("Telegram messaging adapter", () => {
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

  it("ignores edits and callback queries", async () => {
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

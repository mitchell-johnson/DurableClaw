import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as channels from "../../src/channels";
import { sendLinkedReply, sendLinkedTyping } from "../../src/channels/service";
import type { AgentPrincipal } from "../../src/types";
import type {
  MessagingEnv,
  MessagingEvent,
  MessagingPlugin,
} from "../../src/channels";

const databases: Database.Database[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
});

// Execute the production migration and SQL with actual SQLite transactions.
function fixture() {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  sqlite.exec(
    readFileSync(
      new URL("../../migrations/0002_messaging.sql", import.meta.url),
      "utf8",
    ),
  );
  function statement(
    query: string,
    values: unknown[] = [],
  ): D1PreparedStatement {
    const run = () => {
      const prepared = sqlite.prepare(query);
      const results = prepared.reader ? prepared.all(...values) : [];
      const changes = prepared.reader
        ? Number(sqlite.prepare("SELECT changes() AS count").get()?.count)
        : prepared.run(...values).changes;
      return { success: true, results, meta: { changes } };
    };
    return {
      bind: (...bindings: unknown[]) => statement(query, bindings),
      first: async () => sqlite.prepare(query).get(...values) ?? null,
      all: async () => run(),
      run: async () => run(),
      __run: run,
    } as D1PreparedStatement;
  }
  const db = {
    prepare: (query: string) => statement(query),
    batch: async (statements: D1PreparedStatement[]) =>
      sqlite.transaction(() =>
        statements.map((item) =>
          (item as D1PreparedStatement & { __run: () => unknown }).__run(),
        ),
      )(),
  } as D1Database;
  const sent: Array<{ chatId: string; text: string }> = [];
  const plugin: MessagingPlugin = {
    id: "example",
    label: "Example",
    configured: () => true,
    receive: async (request) => {
      if (request.headers.get("test-auth") !== "provider-secret")
        throw new channels.MessagingError("Unauthenticated", 401);
      return request.json();
    },
    send: async (_env, reply) => {
      sent.push(reply);
    },
  };
  return {
    sqlite,
    env: { CONTROL_DB: db } satisfies MessagingEnv,
    plugin,
    registry: channels.createMessagingRegistry([plugin]),
    sent,
  };
}

const owner: AgentPrincipal = {
  userId: "alice",
  workspaceId: "workspace",
  role: "owner",
};
const other: AgentPrincipal = {
  userId: "bob",
  workspaceId: "workspace",
  role: "owner",
};
const ownerRequest = (path: string, method = "GET", body?: unknown) =>
  new Request(`https://claw.test/api/messaging/${path}`, {
    method,
    ...(body
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
const event = (overrides: Partial<MessagingEvent> = {}): MessagingEvent => ({
  eventId: "1",
  senderId: "sender",
  chatId: "private-chat",
  occurredAt: Date.now(),
  content: "hello",
  ...overrides,
});
const webhook = (data: MessagingEvent) =>
  new Request("https://claw.test/api/messaging/webhooks/example", {
    method: "POST",
    headers: { "test-auth": "provider-secret" },
    body: JSON.stringify(data),
  });
const dispatch = () => vi.fn(async () => ({ text: "Agent reply" }));
async function issue(f: ReturnType<typeof fixture>, p = owner) {
  const response = await channels.handleMessagingOwnerRequest(
    ownerRequest("link-codes", "POST", {
      pluginId: "example",
      conversationId: "conversation",
    }),
    f.env,
    p,
    f.registry,
  );
  expect(response?.status).toBe(201);
  return (await response!.json()) as { code: string; expiresAt: number };
}
async function link(
  f: ReturnType<typeof fixture>,
  p = owner,
  senderId = "sender",
  chatId = "private-chat",
) {
  const code = await issue(f, p);
  const response = await channels.handleMessagingWebhook(
    webhook(event({ senderId, chatId, content: `/start ${code.code}` })),
    f.env,
    dispatch(),
    f.registry,
  );
  expect(response.status).toBe(200);
  return code;
}

describe("shared messaging authorization and delivery", () => {
  async function linkedWork(f: ReturnType<typeof fixture>) {
    await link(f);
    const callback = dispatch();
    await channels.handleMessagingWebhook(
      webhook(event({ eventId: "work" })),
      f.env,
      callback,
      f.registry,
    );
    return callback.mock.calls[0][1].requestId as string;
  }

  it("sends activity only to the accepting link with matching owner and conversation", async () => {
    const f = fixture();
    const requestId = await linkedWork(f);
    f.plugin.sendTyping = vi.fn(async () => {});
    const signal = new AbortController().signal;
    const ping = (p = owner, conversation = "conversation", id = requestId) =>
      sendLinkedTyping(f.env, p, conversation, id, signal, f.registry);
    expect(await ping()).toBe(true);
    expect(f.plugin.sendTyping).toHaveBeenCalledExactlyOnceWith(
      f.env,
      { chatId: "private-chat" },
      signal,
    );
    expect(await ping(other)).toBe(false);
    expect(await ping({ ...owner, role: "reader" })).toBe(false);
    expect(await ping(owner, "different")).toBe(false);
    expect(await ping(owner, "conversation", "unknown")).toBe(false);
    f.sqlite.prepare("DELETE FROM messaging_links").run();
    await channels.handleMessagingWebhook(
      webhook(
        event({
          eventId: "new-link",
          content: `/start ${(await issue(f)).code}`,
        }),
      ),
      f.env,
      dispatch(),
      f.registry,
    );
    expect(await ping()).toBe(false);
    expect(f.plugin.sendTyping).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation while resolving a typing recipient", async () => {
    const f = fixture();
    const requestId = await linkedWork(f);
    f.plugin.sendTyping = vi.fn(async () => {});
    const controller = new AbortController();
    const promise = sendLinkedTyping(
      f.env,
      owner,
      "conversation",
      requestId,
      controller.signal,
      f.registry,
    );
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(f.plugin.sendTyping).not.toHaveBeenCalled();
  });

  it("allows plugins without activity support and expires old request links", async () => {
    const f = fixture();
    const requestId = await linkedWork(f);
    const ping = () =>
      sendLinkedTyping(
        f.env,
        owner,
        "conversation",
        requestId,
        new AbortController().signal,
        f.registry,
      );
    expect(await ping()).toBe(false);
    f.plugin.sendTyping = vi.fn(async () => {});
    f.sqlite.prepare("UPDATE messaging_deliveries SET expires_at=0").run();
    expect(await ping()).toBe(false);
    expect(f.plugin.sendTyping).not.toHaveBeenCalled();
  });

  it("claims a later result once under concurrency and waits for the initial reply", async () => {
    const f = fixture();
    const requestId = await linkedWork(f);
    const reply = {
      conversationId: "conversation",
      requestId,
      messageId: "batch-result",
      text: "All 20 agents counted to 10",
    };
    const send = () => sendLinkedReply(f.env, owner, reply, f.registry);
    f.sqlite
      .prepare(
        "UPDATE messaging_deliveries SET status='processing' WHERE request_id=?",
      )
      .run(requestId);
    expect(await send()).toBe("pending");
    expect(f.sent).toHaveLength(2);
    f.sqlite
      .prepare(
        "UPDATE messaging_deliveries SET status='sent' WHERE request_id=?",
      )
      .run(requestId);
    await Promise.all(Array.from({ length: 10 }, send));
    expect(f.sent).toHaveLength(3);
    expect(f.sent[2]).toEqual({ chatId: "private-chat", text: reply.text });
    expect(
      f.sqlite
        .prepare(
          "SELECT status FROM messaging_deliveries WHERE request_id LIKE 'reply_%'",
        )
        .all(),
    ).toEqual([{ status: "sent" }]);
  });

  it("does not let a crashed initial webhook hold a completed batch indefinitely", async () => {
    const f = fixture();
    const requestId = await linkedWork(f);
    f.sqlite
      .prepare(
        "UPDATE messaging_deliveries SET status='sending',updated_at=? WHERE request_id=?",
      )
      .run(Date.now() - 111000, requestId);
    expect(
      await sendLinkedReply(
        f.env,
        owner,
        {
          conversationId: "conversation",
          requestId,
          messageId: "later",
          text: "Result",
        },
        f.registry,
      ),
    ).toBe("done");
    expect(f.sent).toHaveLength(3);
  });

  it("never retries an ambiguous background result send", async () => {
    const f = fixture();
    const requestId = await linkedWork(f);
    f.plugin.send = vi.fn(async () => {
      throw new Error("ambiguous send");
    });
    const send = () =>
      sendLinkedReply(
        f.env,
        owner,
        {
          conversationId: "conversation",
          requestId,
          messageId: "later",
          text: "Result",
        },
        f.registry,
      );
    await send();
    await send();
    expect(f.plugin.send).toHaveBeenCalledTimes(1);
    expect(
      f.sqlite
        .prepare(
          "SELECT status FROM messaging_deliveries WHERE request_id LIKE 'reply_%'",
        )
        .all(),
    ).toEqual([{ status: "send_unknown" }]);
  });

  it("never retargets background results after unlink/relink or to another owner", async () => {
    const f = fixture();
    const requestId = await linkedWork(f);
    const reply = {
      conversationId: "conversation",
      requestId,
      messageId: "later",
      text: "Private result",
    };
    await sendLinkedReply(f.env, other, reply, f.registry);
    await sendLinkedReply(
      f.env,
      owner,
      { ...reply, conversationId: "other" },
      f.registry,
    );
    f.sqlite.prepare("DELETE FROM messaging_links").run();
    await channels.handleMessagingWebhook(
      webhook(
        event({
          eventId: "new-link",
          content: `/start ${(await issue(f)).code}`,
        }),
      ),
      f.env,
      dispatch(),
      f.registry,
    );
    await sendLinkedReply(f.env, owner, reply, f.registry);
    expect(f.sent.map((reply) => reply.text)).not.toContain("Private result");
  });

  it("exports the shared owner and webhook handlers", () => {
    expect(channels).toHaveProperty("handleMessagingOwnerRequest");
    expect(channels).toHaveProperty("handleMessagingWebhook");
  });

  it("stores only a hash of a random expiring owner code and replaces prior codes", async () => {
    const f = fixture();
    const one = await issue(f);
    const two = await issue(f);
    expect(one.code).not.toBe(two.code);
    expect(two.code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(two.expiresAt - Date.now()).toBeGreaterThan(9 * 60_000);
    const rows = f.sqlite.prepare("SELECT * FROM messaging_link_codes").all();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(two.code);
  });

  it("uses one-time linking and isolates stable external identities across owners", async () => {
    const f = fixture();
    const code = await link(f);
    const callback = dispatch();
    await channels.handleMessagingWebhook(
      webhook(
        event({
          eventId: "2",
          content: `/start ${code.code}`,
          senderId: "attacker",
          chatId: "attacker",
        }),
      ),
      f.env,
      callback,
      f.registry,
    );
    await channels.handleMessagingWebhook(
      webhook(event({ eventId: "3", content: "hi" })),
      f.env,
      callback,
      f.registry,
    );
    expect(callback).toHaveBeenCalledExactlyOnceWith(
      owner,
      expect.objectContaining({
        content: "hi",
        conversationId: "conversation",
        requestId: expect.stringMatching(/^msg_[a-f0-9]{64}$/),
      }),
    );
    const bobCode = await issue(f, other);
    await channels.handleMessagingWebhook(
      webhook(event({ eventId: "4", content: `/start ${bobCode.code}` })),
      f.env,
      callback,
      f.registry,
    );
    expect(
      f.sqlite.prepare("SELECT user_id FROM messaging_links").all(),
    ).toEqual([{ user_id: "alice" }]);
  });

  it("rejects expired linking and never dispatches unlinked or mismatched chats", async () => {
    const f = fixture();
    const code = await issue(f);
    f.sqlite.prepare("UPDATE messaging_link_codes SET expires_at = 0").run();
    const callback = dispatch();
    await channels.handleMessagingWebhook(
      webhook(event({ content: `/start ${code.code}` })),
      f.env,
      callback,
      f.registry,
    );
    await channels.handleMessagingWebhook(
      webhook(event({ eventId: "2" })),
      f.env,
      callback,
      f.registry,
    );
    expect(callback).not.toHaveBeenCalled();
    await link(f);
    await channels.handleMessagingWebhook(
      webhook(event({ eventId: "3", chatId: "different-chat" })),
      f.env,
      callback,
      f.registry,
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it("claims concurrent duplicate deliveries exactly once", async () => {
    const f = fixture();
    await link(f);
    const callback = dispatch();
    const message = event({ eventId: "2" });
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        channels.handleMessagingWebhook(
          webhook(message),
          f.env,
          callback,
          f.registry,
        ),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(f.sent.filter((reply) => reply.text === "Agent reply")).toHaveLength(
      1,
    );
  });

  it("allows only one recipient to redeem a code under concurrent requests", async () => {
    const f = fixture();
    const code = await issue(f);
    await Promise.all(
      ["one", "two"].map((id) =>
        channels.handleMessagingWebhook(
          webhook(
            event({
              eventId: id,
              senderId: id,
              chatId: id,
              content: `/start ${code.code}`,
            }),
          ),
          f.env,
          dispatch(),
          f.registry,
        ),
      ),
    );
    expect(
      f.sqlite.prepare("SELECT * FROM messaging_links").all(),
    ).toHaveLength(1);
    expect(
      f.sqlite.prepare("SELECT * FROM messaging_link_codes").all(),
    ).toHaveLength(0);
    expect(f.sent).toHaveLength(1);
  });

  it("suppresses outbound content when the owner unlinks during agent execution", async () => {
    const f = fixture();
    await link(f);
    const before = f.sent.length;
    const callback = vi.fn(async () => {
      f.sqlite.prepare("DELETE FROM messaging_links").run();
      return { text: "Private agent output" };
    });
    await channels.handleMessagingWebhook(
      webhook(event({ eventId: "2" })),
      f.env,
      callback,
      f.registry,
    );
    expect(f.sent).toHaveLength(before);
    expect(
      f.sqlite
        .prepare("SELECT status FROM messaging_deliveries WHERE event_id='2'")
        .get(),
    ).toEqual({ status: "unlinked" });
  });

  it("preserves dedupe through unlink and relink", async () => {
    const f = fixture();
    await link(f);
    const callback = dispatch();
    await channels.handleMessagingWebhook(
      webhook(event({ eventId: "2" })),
      f.env,
      callback,
      f.registry,
    );
    const old = f.sqlite.prepare("SELECT id FROM messaging_links").get() as {
      id: string;
    };
    await channels.handleMessagingOwnerRequest(
      ownerRequest(`links/${old.id}`, "DELETE"),
      f.env,
      owner,
      f.registry,
    );
    const code = await issue(f);
    await channels.handleMessagingWebhook(
      webhook(event({ eventId: "3", content: `/start ${code.code}` })),
      f.env,
      callback,
      f.registry,
    );
    await channels.handleMessagingWebhook(
      webhook(event({ eventId: "2" })),
      f.env,
      callback,
      f.registry,
    );
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("authenticates ingress before storing delivery records", async () => {
    const f = fixture();
    await link(f);
    const forged = webhook(event({ eventId: "2" }));
    forged.headers.delete("test-auth");
    const callback = dispatch();
    expect(
      (
        await channels.handleMessagingWebhook(
          forged,
          f.env,
          callback,
          f.registry,
        )
      ).status,
    ).toBe(401);
    expect(callback).not.toHaveBeenCalled();
    expect(
      f.sqlite
        .prepare("SELECT * FROM messaging_deliveries WHERE event_id='2'")
        .all(),
    ).toHaveLength(0);
  });

  it("does not rerun the agent after an ambiguous dispatch or provider send", async () => {
    const f = fixture();
    await link(f);
    const callback = vi.fn(async () => {
      throw new Error("dispatch connection lost");
    });
    const message = event({ eventId: "2" });
    await channels.handleMessagingWebhook(
      webhook(message),
      f.env,
      callback,
      f.registry,
    );
    await channels.handleMessagingWebhook(
      webhook(message),
      f.env,
      callback,
      f.registry,
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(
      f.sqlite
        .prepare("SELECT status FROM messaging_deliveries WHERE event_id='2'")
        .get(),
    ).toEqual({ status: "dispatch_unknown" });
    f.plugin.send = async () => {
      throw new Error("send timeout");
    };
    const secondCallback = dispatch();
    await channels.handleMessagingWebhook(
      webhook(event({ eventId: "3" })),
      f.env,
      secondCallback,
      f.registry,
    );
    await channels.handleMessagingWebhook(
      webhook(event({ eventId: "3" })),
      f.env,
      secondCallback,
      f.registry,
    );
    expect(secondCallback).toHaveBeenCalledTimes(1);
    expect(
      f.sqlite
        .prepare("SELECT status FROM messaging_deliveries WHERE event_id='3'")
        .get(),
    ).toEqual({ status: "send_unknown" });
  });

  it("rejects old replays after dedupe records expire and drops future events", async () => {
    const f = fixture();
    await link(f);
    const callback = dispatch();
    await channels.handleMessagingWebhook(
      webhook(event({ eventId: "2", occurredAt: Date.now() - 25 * 3600_000 })),
      f.env,
      callback,
      f.registry,
    );
    await channels.handleMessagingWebhook(
      webhook(event({ eventId: "3", occurredAt: Date.now() + 10 * 60_000 })),
      f.env,
      callback,
      f.registry,
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it("enforces owner-only management and does not allow cross-owner unlink", async () => {
    const f = fixture();
    await link(f);
    const row = f.sqlite.prepare("SELECT id FROM messaging_links").get() as {
      id: string;
    };
    expect(
      (
        await channels.handleMessagingOwnerRequest(
          ownerRequest("links"),
          f.env,
          { ...owner, role: "member" },
          f.registry,
        )
      )?.status,
    ).toBe(403);
    expect(
      await (
        await channels.handleMessagingOwnerRequest(
          ownerRequest("links"),
          f.env,
          other,
          f.registry,
        )
      )?.json(),
    ).toEqual({ links: [] });
    expect(
      (
        await channels.handleMessagingOwnerRequest(
          ownerRequest(`links/${row.id}`, "DELETE"),
          f.env,
          other,
          f.registry,
        )
      )?.status,
    ).toBe(404);
    expect(
      (
        await channels.handleMessagingOwnerRequest(
          ownerRequest(`links/${row.id}`, "DELETE"),
          f.env,
          owner,
          f.registry,
        )
      )?.status,
    ).toBe(200);
    const callback = dispatch();
    await channels.handleMessagingWebhook(
      webhook(event({ eventId: "2" })),
      f.env,
      callback,
      f.registry,
    );
    expect(callback).not.toHaveBeenCalled();
  });

  it("caps retained deliveries without evicting fresh dedupe claims", async () => {
    const f = fixture();
    await link(f);
    const callback = dispatch();
    for (let id = 2; id < 1030; id++)
      await channels.handleMessagingWebhook(
        webhook(event({ eventId: String(id) })),
        f.env,
        callback,
        f.registry,
      );
    expect(
      Number(
        (
          f.sqlite
            .prepare("SELECT COUNT(*) AS count FROM messaging_deliveries")
            .get() as { count: number }
        ).count,
      ),
    ).toBeLessThanOrEqual(1024);
    expect(callback.mock.calls.length).toBeLessThanOrEqual(1024);
  });

  it("supports trusted additional plugins and rejects ambiguous registry IDs", async () => {
    const f = fixture();
    const response = await channels.handleMessagingOwnerRequest(
      ownerRequest("plugins"),
      f.env,
      owner,
      f.registry,
    );
    expect(await response?.json()).toEqual({
      plugins: [{ id: "example", label: "Example", configured: true }],
    });
    expect(() =>
      channels.createMessagingRegistry([f.plugin, f.plugin]),
    ).toThrow();
    expect(() =>
      channels.createMessagingRegistry([{ ...f.plugin, id: "../invalid" }]),
    ).toThrow();
  });
});

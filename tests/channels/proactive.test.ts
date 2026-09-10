import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMessagingRegistry,
  type MessagingPlugin,
} from "../../src/channels/plugin";
import { sendLinkedNotification } from "../../src/channels/service";
import type { AgentPrincipal, Env } from "../../src/types";

const databases: Database.Database[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
});
const owner: AgentPrincipal = {
  userId: "alice",
  workspaceId: "workspace",
  role: "owner",
};
const notification = {
  id: "heartbeat-1",
  text: "An important new email arrived.",
};

function fixture() {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  sqlite.exec(
    readFileSync(
      new URL("../../migrations/0002_messaging.sql", import.meta.url),
      "utf8",
    ),
  );
  let afterClaim: (() => void) | undefined;
  let afterRead: ((query: string) => void) | undefined;
  let beforeRun: ((query: string) => void) | undefined;
  let role = "owner";
  function statement(
    query: string,
    values: unknown[] = [],
  ): D1PreparedStatement {
    const run = () => {
      beforeRun?.(query);
      const prepared = sqlite.prepare(query);
      const results = prepared.reader ? prepared.all(...values) : [];
      const changes = prepared.reader ? 0 : prepared.run(...values).changes;
      if (
        query.startsWith("INSERT OR IGNORE INTO messaging_deliveries") &&
        changes
      )
        afterClaim?.();
      if (prepared.reader) afterRead?.(query);
      return { success: true, results, meta: { changes } };
    };
    return {
      bind: (...bindings: unknown[]) => statement(query, bindings),
      first: async () => {
        const result = sqlite.prepare(query).get(...values) ?? null;
        afterRead?.(query);
        return result;
      },
      all: async () => run(),
      run: async () => run(),
    } as D1PreparedStatement;
  }
  const auth = vi.fn(async (_url: unknown, init: RequestInit) => {
    const p = JSON.parse(String(init.body));
    return Response.json({ ...p, role });
  });
  const env = {
    CONTROL_DB: { prepare: statement },
    AUTH: { fetch: auth },
  } as unknown as Env;
  const plugin: MessagingPlugin = {
    id: "example",
    label: "Example",
    configured: () => true,
    receive: async () => null,
    send: vi.fn(async () => {}),
  };
  const registry = createMessagingRegistry([plugin]);
  function link(
    id = "link",
    user = owner.userId,
    workspace = owner.workspaceId,
    pluginId = plugin.id,
  ) {
    sqlite
      .prepare("INSERT INTO messaging_links VALUES (?,?,?,?,?,?,?,?)")
      .run(
        id,
        user,
        workspace,
        pluginId,
        `sender-${id}`,
        `chat-${id}`,
        `conversation-${id}`,
        Date.now(),
      );
  }
  function fill(
    count: number,
    expires = Date.now() + 60_000,
    user = owner.userId,
    workspace = owner.workspaceId,
  ) {
    const insert = sqlite.prepare(
      "INSERT INTO messaging_deliveries VALUES (?,?, 'link',?,?, 'example','sent',?,?,?)",
    );
    sqlite.transaction(() => {
      for (let i = 0; i < count; i++)
        insert.run(
          `old-${user}-${workspace}-${i}`,
          `old-${user}-${workspace}-${i}`,
          user,
          workspace,
          Date.now(),
          Date.now(),
          expires,
        );
    })();
  }
  const deliver = (p = owner, data = notification) =>
    sendLinkedNotification(env, p, data, registry);
  return {
    sqlite,
    env,
    auth,
    plugin,
    registry,
    link,
    fill,
    deliver,
    afterClaim: (hook: () => void) => {
      afterClaim = hook;
    },
    afterRead: (hook: (query: string) => void) => {
      afterRead = hook;
    },
    beforeRun: (hook: (query: string) => void) => {
      beforeRun = hook;
    },
    setRole: (value: string) => {
      role = value;
    },
  };
}

describe("proactive linked notifications", () => {
  it("sends without an inbound request only to links in the same owner and workspace", async () => {
    const f = fixture();
    f.link();
    f.link("another-owner", "bob");
    f.link("another-workspace", "alice", "other");
    await f.deliver();
    expect(f.plugin.send).toHaveBeenCalledExactlyOnceWith(f.env, {
      chatId: "chat-link",
      text: notification.text,
    });
    expect(
      f.sqlite.prepare("SELECT status FROM messaging_deliveries").all(),
    ).toEqual([{ status: "sent" }]);
  });

  it("keeps an independent stable claim for each configured linked plugin", async () => {
    const f = fixture();
    f.link();
    const second = { ...f.plugin, id: "second", send: vi.fn(async () => {}) };
    f.link("second-link", "alice", "workspace", "second");
    const registry = createMessagingRegistry([f.plugin, second]);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        sendLinkedNotification(f.env, owner, notification, registry),
      ),
    );
    expect(f.plugin.send).toHaveBeenCalledTimes(1);
    expect(second.send).toHaveBeenCalledExactlyOnceWith(f.env, {
      chatId: "chat-second-link",
      text: notification.text,
    });
    expect(
      f.sqlite
        .prepare("SELECT COUNT(*) AS count FROM messaging_deliveries")
        .get(),
    ).toEqual({ count: 2 });
  });

  it("does not send to a reader, revoked owner, absent link, or disabled plugin", async () => {
    const f = fixture();
    await f.deliver();
    f.link();
    await f.deliver({ ...owner, role: "reader" });
    f.setRole("reader");
    await expect(f.deliver()).rejects.toThrow("Owner access required");
    f.setRole("owner");
    f.plugin.configured = () => false;
    await f.deliver();
    expect(f.plugin.send).not.toHaveBeenCalled();
    expect(
      f.sqlite
        .prepare("SELECT COUNT(*) AS count FROM messaging_deliveries")
        .get(),
    ).toEqual({ count: 0 });
  });

  it.each([
    "unlink",
    "relink",
    "change-recipient",
    "revocation",
    "configuration",
  ])(
    "rechecks %s after claiming without exposing the message",
    async (change) => {
      const f = fixture();
      f.link();
      f.afterClaim(() => {
        if (change === "unlink" || change === "relink")
          f.sqlite.prepare("DELETE FROM messaging_links").run();
        if (change === "relink") f.link("replacement");
        if (change === "change-recipient")
          f.sqlite
            .prepare("UPDATE messaging_links SET chat_id='another-chat'")
            .run();
        if (change === "revocation") f.setRole("reader");
        if (change === "configuration") f.plugin.configured = () => false;
      });
      await f.deliver().catch((error) => {
        if (change !== "revocation") throw error;
      });
      expect(f.plugin.send).not.toHaveBeenCalled();
    },
  );

  it("never repeats an ambiguous provider call", async () => {
    const f = fixture();
    f.link();
    f.plugin.send = vi.fn(async () => {
      throw new Error("Provider timeout");
    });
    await f.deliver();
    await f.deliver();
    expect(f.plugin.send).toHaveBeenCalledTimes(1);
    expect(
      f.sqlite.prepare("SELECT status FROM messaging_deliveries").get(),
    ).toEqual({ status: "send_unknown" });
  });

  it("never repeats a provider call when final status persistence fails", async () => {
    const f = fixture();
    f.link();
    f.beforeRun((query) => {
      if (query.startsWith("UPDATE messaging_deliveries"))
        throw new Error("Storage unavailable");
    });
    await expect(f.deliver()).rejects.toThrow("Storage unavailable");
    expect(
      f.sqlite.prepare("SELECT status FROM messaging_deliveries").get(),
    ).toEqual({ status: "sending" });
    await f.deliver();
    expect(f.plugin.send).toHaveBeenCalledTimes(1);
  });

  it.each(["sent", "send_unknown", "sending"])(
    "keeps a %s notification deduplicated after unlinking and relinking",
    async (status) => {
      const f = fixture();
      f.link();
      await f.deliver();
      f.sqlite.prepare("UPDATE messaging_deliveries SET status=?").run(status);
      f.sqlite.prepare("DELETE FROM messaging_links").run();
      f.link("replacement");
      await f.deliver();
      expect(f.plugin.send).toHaveBeenCalledTimes(1);
      expect(
        f.sqlite.prepare("SELECT link_id FROM messaging_deliveries").all(),
      ).toEqual([{ link_id: "link" }]);
    },
  );

  it("deduplicates the same notification independently across owners and workspaces", async () => {
    const f = fixture();
    f.link();
    f.link("bob", "bob");
    f.link("other-workspace", "alice", "other");
    await f.deliver();
    await f.deliver({ ...owner, userId: "bob" });
    await f.deliver({ ...owner, workspaceId: "other" });
    expect(f.plugin.send).toHaveBeenCalledTimes(3);
  });

  it.each(["authorization", "links", "claim", "recipient"])(
    "honors cancellation after %s preparation",
    async (stage) => {
      const f = fixture();
      f.link();
      let enabled = true;
      if (stage === "authorization")
        f.auth.mockImplementationOnce(async () => {
          enabled = false;
          return Response.json(owner);
        });
      if (stage === "claim")
        f.afterClaim(() => {
          enabled = false;
        });
      if (stage === "links" || stage === "recipient")
        f.afterRead((query) => {
          if (
            query.startsWith(
              stage === "links"
                ? "SELECT * FROM messaging_links"
                : "SELECT id FROM messaging_links",
            )
          )
            enabled = false;
        });
      await sendLinkedNotification(
        f.env,
        owner,
        { ...notification, shouldSend: () => enabled },
        f.registry,
      );
      expect(f.plugin.send).not.toHaveBeenCalled();
    },
  );

  it("retries preparation safely after an authority failure following a claim", async () => {
    const f = fixture();
    f.link();
    f.afterClaim(() => {
      f.setRole("reader");
    });
    await expect(f.deliver()).rejects.toMatchObject({ status: 403 });
    expect(
      f.sqlite
        .prepare("SELECT COUNT(*) AS count FROM messaging_deliveries")
        .get(),
    ).toEqual({ count: 0 });
    f.afterClaim(() => {});
    f.setRole("owner");
    await f.deliver();
    expect(f.plugin.send).toHaveBeenCalledTimes(1);
  });

  it("reports capacity as retryable instead of acknowledging an unsent notification", async () => {
    const f = fixture();
    f.link();
    f.fill(1024);
    await expect(f.deliver()).rejects.toMatchObject({ status: 503 });
    expect(f.plugin.send).not.toHaveBeenCalled();
    f.sqlite
      .prepare(
        "DELETE FROM messaging_deliveries WHERE request_id='old-alice-workspace-0'",
      )
      .run();
    await f.deliver();
    await f.deliver();
    expect(f.plugin.send).toHaveBeenCalledTimes(1);
  });

  it("prunes expired tenant claims before enforcing the bounded retention cap", async () => {
    const f = fixture();
    f.link();
    f.fill(1024, Date.now() - 1);
    f.fill(3, Date.now() - 1, "bob");
    await f.deliver();
    expect(f.plugin.send).toHaveBeenCalledTimes(1);
    expect(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM messaging_deliveries WHERE user_id='alice'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      f.sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM messaging_deliveries WHERE user_id='bob'",
        )
        .get(),
    ).toEqual({ count: 3 });
  });

  it("bounds provider text and rejects invalid notification input before making claims", async () => {
    const f = fixture();
    f.link();
    await expect(
      f.deliver(owner, { id: "", text: "message" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.deliver(owner, { id: "id", text: " " }),
    ).rejects.toMatchObject({ status: 400 });
    await f.deliver(owner, { id: "large", text: "x".repeat(10_000) });
    const call = vi.mocked(f.plugin.send).mock.calls[0][1];
    expect(call.text.length).toBeLessThanOrEqual(4096);
  });
});

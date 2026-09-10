import { beforeEach, expect, it, vi } from "vitest";
import { createGmailObserver } from "../src/services/proactive/gmailObserver";
import type { ObserverContext } from "../src/services/proactive/types";

const mocks = vi.hoisted(() => ({ list: vi.fn(), call: vi.fn() }));
vi.mock("../src/connectors/client", () => ({
  connectorsConfigured: () => true,
  listServiceConnections: mocks.list,
  callConnectorService: mocks.call,
}));
const owner = {
  userId: "owner",
  workspaceId: "workspace",
  role: "owner" as const,
};
const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const now = 1_800_000_000_000;
const account = (connectionId = id) => ({
  id: connectionId,
  provider: "google",
  account: "owner@example.com",
  status: "connected",
  services: ["gmail"],
  created_at: now - 86400_000,
});
function context(saved: string | null = null): ObserverContext {
  return {
    user: { id: owner.userId, role: owner.role },
    workspaceId: owner.workspaceId,
    db: {} as any,
    securedDb: {} as any,
    nowMs: now,
    readCursor: vi.fn(async () => saved),
    writeCursor: vi.fn(async () => {}),
  };
}
function event(messageId: string) {
  return {
    id: messageId,
    threadId: messageId,
    internalDate: String(now - 1000),
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Please review the deadline",
    payload: {
      headers: [
        { name: "From", value: "sender@example.com" },
        { name: "Subject", value: "Deadline" },
      ],
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.list.mockResolvedValue([account()]);
  mocks.call.mockImplementation(async (_env, _owner, _path, options) => {
    const args = options.body.arguments;
    return {
      result:
        options.body.operation === "gmail_list_events"
          ? { messages: [{ id: "abc" }] }
          : event(args.message_id),
    };
  });
});
it("starts with the last hour, returns bounded untrusted metadata, and checkpoints only the completed window", async () => {
  const ctx = context();
  const signals = await createGmailObserver({ env: {} as any, owner }).observe(
    ctx,
  );
  expect(mocks.call.mock.calls[0][3].body).toMatchObject({
    operation: "gmail_list_events",
    arguments: { after: (now - 3600_000) / 1000, before: now / 1000 },
  });
  expect(signals).toHaveLength(1);
  expect(signals[0]).toMatchObject({
    kind: "email_arrived",
    entity_id: "abc",
    occurred_at: now - 1000,
    dedupe_key: `gmail:${id}:abc`,
  });
  expect(signals[0].summary).toContain("Untrusted email");
  const cursor = JSON.parse(vi.mocked(ctx.writeCursor).mock.calls[0][1]);
  expect(cursor.accounts[id].after).toBe(now / 1000 - 60);
});
it("continues a fixed snapshot across pages without losing more than 50 arrivals", async () => {
  let saved: string | null = null;
  const seen: string[] = [];
  mocks.call.mockImplementation(async (_env, _owner, _path, options) => {
    const args = options.body.arguments;
    if (options.body.operation !== "gmail_list_events")
      return { result: event(args.message_id) };
    const page = Number(args.page_token || 0);
    return {
      result: {
        messages: Array.from({ length: page < 2 ? 20 : 15 }, (_, i) => ({
          id: (page * 20 + i + 1).toString(16),
        })),
        ...(page < 2 ? { nextPageToken: String(page + 1) } : {}),
      },
    };
  });
  for (let i = 0; i < 3; i++) {
    const ctx = context(saved);
    ctx.nowMs += i * 3600_000;
    seen.push(
      ...(
        await createGmailObserver({ env: {} as any, owner }).observe(ctx)
      ).map((s) => s.entity_id),
    );
    saved = vi.mocked(ctx.writeCursor).mock.calls[0][1];
  }
  expect(new Set(seen).size).toBe(55);
  const calls = mocks.call.mock.calls.filter(
    (c) => c[3].body.operation === "gmail_list_events",
  );
  expect(calls.map((c) => c[3].body.arguments.before)).toEqual([
    now / 1000,
    now / 1000,
    now / 1000,
  ]);
  expect(calls.map((c) => c[3].body.arguments.page_token)).toEqual([
    undefined,
    "1",
    "2",
  ]);
});
it("does not advance a failing account or block another account", async () => {
  mocks.list.mockResolvedValue([account(), account(otherId)]);
  const prior = {
    version: 1,
    accounts: {
      [id]: { after: now / 1000 - 600 },
      [otherId]: { after: now / 1000 - 600 },
    },
  };
  const ctx = context(JSON.stringify(prior));
  mocks.call.mockImplementation(async (_env, _owner, _path, options) => {
    if (options.body.connection_id === id)
      throw new Error("private provider error");
    return {
      result:
        options.body.operation === "gmail_list_events"
          ? { messages: [{ id: "abc" }] }
          : event("abc"),
    };
  });
  const signals = await createGmailObserver({ env: {} as any, owner }).observe(
    ctx,
  );
  expect(signals).toHaveLength(1);
  expect(signals[0].dedupe_key).toBe(`gmail:${otherId}:abc`);
  expect(
    JSON.parse(vi.mocked(ctx.writeCursor).mock.calls[0][1]).accounts[id],
  ).toEqual(prior.accounts[id]);
});
it("does not query missing, disconnected, or ungranted accounts", async () => {
  mocks.list.mockResolvedValue([
    { ...account(), services: ["drive"] },
    { ...account(otherId), status: "reauth_required" },
  ]);
  const ctx = context();
  expect(
    await createGmailObserver({ env: {} as any, owner }).observe(ctx),
  ).toEqual([]);
  expect(mocks.call).not.toHaveBeenCalled();
});
it("discards a partially read page on failure so its cursor and signals can be retried together", async () => {
  const prior = { version: 1, accounts: { [id]: { after: now / 1000 - 600 } } };
  const ctx = context(JSON.stringify(prior));
  mocks.call.mockImplementation(async (_env, _owner, _path, options) => {
    if (options.body.operation === "gmail_list_events")
      return {
        result: {
          messages: [{ id: "abc" }, { id: "def" }],
          nextPageToken: "page2",
        },
      };
    if (options.body.arguments.message_id === "def") throw new Error("failed");
    return { result: event("abc") };
  });
  expect(
    await createGmailObserver({ env: {} as any, owner }).observe(ctx),
  ).toEqual([]);
  expect(
    JSON.parse(vi.mocked(ctx.writeCursor).mock.calls[0][1]).accounts[id],
  ).toEqual(prior.accounts[id]);
});
it("ignores deleted messages and sent, draft, spam or trashed content without blocking the page", async () => {
  const ctx = context();
  mocks.call.mockImplementation(async (_env, _owner, _path, options) => {
    if (options.body.operation === "gmail_list_events")
      return { result: { messages: [{ id: "abc" }, { id: "def" }] } };
    return {
      result:
        options.body.arguments.message_id === "abc"
          ? { missing: true }
          : { ...event("def"), labelIds: ["SENT"] },
    };
  });
  expect(
    await createGmailObserver({ env: {} as any, owner }).observe(ctx),
  ).toEqual([]);
  expect(
    JSON.parse(vi.mocked(ctx.writeCursor).mock.calls[0][1]).accounts[id].after,
  ).toBe(now / 1000 - 60);
});
it("rotates across more than five accounts while bounding each pass", async () => {
  const accounts = Array.from({ length: 7 }, (_, i) =>
    account(`${i + 1}1111111-1111-4111-8111-111111111111`),
  );
  mocks.list.mockResolvedValue(accounts);
  mocks.call.mockResolvedValue({ result: { messages: [] } });
  const first = context();
  await createGmailObserver({ env: {} as any, owner }).observe(first);
  expect(mocks.call).toHaveBeenCalledTimes(5);
  const saved = vi.mocked(first.writeCursor).mock.calls[0][1];
  mocks.call.mockClear();
  await createGmailObserver({ env: {} as any, owner }).observe(context(saved));
  expect(
    mocks.call.mock.calls.slice(0, 2).map((c) => c[3].body.connection_id),
  ).toEqual(accounts.slice(5).map((c) => c.id));
  expect(mocks.call).toHaveBeenCalledTimes(5);
});
it("rewinds an expired page token within the original window", async () => {
  const prior = {
    version: 1,
    accounts: {
      [id]: {
        after: now / 1000 - 600,
        before: now / 1000,
        pageToken: "expired",
      },
    },
  };
  mocks.call.mockRejectedValue(new Error("page expired"));
  const ctx = context(JSON.stringify(prior));
  expect(
    await createGmailObserver({ env: {} as any, owner }).observe(ctx),
  ).toEqual([]);
  expect(
    JSON.parse(vi.mocked(ctx.writeCursor).mock.calls[0][1]).accounts[id],
  ).toEqual({
    after: prior.accounts[id].after,
    before: prior.accounts[id].before,
  });
});
it("pins the initial baseline through a provider outage", async () => {
  mocks.call.mockRejectedValue(new Error("provider unavailable"));
  const ctx = context();
  await createGmailObserver({ env: {} as any, owner }).observe(ctx);
  const saved = vi.mocked(ctx.writeCursor).mock.calls[0][1];
  mocks.call.mockResolvedValue({ result: { messages: [] } });
  mocks.call.mockClear();
  const later = context(saved);
  later.nowMs += 3600_000 * 3;
  await createGmailObserver({ env: {} as any, owner }).observe(later);
  expect(mocks.call.mock.calls[0][3].body.arguments.after).toBe(
    now / 1000 - 3600,
  );
});
it("rejects mismatched owner authority before listing or reading anything", async () => {
  const ctx = context();
  ctx.user.id = "another-user";
  await expect(
    createGmailObserver({ env: {} as any, owner }).observe(ctx),
  ).rejects.toThrow("permission");
  expect(mocks.list).not.toHaveBeenCalled();
  expect(ctx.readCursor).not.toHaveBeenCalled();
});
it("does not consume malformed or mismatched message metadata", async () => {
  const prior = { version: 1, accounts: { [id]: { after: now / 1000 - 600 } } };
  const ctx = context(JSON.stringify(prior));
  mocks.call.mockImplementation(async (_env, _owner, _path, options) => ({
    result:
      options.body.operation === "gmail_list_events"
        ? { messages: [{ id: "abc" }] }
        : event("def"),
  }));
  expect(
    await createGmailObserver({ env: {} as any, owner }).observe(ctx),
  ).toEqual([]);
  expect(
    JSON.parse(vi.mocked(ctx.writeCursor).mock.calls[0][1]).accounts[id],
  ).toEqual(prior.accounts[id]);
});
it("reports only a generic source when a failed account or expired token makes the scan incomplete", async () => {
  mocks.list.mockResolvedValue([account(), account(otherId)]);
  const ctx = Object.assign(
    context(
      JSON.stringify({
        version: 1,
        accounts: {
          [id]: {
            after: now / 1000 - 600,
            before: now / 1000,
            pageToken: "expired",
          },
        },
      }),
    ),
    { reportError: vi.fn() },
  );
  mocks.call.mockImplementation(async (_env, _owner, _path, options) => {
    if (options.body.connection_id === id)
      throw new Error("OAuth credential private-token at owner@example.com");
    return {
      result:
        options.body.operation === "gmail_list_events"
          ? { messages: [{ id: "abc" }] }
          : event("abc"),
    };
  });
  const signals = await createGmailObserver({ env: {} as any, owner }).observe(
    ctx,
  );
  expect(signals).toHaveLength(1);
  expect(ctx.reportError.mock.calls).toEqual([["Gmail"]]);
  expect(
    JSON.parse(vi.mocked(ctx.writeCursor).mock.calls[0][1]).accounts[id],
  ).toEqual({ after: now / 1000 - 600, before: now / 1000 });
});
it("eventually observes every arrival while newer mail arrives during fixed-window pagination", async () => {
  let saved: string | null = null;
  let sequence = 0;
  const mailbox: Array<{ id: string; arrived: number }> = [];
  const add = (count: number, arrived: number) => {
    for (let i = 0; i < count; i++)
      mailbox.push({ id: (++sequence).toString(16), arrived });
  };
  add(55, now / 1000 - 120);
  const observed = new Set<string>();
  const listWindows: Array<{ after: number; before: number; page?: string }> =
    [];
  mocks.call.mockImplementation(async (_env, _owner, _path, options) => {
    const args = options.body.arguments;
    if (options.body.operation === "gmail_get_event") {
      const item = mailbox.find((m) => m.id === args.message_id)!;
      return {
        result: {
          ...event(item.id),
          internalDate: String(item.arrived * 1000),
        },
      };
    }
    listWindows.push({
      after: args.after,
      before: args.before,
      page: args.page_token,
    });
    const window = mailbox
      .filter((m) => m.arrived >= args.after && m.arrived < args.before)
      .reverse();
    const offset = Number(args.page_token || 0);
    const messages = window
      .slice(offset, offset + args.max)
      .map(({ id }) => ({ id }));
    return {
      result: {
        messages,
        ...(offset + args.max < window.length
          ? { nextPageToken: String(offset + args.max) }
          : {}),
      },
    };
  });
  for (let i = 0; i < 12; i++) {
    const ctx = context(saved);
    ctx.nowMs += i * 3600_000;
    if (i > 0 && i < 8) add(8, ctx.nowMs / 1000 - 1);
    for (const item of await createGmailObserver({
      env: {} as any,
      owner,
    }).observe(ctx))
      observed.add(item.entity_id);
    saved = vi.mocked(ctx.writeCursor).mock.calls[0][1];
  }
  expect(listWindows.slice(0, 3).map((window) => window.before)).toEqual([
    now / 1000,
    now / 1000,
    now / 1000,
  ]);
  expect(listWindows.slice(0, 3).map((window) => window.page)).toEqual([
    undefined,
    "20",
    "40",
  ]);
  expect(observed).toEqual(new Set(mailbox.map((m) => m.id)));
});
it.each(["provider", "triage"])(
  "preserves the first lookback after %s failure discards the staged cursor",
  async (failure) => {
    const baselines = new Map<string, number>();
    const withBaseline = (at: number) =>
      Object.assign(context(), {
        nowMs: at,
        initialObservationTime: vi.fn((source: string) => {
          if (!baselines.has(source)) baselines.set(source, at);
          return baselines.get(source)!;
        }),
      });
    if (failure === "provider")
      mocks.call.mockRejectedValue(new Error("unavailable"));
    else mocks.call.mockResolvedValue({ result: { messages: [] } });
    await createGmailObserver({ env: {} as any, owner }).observe(
      withBaseline(now),
    );
    // Wake recovery discards staged cursor changes after provider/triage failure.
    mocks.call.mockResolvedValue({ result: { messages: [] } });
    mocks.call.mockClear();
    const later = withBaseline(now + 3600_000);
    await createGmailObserver({ env: {} as any, owner }).observe(later);
    expect(later.initialObservationTime).toHaveBeenCalledWith(`gmail:${id}`);
    expect(mocks.call.mock.calls[0][3].body.arguments.after).toBe(
      now / 1000 - 3600,
    );
    expect(mocks.call.mock.calls[0][3].body.arguments.before).toBe(
      now / 1000 + 3600,
    );
  },
);

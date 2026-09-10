// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi, createChatEndpoints } from "../../src/hooks/api";
afterEach(() => vi.unstubAllGlobals());
describe("authenticated browser transport", () => {
  it("marks bodyless Access mutations as JSON without adding a bearer credential", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await createApi("")("/api/devices/device-id", { method: "DELETE" });
    const headers = new Headers(
      (fetch.mock.calls[0][1] as RequestInit).headers,
    );
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
  });
  it("keeps the access token in request headers and uses fresh one-time tickets on reconnect", async () => {
    let count = 0;
    const fetch = vi.fn(async (path: string, init: RequestInit) => {
      expect(path).not.toContain("access-credential");
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer access-credential",
      );
      if (path === "/api/socket-ticket")
        return Response.json({ ticket: `ticket-${++count}` });
      return Response.json({ success: true });
    });
    vi.stubGlobal("fetch", fetch);
    const endpoints = createChatEndpoints("access-credential");
    const created = await endpoints.createConversation();
    const reconnected = await endpoints.mintWsPath(
      created.conversationId,
      created.wsPath,
    );
    expect(created.wsPath).toContain("ticket=ticket-1");
    expect(reconnected).toContain("ticket=ticket-2");
    const tickets = fetch.mock.calls.filter(
      (call) => call[0] === "/api/socket-ticket",
    );
    for (const [, init] of tickets)
      expect(JSON.parse(init.body as string)).toEqual({
        conversation_id: created.conversationId,
      });
  });
  it("does not display raw upstream error bodies", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("sensitive-provider-response", { status: 500 }),
    );
    await expect(createApi("credential")("/api/agent/persona")).rejects.toThrow(
      "Request failed (500)",
    );
  });
  it("does not mint a socket when conversation admission fails", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      createChatEndpoints("credential").createConversation(),
    ).rejects.toThrow("Access expired");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("creates listings with stable conversation IDs and epoch timestamps", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        conversations: [
          {
            conversation_id: "conversation",
            title: "Research",
            created_at: 0,
            last_active_at: 1000,
          },
        ],
      }),
    );
    expect(
      await createChatEndpoints("credential").listConversations!(),
    ).toEqual([
      {
        id: "conversation",
        title: "Research",
        createdAt: "1970-01-01T00:00:00.000Z",
        lastActiveAt: "1970-01-01T00:00:01.000Z",
        wsPath: "/api/agent/connect?conversation_id=conversation",
      },
    ]);
  });
  it("passes opaque conversation page cursors without truncating them", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ conversations: [], next_cursor: "next+/=" }),
    );
    vi.stubGlobal("fetch", fetch);
    const data =
      await createChatEndpoints("credential").listConversationsPage!("last+/=");
    expect(fetch.mock.calls[0][0]).toBe(
      "/api/agent/conversations?cursor=last%2B%2F%3D",
    );
    expect(data).toEqual({ conversations: [], nextCursor: "next+/=" });
  });
});

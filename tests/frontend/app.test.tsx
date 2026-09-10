// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
const chat = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => {}),
  cancel: vi.fn(),
  cancelResearch: vi.fn(),
  reset: vi.fn(),
  newConversation: vi.fn(),
  conversations: [],
  messages: [
    { role: "assistant", content: "Ready to write the reviewed file." },
  ],
  toolResults: [
    {
      turn: 0,
      toolName: "write_file",
      rawJson: JSON.stringify({
        needs_confirmation: true,
        preview: "Write notes.txt?",
        confirmation_id: "review-id",
      }),
    },
  ],
  activeToolCalls: [],
  isConnected: true,
  isLoading: false,
  isStreaming: false,
  isResearching: true,
  conversationId: "conversation",
  error: null,
  staleConversation: null,
}));
vi.mock("../../src/hooks/useAgentChat", () => ({ useAgentChat: () => chat }));
import { App } from "../../src/app";
beforeEach(() => {
  vi.clearAllMocks();
  chat.conversationId = "conversation";
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function login() {
  render(<App />);
  fireEvent.change(await screen.findByLabelText("Access token"), {
    target: { value: "access-credential" },
  });
  fireEvent.click(screen.getByText("Open workspace"));
  await screen.findByText("Conversation", { selector: "h2" });
}
describe("workspace interface", () => {
  it("exchanges Access for a native cookie before opening an agent in a native installation", async () => {
    const assign = vi.fn();
    vi.stubGlobal(
      "window",
      new Proxy(window, {
        get(target, property) {
          return property === "location"
            ? { assign }
            : Reflect.get(target, property, target);
        },
      }),
    );
    const requests = vi.fn(async (path: string) =>
      Response.json(
        path === "/api/auth/options"
          ? { enabled: true, accessRecovery: true }
          : { authenticated: true, auth_mode: "access" },
      ),
    );
    vi.stubGlobal("fetch", requests);
    render(<App />);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("/api/auth/access"),
    );
    expect(
      requests.mock.calls.some(([path]) => path === "/api/agent/init"),
    ).toBe(false);
    expect(chat.connect).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalledWith("/cdn-cgi/access/logout");
  });
  it("opens a native cookie session without a token and signs out through the native endpoint", async () => {
    const requests = vi.fn(async (path: string) =>
      Response.json(
        path === "/api/auth/options"
          ? { enabled: true, accessRecovery: true }
          : path === "/api/session"
            ? { authenticated: true, auth_mode: "native" }
            : { success: true },
      ),
    );
    vi.stubGlobal("fetch", requests);
    const storage = vi.spyOn(Storage.prototype, "setItem");
    render(<App />);
    await screen.findByText("Conversation", { selector: "h2" });
    expect(screen.queryByLabelText("Access token")).toBeNull();
    expect(storage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Sign out"));
    await screen.findByRole("button", { name: "Sign in with a passkey" });
    const signOut = requests.mock.calls.find(
      (call) => call[0] === "/api/auth/sign-out",
    )!;
    expect((signOut[1] as RequestInit).method).toBe("POST");
    expect(
      requests.mock.calls.some((call) =>
        String(call[0]).includes("/cdn-cgi/access/logout"),
      ),
    ).toBe(false);
    for (const call of requests.mock.calls)
      expect(
        new Headers((call[1] as RequestInit | undefined)?.headers).has(
          "authorization",
        ),
      ).toBe(false);
    expect(chat.reset).toHaveBeenCalledOnce();
  });
  it("retains the native workspace when cookie logout fails, with a retryable error", async () => {
    vi.stubGlobal("fetch", async (path: string) =>
      path === "/api/auth/sign-out"
        ? new Response(null, { status: 503 })
        : Response.json(
            path === "/api/auth/options"
              ? { enabled: true, accessRecovery: false }
              : path === "/api/session"
                ? { authenticated: true, auth_mode: "native" }
                : { success: true },
          ),
    );
    render(<App />);
    await screen.findByText("Conversation", { selector: "h2" });
    fireEvent.click(screen.getByText("Sign out"));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Sign-out could not be completed",
    );
    expect(screen.getByText("Conversation", { selector: "h2" })).toBeTruthy();
    expect(chat.reset).not.toHaveBeenCalled();
  });
  it("shows native sign-in with an actionable error when a cookie session cannot initialize its agent", async () => {
    vi.stubGlobal("fetch", async (path: string) =>
      path === "/api/agent/init"
        ? new Response(null, { status: 503 })
        : Response.json(
            path === "/api/auth/options"
              ? { enabled: true, accessRecovery: false }
              : { authenticated: true, auth_mode: "native" },
          ),
    );
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "workspace could not be opened",
    );
    expect(
      screen.getByRole("button", { name: "Sign in with a passkey" }),
    ).toBeTruthy();
    expect(chat.connect).not.toHaveBeenCalled();
  });
  it("keeps AUTH-service sessions on the existing explicit sign-in flow", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ authenticated: true, auth_mode: "service" }),
    );
    render(<App />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByText("Conversation", { selector: "h2" })).toBeNull();
    expect(screen.getByLabelText("Access token")).toBeTruthy();
  });
  it("opens an authenticated Access session without requesting a bearer token", async () => {
    const requests = vi.fn(async (path: string) =>
      Response.json(
        path === "/api/session"
          ? { authenticated: true, auth_mode: "access" }
          : { success: true },
      ),
    );
    vi.stubGlobal("fetch", requests);
    render(<App />);
    await screen.findByText("Conversation", { selector: "h2" });
    expect(screen.queryByLabelText("Access token")).toBeNull();
    for (const call of requests.mock.calls) {
      expect(
        new Headers((call[1] as RequestInit | undefined)?.headers).has(
          "authorization",
        ),
      ).toBe(false);
    }
  });
  it("signs in without writing credentials to browser storage and clears the workspace at sign out", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ success: true }));
    const storage = vi.spyOn(Storage.prototype, "setItem");
    await login();
    expect(storage).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("access-credential")).toBeNull();
    fireEvent.click(screen.getByText("Sign out"));
    await waitFor(() => expect(chat.reset).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("Access token")).toHaveProperty("value", "");
  });
  it("persists explicit approval before asking the agent to execute the matching action", async () => {
    const fetch = vi.fn(async () => Response.json({ success: true }));
    vi.stubGlobal("fetch", fetch);
    await login();
    expect(chat.sendMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(chat.sendMessage).toHaveBeenCalledOnce());
    const decision = fetch.mock.calls.find((call) =>
      String(call[0]).includes("/confirmations/"),
    );
    expect(decision?.[0]).toBe(
      "/api/agent/conversations/conversation/confirmations/review-id",
    );
    expect(JSON.parse((decision?.[1] as RequestInit).body as string)).toEqual({
      decision: "confirmed",
    });
    expect(chat.sendMessage.mock.calls[0][0]).toContain("review-id");
  });
  it("does not execute when the server rejects an approval", async () => {
    vi.stubGlobal("fetch", async (path: string) =>
      path.includes("/confirmations/")
        ? new Response(null, { status: 409 })
        : Response.json({ success: true }),
    );
    await login();
    fireEvent.click(screen.getByText("Approve"));
    await screen.findByRole("alert");
    expect(chat.sendMessage).not.toHaveBeenCalled();
  });
  it("keeps research cancellation distinct from the foreground Stop action", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ success: true }));
    await login();
    fireEvent.click(screen.getByText("Stop research"));
    expect(chat.cancelResearch).toHaveBeenCalledOnce();
    expect(chat.cancel).not.toHaveBeenCalled();
  });
  it("binds approval continuation to the reviewed conversation", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", (path: string) =>
      path.includes("/confirmations/")
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(Response.json({ success: true })),
    );
    await login();
    fireEvent.click(screen.getByText("Approve"));
    chat.conversationId = "different-conversation";
    await act(async () => {
      finish(Response.json({ success: true }));
    });
    expect(chat.sendMessage).toHaveBeenCalledWith(
      expect.stringContaining("review-id"),
      { expectedConversationId: "conversation" },
    );
  });

  it("does not reuse an approval decision in a different conversation", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ success: true }));
    await login();
    fireEvent.click(screen.getByText("Decline"));
    await screen.findByText("Declined");
    chat.conversationId = "different-conversation";
    fireEvent.click(screen.getByText("New conversation"));
    // Force a normal workspace render, as the real hook does when switching.
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "New draft" },
    });
    expect(screen.queryByText("Declined")).toBeNull();
    expect(screen.getByText("Approve")).toBeTruthy();
  });

  it("discards a stale memory page after a successful deletion", async () => {
    const memory = {
      vector_id: "memory-1",
      type: "raw",
      tier: "warm",
      content_preview: "Private remembered content",
    };
    let finish!: (response: Response) => void;
    let reads = 0;
    vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
      if (path === "/api/agent/memories" && !init.method) {
        if (++reads === 1)
          return Response.json({ memories: [memory], next_cursor: null });
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return Response.json({ success: true });
    });
    await login();
    fireEvent.click(screen.getByText("Memory"));
    await screen.findByText(memory.content_preview);
    fireEvent.click(screen.getByText("Refresh"));
    fireEvent.click(screen.getByText("Forget", { exact: true }));
    await waitFor(() =>
      expect(screen.queryByText(memory.content_preview)).toBeNull(),
    );
    await act(async () => {
      finish(Response.json({ memories: [memory], next_cursor: null }));
    });
    expect(screen.queryByText(memory.content_preview)).toBeNull();
  });
  it("retains the composer draft when a send fails", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ success: true }));
    chat.sendMessage.mockRejectedValueOnce(new Error("Connection unavailable"));
    await login();
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Keep this message" },
    });
    fireEvent.click(screen.getByText("Send", { exact: true }));
    await screen.findByText("Connection unavailable");
    expect(screen.getByLabelText("Message")).toHaveProperty(
      "value",
      "Keep this message",
    );
  });
});

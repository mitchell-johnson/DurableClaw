// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
const chat = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => {}),
  cancel: vi.fn(),
  cancelResearch: vi.fn(),
  reset: vi.fn(),
  newConversation: vi.fn(),
  switchConversation: vi.fn(async () => {}),
  conversations: [{ id: "conversation", title: "A recent conversation" }],
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
let compact = false;
let touch = false;
const mediaListeners = new Set<() => void>();
beforeEach(() => {
  vi.clearAllMocks();
  compact = false;
  touch = false;
  mediaListeners.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query === "(pointer: coarse)" ? touch : compact;
    },
    addEventListener: (_: string, listener: () => void) =>
      mediaListeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      mediaListeners.delete(listener),
  }));
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function () {
      this.setAttribute("open", "");
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function () {
      this.removeAttribute("open");
    },
  });
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
  fireEvent.change(screen.getByLabelText("Access token"), {
    target: { value: "access-credential" },
  });
  fireEvent.click(screen.getByText("Open workspace"));
  await screen.findByText("Conversation", { selector: "h2" });
}
describe("workspace interface", () => {
  it("opens mobile navigation on demand and closes it after selecting a conversation", async () => {
    compact = true;
    vi.stubGlobal("fetch", async () => Response.json({ success: true }));
    await login();
    expect(screen.queryByRole("navigation")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const drawer = screen.getByRole("dialog");
    fireEvent.click(within(drawer).getByText("A recent conversation"));
    expect(chat.switchConversation).toHaveBeenCalledWith(chat.conversations[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("Message")).toBeTruthy();
  });

  it("preserves the draft while navigating and supports dismissing the drawer", async () => {
    compact = true;
    vi.stubGlobal("fetch", async () => Response.json({ persona: {} }));
    await login();
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Unsent draft" },
    });
    const openMenu = () =>
      fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    openMenu();
    fireEvent.click(screen.getByText("Settings", { exact: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await screen.findByLabelText("Agent instructions");
    openMenu();
    fireEvent.click(screen.getByText("Conversations", { exact: true }));
    expect(screen.getByLabelText("Message")).toHaveProperty(
      "value",
      "Unsent draft",
    );
    openMenu();
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { cancelable: true }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    openMenu();
    fireEvent.click(screen.getByLabelText("Close navigation"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("restores desktop navigation on resize without leaving an open mobile dialog", async () => {
    compact = true;
    vi.stubGlobal("fetch", async () => Response.json({ success: true }));
    await login();
    fireEvent.click(screen.getByLabelText("Open navigation"));
    act(() => {
      compact = false;
      mediaListeners.forEach((listener) => listener());
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("navigation")).toBeTruthy();
    act(() => {
      compact = true;
      mediaListeners.forEach((listener) => listener());
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("leaves touch Enter for newlines while keeping desktop Enter to send", async () => {
    touch = true;
    vi.stubGlobal("fetch", async () => Response.json({ success: true }));
    await login();
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "A message" } });
    expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(true);
    expect(chat.sendMessage).not.toHaveBeenCalled();
    touch = false;
    expect(fireEvent.keyDown(input, { key: "Enter", shiftKey: true })).toBe(
      true,
    );
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(
      true,
    );
    expect(chat.sendMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(chat.sendMessage).toHaveBeenCalledWith("A message"),
    );
  });

  it("tracks keyboard viewport changes, ignores pinch zoom and cleans up on sign out", async () => {
    compact = true;
    const viewport = Object.assign(new EventTarget(), {
      height: 800,
      offsetTop: 0,
      scale: 1,
    });
    vi.stubGlobal("visualViewport", viewport);
    const remove = vi.spyOn(viewport, "removeEventListener");
    vi.stubGlobal("fetch", async () => Response.json({ success: true }));
    await login();
    const workspace = document.querySelector<HTMLElement>(".workspace")!;
    viewport.height = 400;
    viewport.offsetTop = 50;
    viewport.dispatchEvent(new Event("resize"));
    expect(workspace.style.getPropertyValue("--workspace-height")).toBe(
      "400px",
    );
    expect(workspace.style.getPropertyValue("--workspace-top")).toBe("50px");
    viewport.scale = 2;
    viewport.height = 200;
    viewport.dispatchEvent(new Event("resize"));
    expect(workspace.style.getPropertyValue("--workspace-height")).toBe(
      "400px",
    );
    fireEvent.click(screen.getByLabelText("Open navigation"));
    fireEvent.click(screen.getByText("Sign out"));
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  });

  it("signs in without writing credentials to browser storage and clears the workspace at sign out", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ success: true }));
    const storage = vi.spyOn(Storage.prototype, "setItem");
    await login();
    expect(storage).not.toHaveBeenCalled();
    expect(screen.queryByDisplayValue("access-credential")).toBeNull();
    fireEvent.click(screen.getByText("Sign out"));
    expect(chat.reset).toHaveBeenCalledOnce();
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

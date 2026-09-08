// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
});

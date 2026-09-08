// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  useAgentChat,
  type AgentChatEndpoints,
} from "../../src/hooks/useAgentChat";

// --- Minimal WebSocket mock ----------------------------------------------
//
// Mirrors the transport contract: the hook resolves its connect promise on
// the server's `ready` frame (sent after history replay), not on `onopen`.

interface MockWebSocketInstance {
  url: string;
  readyState: number;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  emit: (frame: Record<string, unknown>) => void;
}

let wsConstructions: MockWebSocketInstance[] = [];

class MockWebSocket implements MockWebSocketInstance {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  /** When false, the test drives the post-open frames itself. */
  static autoReady = true;

  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  send = vi.fn();
  close = vi.fn((_code?: number, _reason?: string) => {
    this.readyState = MockWebSocket.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    wsConstructions.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
      if (MockWebSocket.autoReady) {
        queueMicrotask(() => this.emit({ type: "ready", initialized: true }));
      }
    });
  }

  emit(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

async function flushMicrotasks() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("useAgentChat", () => {
  beforeEach(() => {
    wsConstructions = [];
    MockWebSocket.autoReady = true;
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("fetch", vi.fn());
    // The hook logs at info level on the happy path — silence the spies the
    // shared setup installs so it doesn't trip the strict-console guards.
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function endpoints(
    overrides: Partial<AgentChatEndpoints> = {},
  ): AgentChatEndpoints {
    return {
      createConversation: vi.fn(async () => ({
        conversationId: "c-new",
        wsPath: "/ws/new?token=n",
      })),
      mintWsPath: vi.fn(async (id: string) => `/ws/${id}?token=minted`),
      ...overrides,
    };
  }

  it("appends consecutive assistant turns and keeps tool widgets on the new turn", async () => {
    const { result } = renderHook(() =>
      useAgentChat({ endpoints: endpoints() }),
    );
    await act(async () => {
      await result.current.connect();
    });
    const socket = wsConstructions[0];
    act(() => {
      socket.emit({
        type: "assistant_message",
        content: "I will investigate.",
      });
      socket.emit({ type: "assistant_start" });
      socket.emit({
        type: "tool_result",
        toolName: "search_records",
        rawJson: "{}",
      });
      socket.emit({ type: "assistant_delta", content: "The findings" });
      socket.emit({ type: "assistant_end" });
      socket.emit({ type: "assistant_start" });
      socket.emit({ type: "assistant_delta", content: "One more result" });
      socket.emit({ type: "assistant_end" });
    });
    expect(result.current.messages).toEqual([
      { role: "assistant", content: "I will investigate." },
      { role: "assistant", content: "The findings" },
      { role: "assistant", content: "One more result" },
    ]);
    expect(result.current.toolResults).toEqual([
      { turn: 1, toolName: "search_records", rawJson: "{}" },
    ]);
  });

  it("deduplicates complete research messages without overwriting the live reply", async () => {
    const { result } = renderHook(() =>
      useAgentChat({ endpoints: endpoints() }),
    );
    await act(async () => {
      await result.current.connect();
    });
    const socket = wsConstructions[0];
    act(() => {
      socket.emit({
        type: "assistant_start",
        request_id: "live",
        message_id: "live-message",
      });
      socket.emit({
        type: "assistant_delta",
        request_id: "live",
        content: "Live ",
      });
      socket.emit({
        type: "assistant_message",
        request_id: "research",
        message_id: "findings",
        content: "Research findings",
      });
      socket.emit({
        type: "assistant_message",
        request_id: "research",
        message_id: "findings",
        content: "Research findings",
      });
      socket.emit({
        type: "assistant_delta",
        request_id: "live",
        content: "answer",
      });
    });
    expect(result.current.isStreaming).toBe(true);
    act(() => {
      socket.emit({ type: "assistant_end", request_id: "live" });
    });
    expect(result.current.messages).toEqual([
      { role: "assistant", content: "Live answer" },
      { role: "assistant", content: "Research findings" },
    ]);
  });

  it("ignores frames for a finished request while a different request is streaming", async () => {
    const { result } = renderHook(() =>
      useAgentChat({ endpoints: endpoints() }),
    );
    await act(async () => {
      await result.current.connect();
    });
    const socket = wsConstructions[0];
    act(() => {
      socket.emit({ type: "assistant_start", request_id: "old" });
      socket.emit({
        type: "assistant_delta",
        request_id: "old",
        content: "Old answer",
      });
      socket.emit({ type: "assistant_end", request_id: "old" });
      socket.emit({ type: "assistant_start", request_id: "new" });
      socket.emit({
        type: "assistant_delta",
        request_id: "new",
        content: "New answer",
      });
      socket.emit({ type: "assistant_start", request_id: "old" });
      socket.emit({
        type: "assistant_delta",
        request_id: "old",
        content: " stale",
      });
      socket.emit({
        type: "tool_call",
        request_id: "old",
        toolName: "search_records",
      });
      socket.emit({
        type: "tool_result",
        request_id: "old",
        toolName: "search_records",
        rawJson: "{}",
      });
      socket.emit({ type: "assistant_end", request_id: "old" });
      socket.emit({ type: "error", request_id: "old", error: "Old failure" });
    });
    expect(result.current.isStreaming).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.activeToolCalls).toEqual([]);
    expect(result.current.toolResults).toEqual([]);
    expect(result.current.messages.map((message) => message.content)).toEqual([
      "Old answer",
      "New answer",
    ]);
  });

  it.each([false, true])(
    "stops immediately with a partial reply=%s, ignores late frames, and permits a new request",
    async (partial) => {
      const { result } = renderHook(() =>
        useAgentChat({ endpoints: endpoints(), identifiedRequests: true }),
      );
      await act(async () => {
        await result.current.connect();
      });
      await act(async () => {
        await result.current.sendMessage("first");
      });
      const socket = wsConstructions[0];
      const first = JSON.parse(vi.mocked(socket.send).mock.calls[0][0]);
      expect(first.request_id).toEqual(expect.any(String));
      if (partial)
        act(() => {
          socket.emit({
            type: "assistant_start",
            request_id: first.request_id,
          });
          socket.emit({
            type: "assistant_delta",
            request_id: first.request_id,
            content: "Partial answer",
          });
        });
      act(() => {
        result.current.cancel();
      });
      expect(socket.send).toHaveBeenLastCalledWith(
        JSON.stringify({ type: "cancel", request_id: first.request_id }),
      );
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.messages.at(-1)).toEqual({
        role: "assistant",
        content: partial ? "Partial answer" : "",
        stopped: true,
      });
      await act(async () => {
        await result.current.sendMessage("second");
      });
      const second = JSON.parse(vi.mocked(socket.send).mock.calls.at(-1)![0]);
      expect(second.request_id).not.toBe(first.request_id);
      act(() => {
        socket.emit({ type: "assistant_start", request_id: second.request_id });
        socket.emit({
          type: "assistant_delta",
          request_id: second.request_id,
          content: "Second answer",
        });
        socket.emit({
          type: "assistant_delta",
          request_id: first.request_id,
          content: "Late text",
        });
        socket.emit({
          type: "assistant_end",
          request_id: first.request_id,
          stopped: true,
        });
        socket.emit({
          type: "assistant_message",
          request_id: "other-research",
          message_id: "findings",
          content: "Other research",
        });
      });
      expect(result.current.isStreaming).toBe(true);
      expect(result.current.messages.map((message) => message.content)).toEqual(
        [
          "first",
          partial ? "Partial answer" : "",
          "second",
          "Second answer",
          "Other research",
        ],
      );
    },
  );

  it("can stop research after its acknowledgement and restore pending research on reconnect", async () => {
    const { result } = renderHook(() =>
      useAgentChat({
        endpoints: endpoints(),
        identifiedRequests: true,
        conversationId: "c-1",
      }),
    );
    await act(async () => {
      await result.current.connect();
    });
    const socket = wsConstructions[0];
    act(() => {
      socket.emit({
        type: "subagent_batch",
        request_id: "research",
        batch_id: "batch-1",
        status: "running",
      });
      socket.emit({
        type: "subagent_batch",
        request_id: "research",
        batch_id: "batch-2",
        status: "running",
      });
      socket.emit({
        type: "assistant_message",
        message_id: "ack",
        content: "I will investigate.",
      });
    });
    expect(result.current.isResearching).toBe(true);
    act(() => {
      result.current.cancelResearch();
    });
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "cancel", request_id: "research" }),
    );
    expect(result.current.isResearching).toBe(false);
    act(() => {
      socket.readyState = MockWebSocket.CLOSED;
      socket.onclose?.();
    });
    await act(async () => {
      await result.current.connect();
    });
    act(() => {
      wsConstructions[1].emit({
        type: "assistant_message",
        message_id: "stopped",
        content: "Partial",
        stopped: true,
      });
      wsConstructions[1].emit({
        type: "assistant_message",
        message_id: "stopped",
        content: "Partial",
        stopped: true,
      });
      wsConstructions[1].emit({
        type: "subagent_batch",
        request_id: "pending",
        batch_id: "batch-3",
        status: "running",
      });
    });
    expect(result.current.messages).toEqual([
      { role: "assistant", content: "Partial", stopped: true },
    ]);
    expect(result.current.isResearching).toBe(true);
    act(() => {
      wsConstructions[1].emit({
        type: "subagent_batch",
        request_id: "pending",
        batch_id: "batch-3",
        status: "completed",
      });
    });
    expect(result.current.isResearching).toBe(false);
  });

  it("stays stopped when the cancel send fails and a delayed research status arrives", async () => {
    const { result } = renderHook(() =>
      useAgentChat({ endpoints: endpoints(), identifiedRequests: true }),
    );
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await result.current.sendMessage("investigate");
    });
    const socket = wsConstructions[0];
    const requestId = JSON.parse(
      vi.mocked(socket.send).mock.calls[0][0],
    ).request_id;
    act(() => {
      socket.emit({ type: "assistant_start", request_id: requestId });
      socket.emit({
        type: "subagent_batch",
        request_id: requestId,
        batch_id: "batch",
        status: "running",
      });
    });
    vi.mocked(socket.send).mockImplementationOnce(() => {
      throw new Error("Socket closed");
    });
    act(() => {
      result.current.cancel();
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isStreaming).toBe(false);
    act(() => {
      socket.emit({
        type: "subagent_batch",
        request_id: requestId,
        batch_id: "batch",
        status: "running",
      });
    });
    expect(result.current.isResearching).toBe(false);
  });

  it("does not mark an earlier assistant message stopped when cancelled before the first delta", async () => {
    const { result } = renderHook(() =>
      useAgentChat({ endpoints: endpoints(), identifiedRequests: true }),
    );
    await act(async () => {
      await result.current.connect();
    });
    const socket = wsConstructions[0];
    act(() => {
      socket.emit({ type: "assistant_message", content: "Earlier answer" });
    });
    await act(async () => {
      await result.current.sendMessage("follow-up");
    });
    const requestId = JSON.parse(
      vi.mocked(socket.send).mock.calls[0][0],
    ).request_id;
    act(() => {
      result.current.cancel();
      result.current.cancel();
    });
    expect(
      vi
        .mocked(socket.send)
        .mock.calls.slice(1)
        .map(([frame]) => JSON.parse(frame)),
    ).toEqual([
      { type: "cancel", request_id: requestId },
      { type: "cancel", request_id: requestId },
    ]);
    expect(result.current.messages).toEqual([
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "follow-up" },
      { role: "assistant", content: "", stopped: true },
    ]);
  });

  it("releases stale turn state when a page-scoped assistant opens a new conversation", async () => {
    const { result } = renderHook(() =>
      useAgentChat({ endpoints: endpoints(), alwaysCreateNew: true }),
    );
    await act(async () => {
      await result.current.connect();
    });
    act(() => {
      wsConstructions[0].emit({ type: "assistant_start" });
    });
    await act(async () => {
      await result.current.connect();
    });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.messages).toEqual([]);
    act(() => {
      wsConstructions[1].emit({ type: "assistant_start" });
      wsConstructions[1].emit({
        type: "assistant_delta",
        content: "New page answer",
      });
    });
    expect(result.current.messages).toEqual([
      { role: "assistant", content: "New page answer" },
    ]);
  });

  /**
   * A known conversation with a token already in hand (the create page just
   * navigated here) must not pay for a mint round-trip before connecting.
   */
  it("connects with the supplied wsPath and does not mint a token", async () => {
    const eps = endpoints();
    const { result } = renderHook(() =>
      useAgentChat({
        endpoints: eps,
        conversationId: "c-1",
        initialWsPath: "/ws/c-1?token=initial",
      }),
    );

    await act(async () => {
      await result.current.connect();
    });

    expect(wsConstructions).toHaveLength(1);
    expect(wsConstructions[0].url).toContain("/ws/c-1?token=initial");
    expect(eps.mintWsPath).not.toHaveBeenCalled();
    expect(eps.createConversation).not.toHaveBeenCalled();
  });

  /** The initial wsPath is single-use: its token is spent once the socket
   *  opened, so a reconnect has to mint a fresh one. */
  it("mints a fresh wsPath when reconnecting the same conversation", async () => {
    const eps = endpoints();
    const { result } = renderHook(() =>
      useAgentChat({
        endpoints: eps,
        conversationId: "c-1",
        initialWsPath: "/ws/c-1?token=initial",
      }),
    );

    await act(async () => {
      await result.current.connect();
    });
    // The socket drops (idle timeout, tab sleep) and the page reconnects.
    act(() => {
      wsConstructions[0].readyState = MockWebSocket.CLOSED;
    });
    await act(async () => {
      await result.current.connect();
    });

    expect(eps.mintWsPath).toHaveBeenCalledWith("c-1");
    expect(wsConstructions).toHaveLength(2);
    expect(wsConstructions[1].url).toContain("token=minted");
  });

  it.each(["new", "switch"] as const)(
    "releases an active turn on %s conversation and ignores obsolete frames",
    async (action) => {
      const { result } = renderHook(() =>
        useAgentChat({ endpoints: endpoints() }),
      );
      await act(async () => {
        await result.current.connect();
      });
      await act(async () => {
        await result.current.sendMessage("first question");
      });
      const oldSocket = wsConstructions[0];
      act(() => {
        oldSocket.emit({ type: "assistant_start" });
        oldSocket.emit({ type: "assistant_delta", content: "Partial answer" });
        oldSocket.emit({
          type: "tool_call",
          toolName: "search",
          toolCallId: "old-call",
        });
      });
      expect(result.current.isLoading).toBe(true);
      expect(result.current.isStreaming).toBe(true);

      await act(async () => {
        if (action === "new") await result.current.newConversation();
        else
          await result.current.switchConversation({
            id: "c-other",
            title: "Other conversation",
            wsPath: "/ws/c-other",
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
          });
      });

      expect(result.current.isConnected).toBe(true);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.activeToolCalls).toEqual([]);
      expect(result.current.messages).toEqual([]);
      expect(result.current.toolResults).toEqual([]);

      const newSocket = wsConstructions[1];
      await act(async () => {
        await result.current.sendMessage("new question");
      });
      expect(newSocket.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "message", content: "new question" }),
      );
      act(() => {
        newSocket.emit({ type: "assistant_start" });
        newSocket.emit({ type: "assistant_delta", content: "New answer" });
        oldSocket.emit({ type: "assistant_delta", content: " obsolete text" });
        oldSocket.emit({ type: "assistant_end" });
        oldSocket.onclose?.();
      });
      expect(result.current.isConnected).toBe(true);
      expect(result.current.isStreaming).toBe(true);
      expect(result.current.messages).toEqual([
        { role: "user", content: "new question" },
        { role: "assistant", content: "New answer" },
      ]);
      act(() => {
        newSocket.emit({ type: "assistant_end" });
      });
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isStreaming).toBe(false);
    },
  );

  it.each(["close", "error"] as const)(
    "releases turn indicators on socket %s, retains the transcript, and can send again",
    async (event) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { result } = renderHook(() =>
        useAgentChat({
          endpoints: endpoints(),
          conversationId: "c-1",
          initialWsPath: "/ws/c-1?t=1",
        }),
      );
      await act(async () => {
        await result.current.connect();
      });
      await act(async () => {
        await result.current.sendMessage("question");
      });
      const oldSocket = wsConstructions[0];
      act(() => {
        oldSocket.emit({ type: "assistant_start" });
        oldSocket.emit({ type: "assistant_delta", content: "Partial answer" });
        oldSocket.emit({
          type: "tool_call",
          toolName: "search",
          toolCallId: "call-1",
        });
      });
      act(() => {
        oldSocket.emit({
          type: "tool_result",
          toolName: "search",
          toolCallId: "call-1",
          rawJson: '{"count":1}',
        });
        oldSocket.emit({
          type: "tool_call",
          toolName: "load",
          toolCallId: "call-2",
        });
      });
      const transcript = result.current.messages;
      const toolResults = result.current.toolResults;
      expect(toolResults).toHaveLength(1);

      act(() => {
        if (event === "close") {
          oldSocket.readyState = MockWebSocket.CLOSED;
          oldSocket.onclose?.();
        } else oldSocket.onerror?.(new Error("Socket failed"));
      });
      expect(result.current.isConnected).toBe(false);
      expect(result.current.isLoading).toBe(false);
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.isReconnecting).toBe(false);
      expect(result.current.activeToolCalls).toEqual([]);
      expect(result.current.messages).toEqual(transcript);
      expect(result.current.toolResults).toEqual(toolResults);

      await act(async () => {
        await result.current.sendMessage("try again");
      });
      expect(wsConstructions).toHaveLength(2);
      expect(wsConstructions[1].send).toHaveBeenCalledWith(
        JSON.stringify({ type: "message", content: "try again" }),
      );
      act(() => {
        wsConstructions[1].emit({ type: "assistant_start" });
        wsConstructions[1].emit({
          type: "assistant_delta",
          content: "Recovered answer",
        });
        wsConstructions[1].emit({ type: "assistant_end" });
      });
      expect(result.current.messages.at(-1)?.content).toBe("Recovered answer");
      expect(result.current.isStreaming).toBe(false);
    },
  );

  it("lets onFrame consume a domain frame while core frames still stream", async () => {
    const seen: string[] = [];
    const onFrame = vi.fn((data: Record<string, unknown>) => {
      seen.push(String(data.type));
      return data.type === "preview_update";
    });
    const logSpy = console.log as unknown as ReturnType<typeof vi.spyOn>;
    const { result } = renderHook(() =>
      useAgentChat({
        endpoints: endpoints(),
        conversationId: "c-1",
        initialWsPath: "/ws/c-1?token=initial",
        onFrame,
      }),
    );
    await act(async () => {
      await result.current.connect();
    });

    act(() => {
      wsConstructions[0].emit({
        type: "preview_update",
        config: { name: "Board" },
      });
      wsConstructions[0].emit({ type: "assistant_start" });
      wsConstructions[0].emit({ type: "assistant_delta", content: "Hello" });
    });

    expect(seen).toContain("preview_update");
    // Consumed: it never reached the switch's unknown-type branch.
    const unknownLogs = logSpy.mock.calls.filter((args) =>
      String(args[0]).includes("Unknown message type"),
    );
    expect(unknownLogs).toHaveLength(0);
    // Returning false for core frames leaves them to the kernel handling.
    expect(result.current.messages).toEqual([
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("replays history in order and resolves connect at ready", async () => {
    MockWebSocket.autoReady = false;
    const { result } = renderHook(() =>
      useAgentChat({
        endpoints: endpoints(),
        conversationId: "c-1",
        initialWsPath: "/ws/c-1?t=1",
      }),
    );

    let resolved = false;
    let connectPromise: Promise<void>;
    await act(async () => {
      connectPromise = result.current.connect().then(() => {
        resolved = true;
      });
      await flushMicrotasks();
    });
    expect(resolved).toBe(false);

    await act(async () => {
      wsConstructions[0].emit({
        type: "history_user_message",
        content: "show me jobs",
      });
      wsConstructions[0].emit({
        type: "assistant_message",
        content: "Here they are.",
      });
    });
    expect(resolved).toBe(false);

    await act(async () => {
      wsConstructions[0].emit({ type: "ready", initialized: true });
      await connectPromise!;
    });

    expect(resolved).toBe(true);
    expect(result.current.messages).toEqual([
      { role: "user", content: "show me jobs" },
      { role: "assistant", content: "Here they are." },
    ]);
  });

  it("sends a message as the canonical `message` frame", async () => {
    const { result } = renderHook(() =>
      useAgentChat({
        endpoints: endpoints(),
        conversationId: "c-1",
        initialWsPath: "/ws/c-1?t=1",
      }),
    );
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await result.current.sendMessage("add a column");
    });

    expect(wsConstructions[0].send).toHaveBeenCalledWith(
      JSON.stringify({ type: "message", content: "add a column" }),
    );
    await waitFor(() =>
      expect(result.current.messages).toContainEqual({
        role: "user",
        content: "add a column",
      }),
    );
  });

  it("rides getMessageContext on the frame as pageContext, and omits it when undefined", async () => {
    let context: Record<string, unknown> | undefined = {
      page: { path: "/records/c-9", title: "Record – Workspace" },
    };
    const { result } = renderHook(() =>
      useAgentChat({
        endpoints: endpoints(),
        conversationId: "c-1",
        initialWsPath: "/ws/c-1?t=1",
        getMessageContext: () => context,
      }),
    );
    await act(async () => {
      await result.current.connect();
    });
    await act(async () => {
      await result.current.sendMessage("who is this?");
    });
    expect(wsConstructions[0].send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "message",
        content: "who is this?",
        pageContext: {
          page: { path: "/records/c-9", title: "Record – Workspace" },
        },
      }),
    );

    // The getter is read per send — undefined means a bare frame, no key.
    context = undefined;
    await act(async () => {
      await result.current.sendMessage("and generally?");
    });
    expect(wsConstructions[0].send).toHaveBeenCalledWith(
      JSON.stringify({ type: "message", content: "and generally?" }),
    );
  });

  it("creates a conversation when no id is supplied and no listing exists", async () => {
    const eps = endpoints();
    const { result } = renderHook(() => useAgentChat({ endpoints: eps }));
    await act(async () => {
      await result.current.connect();
    });

    expect(eps.createConversation).toHaveBeenCalled();
    expect(wsConstructions[0].url).toContain("/ws/new?token=n");
  });
});

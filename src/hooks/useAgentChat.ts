/**
 * The conversational-agent chat hook: one WebSocket client for every flow that
 * speaks the agent-core frame protocol (assistant_start/delta/end, tool_call,
 * tool_result, history replay, ready).
 *
 * Connects DurableClaw's browser interface to the persistent coordinator. Everything a flow differs on is injected:
 *   - `endpoints` — how conversations are created, listed, deleted, and how a
 *     reconnect token is minted;
 *   - `conversationId` / `initialWsPath` — connect to a KNOWN conversation
 *     (the embedding application owns its id from the URL) instead of
 *     discovering one from a listing;
 *   - `onFrame` — a domain-frame hook. Return true to consume the frame.
 *
 * The epoch / connect-promise machinery is deliberately unchanged from the
 * DurableClaw implementation: it encodes race fixes (superseded sockets, sends issued
 * during the open→ready window) whose comments are the reason they survive.
 */
import { useState, useCallback, useRef, useEffect } from "react";

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
  stopped?: boolean;
}

export interface ToolCallInfo {
  toolName: string;
  /** Per-call id from the wire frame; lets concurrent calls of the same tool
   *  resolve independently. Absent on legacy frames (fall back to toolName). */
  toolCallId?: string;
  status: "calling" | "done";
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  createdAt: string;
  lastActiveAt: string;
  wsPath: string;
}

/**
 * A widget-renderable tool result captured from the WS stream.
 *
 * `turn` is the index of the assistant message in `messages` that this
 * tool was invoked during. The chat UI looks up `toolResults[].turn === messages.indexOf(m)`
 * to render widgets directly under the relevant assistant message.
 */
export interface ToolResultRecord {
  turn: number;
  toolName: string;
  rawJson: string;
}

export interface UseAssistantChatReturn {
  // Connection state
  isConnected: boolean;
  isLoading: boolean;
  isStreaming: boolean;
  isReconnecting: boolean;
  isResearching: boolean;

  // Conversation
  conversationId: string | null;
  conversations: ConversationSummary[];
  hasMoreConversations: boolean;
  isLoadingConversations: boolean;
  loadMoreConversations: () => Promise<void>;
  messages: AssistantMessage[];
  activeToolCalls: ToolCallInfo[];
  toolResults: ToolResultRecord[];
  error: string | null;
  staleConversation: ConversationSummary | null;

  // Actions
  connect: () => Promise<void>;
  sendMessage: (
    content: string,
    options?: { expectedConversationId: string },
  ) => Promise<void>;
  cancel: () => void;
  cancelResearch: () => void;
  newConversation: () => Promise<void>;
  switchConversation: (conversation: ConversationSummary) => Promise<void>;
  refreshConversations: () => Promise<void>;
  resumeStaleConversation: () => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  reset: () => void;
}

const STALE_CONVERSATION_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Pull the conversation_id query param off a wsPath, or null if absent.
 *
 * A fallback for listings from an older deploy whose rows carry the id only in
 * the wsPath — `conversation.id` is authoritative when present.
 */
function extractConversationId(wsPath: string): string | null {
  const qIdx = wsPath.indexOf("?");
  if (qIdx === -1) return null;
  const params = new URLSearchParams(wsPath.slice(qIdx + 1));
  return params.get("conversation_id");
}

export interface AgentChatEndpoints {
  /** Create a conversation; returns its id and a READY-TO-CONNECT wsPath. */
  createConversation: () => Promise<{ conversationId: string; wsPath: string }>;
  /**
   * Mint a fresh tokened wsPath for an existing conversation (reconnect).
   *
   * `wsPathHint` is the conversation's last known wsPath when the caller has
   * one (reconnecting to a listed conversation). Adapters that need a doName
   * should read it from the hint rather than from anything cached across
   * calls — a cache goes stale the moment two hooks share a page.
   */
  mintWsPath: (conversationId: string, wsPathHint?: string) => Promise<string>;
  /** Optional: list conversations (enables reconnect-to-recent + history UI). */
  listConversations?: () => Promise<ConversationSummary[]>;
  listConversationsPage?: (cursor?: string) => Promise<{
    conversations: ConversationSummary[];
    nextCursor: string | null;
  }>;
  /** Optional: delete a conversation. */
  deleteConversation?: (id: string) => Promise<Response>;
}

export interface UseAgentChatOptions {
  endpoints: AgentChatEndpoints;
  /** DurableClaw supports scoped cancellation; older conversational DOs may not. */
  identifiedRequests?: boolean;
  alwaysCreateNew?: boolean;
  /**
   * What this conversation is called in error copy shown to the user. The
   * connection-failure message reaches the visible banner verbatim, so a
   * application must not tell a user it "couldn't connect to DurableClaw".
   * Default: 'DurableClaw'.
   */
  agentLabel?: string;
  /** Connect to this known conversation instead of creating/listing one. */
  conversationId?: string;
  /** First-connect wsPath already in hand (skips one mint round-trip). */
  initialWsPath?: string;
  /** Domain frame hook. Return true when the frame was consumed. */
  onFrame?: (data: Record<string, unknown>) => boolean;
  /**
   * Called at each send; the returned object rides on the outgoing message
   * frame as `pageContext`. Advisory context (e.g. the page the user is on) —
   * the server treats it as a hint, never an instruction. Return undefined to
   * send nothing.
   */
  getMessageContext?: () => Record<string, unknown> | undefined;
}

export function useAgentChat(
  options: UseAgentChatOptions,
): UseAssistantChatReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [messages, setMessagesState] = useState<AssistantMessage[]>([]);
  const [isResearching, setIsResearching] = useState(false);
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallInfo[]>([]);
  const [toolResults, setToolResults] = useState<ToolResultRecord[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const listStateRef = useRef({
    generation: 0,
    cursor: null as string | null,
    loading: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [staleConversation, setStaleConversation] =
    useState<ConversationSummary | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesRef = useRef<AssistantMessage[]>([]);
  const messageIndexesRef = useRef(new Map<string, number>());
  const activeRequestIdRef = useRef<string | undefined>(undefined);
  const latestRequestIdRef = useRef<string | undefined>(undefined);
  const finishedRequestsRef = useRef(new Set<string>());
  const cancelledResearchRequestsRef = useRef(new Set<string>());
  const researchRef = useRef(new Map<string, string>());
  const sendEpochRef = useRef(0);
  const ignoreLegacyFramesRef = useRef(false);
  // Update the transcript synchronously at the transport boundary. React may
  // batch start/delta/end together, but the next frame must see the previous
  // frame's message positions (including complete research messages).
  const setMessages = useCallback(
    (
      update:
        | AssistantMessage[]
        | ((previous: AssistantMessage[]) => AssistantMessage[]),
    ) => {
      const next =
        typeof update === "function" ? update(messagesRef.current) : update;
      messagesRef.current = next;
      if (next.length === 0) messageIndexesRef.current.clear();
      setMessagesState(next);
    },
    [],
  );
  const streamingTextRef = useRef("");
  const conversationIdRef = useRef<string | null>(null);
  // Tracks the "TTL elapsed → default to fresh chat" intent. When true,
  // sendMessage MUST lazy-create a new conversation instead of reconnecting to
  // the most-recent one, otherwise the existing fallback at line ~349 would
  // resurrect the stale thread the moment the user hits Send.
  const forceNewConversationRef = useRef(false);
  /**
   * The index (in `messages`) of the current assistant turn being streamed.
   * Captured at `assistant_start` so subsequent `tool_result` events can attach
   * their rawJson payload to the correct turn for widget rendering.
   */
  const currentTurnRef = useRef<number>(-1);

  // A turn belongs to one connection. Retiring that connection must release
  // the composer even when its final frame will never arrive. Keep persisted
  // messages/tool results separate so a disconnect retains the transcript.
  const resetTurnState = useCallback(() => {
    setIsLoading(false);
    setIsStreaming(false);
    setActiveToolCalls([]);
    streamingTextRef.current = "";
    currentTurnRef.current = -1;
    activeRequestIdRef.current = undefined;
  }, []);

  const ensureTurnMessage = useCallback(
    (messageId?: string) => {
      if (currentTurnRef.current < 0) {
        currentTurnRef.current = messagesRef.current.length;
        setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
      }
      if (messageId)
        messageIndexesRef.current.set(messageId, currentTurnRef.current);
      return currentTurnRef.current;
    },
    [setMessages],
  );

  const markTurnStopped = useCallback(() => {
    const index = ensureTurnMessage();
    setMessages((prev) =>
      prev.map((message, i) =>
        i === index ? { ...message, stopped: true } : message,
      ),
    );
  }, [ensureTurnMessage, setMessages]);

  const sendCancel = useCallback((requestId?: string) => {
    try {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: "cancel",
            ...(requestId ? { request_id: requestId } : {}),
          }),
        );
      }
    } catch {
      // Stop remains an immediate escape hatch when the socket has died.
    }
  }, []);

  const cancel = useCallback(() => {
    // A second click must keep the original scope after local state cleared;
    // a payload-less retry could otherwise cancel unrelated research.
    const requestId = activeRequestIdRef.current ?? latestRequestIdRef.current;
    sendEpochRef.current++;
    if (requestId) {
      finishedRequestsRef.current.add(requestId);
      cancelledResearchRequestsRef.current.add(requestId);
    }
    ignoreLegacyFramesRef.current = true;
    if (
      currentTurnRef.current >= 0 ||
      messagesRef.current[messagesRef.current.length - 1]?.role === "user"
    )
      markTurnStopped();
    for (const [batchId, owner] of researchRef.current) {
      if (!requestId || owner === requestId)
        researchRef.current.delete(batchId);
    }
    setIsResearching(researchRef.current.size > 0);
    resetTurnState();
    sendCancel(requestId);
  }, [markTurnStopped, resetTurnState, sendCancel]);

  const cancelResearch = useCallback(() => {
    const requests = new Set(researchRef.current.values());
    researchRef.current.clear();
    setIsResearching(false);
    for (const requestId of requests) {
      cancelledResearchRequestsRef.current.add(requestId);
      if (requestId === activeRequestIdRef.current) cancel();
      else sendCancel(requestId);
    }
  }, [cancel, sendCancel]);

  /**
   * Monotonic connect generation. Every connect-like operation
   * (connect / newConversation / switchConversation) bumps this and captures
   * its own value. Because those operations `await` a fetch before the socket
   * is assigned, two rapid invocations can otherwise both reach
   * `connectWebSocket` and leave two live sockets — the loser overwritten in
   * `wsRef` but never closed, its `onmessage` still interleaving the previous
   * conversation's history/deltas into the visible chat. `connectWebSocket`
   * compares the captured generation against this ref and discards a socket
   * whose generation has been superseded.
   */
  const connectEpochRef = useRef(0);

  /**
   * The current in-flight connect promise, if any. `wsRef` is assigned at
   * `onopen`, so "readyState OPEN" does NOT imply the server's history replay
   * has finished — sendMessage awaits this before its readyState check so a
   * send issued during the open→ready window lands after the replayed thread
   * instead of in the middle of it. Cleared when the connect settles.
   */
  const connectPromiseRef = useRef<Promise<void> | null>(null);

  // Clean up WebSocket on unmount
  useEffect(() => {
    return () => {
      // Invalidate any in-flight connect so a socket that opens after unmount
      // tears itself down instead of being assigned to a dead component's ref.
      connectEpochRef.current++;
      listStateRef.current.generation++;
      if (wsRef.current) {
        wsRef.current.close(1000, "Component unmounted");
        wsRef.current = null;
      }
    };
  }, []);

  const { endpoints } = options;
  const agentLabel = options.agentLabel ?? "DurableClaw";

  /** Read at socket-close time, so a label change does not need a reconnect. */
  const agentLabelRef = useRef(agentLabel);
  agentLabelRef.current = agentLabel;
  // Ref so sendMessage's callback needn't re-create when the getter identity
  // changes (callers often define it inline).
  const getMessageContextRef = useRef(options.getMessageContext);
  getMessageContextRef.current = options.getMessageContext;

  /**
   * Latest `onFrame`, read at message time. `connectWebSocket` is built once
   * (its dependency array is empty by design — see the epoch comments), so
   * reaching for `options.onFrame` inside it would pin the first render's
   * closure.
   */
  const onFrameRef = useRef(options.onFrame);
  onFrameRef.current = options.onFrame;

  /**
   * A wsPath handed in by the caller is SINGLE USE: its token was minted for
   * one upgrade, so the second connect has to mint its own. The ref is how we
   * remember it has been spent.
   */
  const initialWsPathRef = useRef(options.initialWsPath);

  const connectWebSocket = useCallback(
    (
      wsPath: string,
      epoch?: number,
      opts?: { clearHistoryOnOpen?: boolean },
    ): Promise<void> => {
      // A connect chain that lost the race after its awaited fetches (e.g. a
      // reconnect superseded while its token fetch was in flight) must not
      // close the winning conversation's socket or construct a competing one —
      // settle immediately, before touching wsRef.
      if (epoch !== undefined && epoch !== connectEpochRef.current) {
        return Promise.resolve();
      }
      let readyTimer: ReturnType<typeof setTimeout> | undefined;
      const promise = new Promise<void>((resolve, reject) => {
        // The generation this socket belongs to. A later connect bumps
        // connectEpochRef, so an in-flight connect that opens after a newer one
        // can detect it lost the race and tear itself down instead of leaving a
        // second live socket whose onmessage interleaves a stale conversation.
        const myEpoch = epoch ?? connectEpochRef.current;

        // Always use current host for WebSocket so it goes through the Vite proxy in dev
        const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}${wsPath}`;

        // Close any socket the previous connect attempt left assigned before we
        // overwrite the ref — otherwise the old socket keeps streaming into the
        // chat even though nothing references it any more.
        if (wsRef.current) {
          wsRef.current.close(1000, "Superseded by new connection");
          wsRef.current = null;
        }

        const socket = new WebSocket(wsUrl);
        let retired = false;
        readyTimer = setTimeout(() => {
          retired = true;
          socket.close(1000, "Connection timed out");
          if (myEpoch !== connectEpochRef.current) {
            resolve();
            return;
          }
          if (wsRef.current === socket) wsRef.current = null;
          setIsConnected(false);
          setIsReconnecting(false);
          resetTurnState();
          reject(new Error("The connection timed out. Please try again."));
        }, 30_000);

        socket.onopen = () => {
          // A newer connect started while this socket was opening — abandon it so
          // its history/deltas don't bleed into the conversation that won.
          if (retired || myEpoch !== connectEpochRef.current) {
            socket.close(1000, "Superseded by new connection");
            resolve();
            return;
          }

          // The server is about to replay the conversation's full history into
          // this socket — drop the local copy only now that the winning socket
          // actually exists. Clearing any earlier (before a socket opens) wipes
          // the on-screen thread whenever the reconnect fails.
          resetTurnState();
          latestRequestIdRef.current = undefined;
          finishedRequestsRef.current.clear();
          cancelledResearchRequestsRef.current.clear();
          ignoreLegacyFramesRef.current = false;
          researchRef.current.clear();
          setIsResearching(false);
          if (opts?.clearHistoryOnOpen) {
            setMessages([]);
            setToolResults([]);
          }
          wsRef.current = socket;
          setIsConnected(true);
          setError(null);
          // Deliberately NOT resolved here. The server replays conversation
          // history (history_user_message / assistant_message /
          // history_tool_result) immediately after the upgrade and then sends
          // 'ready'. Resolving at 'ready' guarantees callers run after the
          // replay, so sendMessage can append its outgoing message without the
          // replayed history landing after (and out of order with) it.
        };

        socket.onmessage = (event) => {
          if (retired) return;
          // Drop frames from a socket that a newer connect has superseded so a
          // losing connection can't interleave its conversation's history/deltas
          // into the chat the user is actually looking at. Settle the connect
          // promise so a caller awaiting this socket isn't left hanging
          // (resolving twice is a no-op).
          if (myEpoch !== connectEpochRef.current) {
            resolve();
            return;
          }
          try {
            const data = JSON.parse(event.data);
            if (!data || typeof data !== "object" || Array.isArray(data))
              return;
            const turnFrame = [
              "assistant_start",
              "assistant_delta",
              "assistant_end",
              "tool_call",
              "tool_result",
              "error",
            ].includes(data.type);
            if (turnFrame) {
              const requestId =
                typeof data.request_id === "string"
                  ? data.request_id
                  : undefined;
              if (
                requestId &&
                (finishedRequestsRef.current.has(requestId) ||
                  (activeRequestIdRef.current &&
                    requestId !== activeRequestIdRef.current))
              )
                return;
              if (!requestId && ignoreLegacyFramesRef.current) return;
            }
            // Domain frames first: a flow that consumes one (preview_update,
            // status, …) stops it here rather than letting it fall through to
            // the unknown-type branch.
            const onFrame = onFrameRef.current;
            if (onFrame && onFrame(data)) {
              return;
            }
            switch (data.type) {
              case "ready":
                setIsReconnecting(false);
                // History replay is complete — the connection is usable.
                resolve();
                break;

              case "history_user_message":
                setMessages((prev) => [
                  ...prev,
                  { role: "user", content: data.content },
                ]);
                break;

              case "assistant_message": {
                if (typeof data.content !== "string") break;
                const messageId =
                  typeof data.message_id === "string"
                    ? data.message_id
                    : undefined;
                const existing = messageId
                  ? messageIndexesRef.current.get(messageId)
                  : undefined;
                const message: AssistantMessage = {
                  role: "assistant",
                  content: data.content,
                  ...(data.stopped === true ? { stopped: true } : {}),
                };
                if (existing !== undefined) {
                  setMessages((prev) =>
                    prev.map((item, i) => (i === existing ? message : item)),
                  );
                } else {
                  if (messageId)
                    messageIndexesRef.current.set(
                      messageId,
                      messagesRef.current.length,
                    );
                  setMessages((prev) => [...prev, message]);
                }
                break;
              }

              case "assistant_start":
                if (
                  currentTurnRef.current >= 0 &&
                  data.request_id === activeRequestIdRef.current &&
                  data.request_id
                )
                  break;
                setIsStreaming(true);
                streamingTextRef.current = "";
                currentTurnRef.current = -1;
                if (typeof data.request_id === "string") {
                  activeRequestIdRef.current = data.request_id;
                  latestRequestIdRef.current = data.request_id;
                }
                setActiveToolCalls([]);
                ensureTurnMessage(
                  typeof data.message_id === "string"
                    ? data.message_id
                    : undefined,
                );
                break;

              case "assistant_delta": {
                if (typeof data.content !== "string") break;
                streamingTextRef.current += data.content;
                const currentText = streamingTextRef.current;
                const turn = ensureTurnMessage(
                  typeof data.message_id === "string"
                    ? data.message_id
                    : undefined,
                );
                setMessages((prev) =>
                  prev.map((message, i) =>
                    i === turn ? { ...message, content: currentText } : message,
                  ),
                );
                break;
              }

              case "assistant_end": {
                if (
                  typeof data.message_id === "string" &&
                  currentTurnRef.current >= 0
                ) {
                  messageIndexesRef.current.set(
                    data.message_id,
                    currentTurnRef.current,
                  );
                }
                if (data.stopped === true) markTurnStopped();
                if (activeRequestIdRef.current)
                  finishedRequestsRef.current.add(activeRequestIdRef.current);
                resetTurnState();
                break;
              }

              case "subagent_batch": {
                if (
                  typeof data.batch_id !== "string" ||
                  typeof data.request_id !== "string"
                )
                  break;
                if (
                  data.status === "running" &&
                  !cancelledResearchRequestsRef.current.has(data.request_id)
                )
                  researchRef.current.set(data.batch_id, data.request_id);
                else if (
                  ["completed", "cancelled", "failed"].includes(data.status)
                )
                  researchRef.current.delete(data.batch_id);
                setIsResearching(researchRef.current.size > 0);
                break;
              }

              case "tool_call":
                setActiveToolCalls((prev) => [
                  ...prev,
                  {
                    toolName: data.toolName,
                    toolCallId: data.toolCallId,
                    status: "calling",
                  },
                ]);
                break;

              case "tool_result":
                // Prefer the per-call id so two concurrent calls of the same tool
                // resolve independently; fall back to toolName for legacy frames
                // (or when no in-flight entry carries the id).
                setActiveToolCalls((prev) => {
                  const byId =
                    typeof data.toolCallId === "string" &&
                    prev.some((tc) => tc.toolCallId === data.toolCallId);
                  return prev.map((tc) => {
                    const isMatch = byId
                      ? tc.toolCallId === data.toolCallId
                      : tc.toolName === data.toolName;
                    return isMatch ? { ...tc, status: "done" } : tc;
                  });
                });
                if (
                  typeof data.rawJson === "string" &&
                  data.rawJson.length > 0
                ) {
                  const turn = ensureTurnMessage();
                  setToolResults((prev) => [
                    ...prev,
                    { turn, toolName: data.toolName, rawJson: data.rawJson },
                  ]);
                }
                break;

              case "history_tool_result":
                if (
                  typeof data.rawJson === "string" &&
                  data.rawJson.length > 0 &&
                  typeof data.turn === "number"
                ) {
                  setToolResults((prev) => [
                    ...prev,
                    {
                      turn: data.turn,
                      toolName: data.toolName,
                      rawJson: data.rawJson,
                    },
                  ]);
                }
                break;

              case "cleared":
                resetTurnState();
                researchRef.current.clear();
                setIsResearching(false);
                setMessages([]);
                setToolResults([]);
                break;

              case "error":
                console.error("Agent connection operation failed");
                setError(data.error);
                resetTurnState();
                break;

              default:
            }
          } catch (err) {
            console.error("Agent connection operation failed");
          }
        };

        socket.onerror = (err) => {
          retired = true;
          socket.close(1000, "Connection failed");
          console.error("Agent connection operation failed");
          // A superseded socket erroring out must not clobber the winning
          // connection's state or reject its already-settled promise.
          if (myEpoch !== connectEpochRef.current) {
            resolve();
            return;
          }
          setIsConnected(false);
          setIsReconnecting(false);
          resetTurnState();
          if (wsRef.current === socket) wsRef.current = null;
          // Reaches the visible banner verbatim, so it names the thing the user
          // is actually looking at rather than the transport.
          setError(
            `Lost the connection to ${agentLabelRef.current}. Please try again.`,
          );
          reject(err);
        };

        socket.onclose = () => {
          retired = true;
          // Only the current-generation socket owns the shared connection flag;
          // a deliberately-superseded socket closing must not flip it.
          if (myEpoch !== connectEpochRef.current) {
            resolve();
            return;
          }
          setIsConnected(false);
          setIsReconnecting(false);
          resetTurnState();
          if (wsRef.current === socket) wsRef.current = null;
          // Closed before 'ready' arrived — settle so awaiting callers don't
          // hang. No-op if the promise already resolved. The message reaches
          // the error banner verbatim via sendMessage/newConversation, so it
          // must be user-friendly copy, not connection jargon.
          reject(
            new Error(
              `Couldn't connect to ${agentLabelRef.current} — please try again.`,
            ),
          );
        };
      });
      // Expose the in-flight connect so sendMessage can await replay completion
      // before transmitting. Cleared on settle; the rejection is swallowed by
      // the derived chain (the caller awaiting `promise` still receives it) so
      // an unobserved failure can't surface as an unhandled rejection.
      connectPromiseRef.current = promise;
      const clearInFlight = () => {
        clearTimeout(readyTimer);
        if (connectPromiseRef.current === promise) {
          connectPromiseRef.current = null;
        }
      };
      promise.then(clearInFlight, clearInFlight);
      return promise;
    },
    [resetTurnState, ensureTurnMessage, markTurnStopped, setMessages],
  );

  const fetchConversations = useCallback(
    async (next = false): Promise<ConversationSummary[]> => {
      if (!endpoints.listConversations && !endpoints.listConversationsPage)
        return [];
      const state = listStateRef.current;
      if (next && (!state.cursor || state.loading)) return [];
      const generation = ++state.generation;
      state.loading = true;
      setIsLoadingConversations(true);
      try {
        const page = endpoints.listConversationsPage
          ? await endpoints.listConversationsPage(
              next ? state.cursor! : undefined,
            )
          : {
              conversations: await endpoints.listConversations!(),
              nextCursor: null,
            };
        if (generation !== state.generation) return page.conversations;
        state.cursor = page.nextCursor;
        setHasMoreConversations(Boolean(page.nextCursor));
        setConversations((previous) =>
          Array.from(
            new Map(
              (next
                ? [...previous, ...page.conversations]
                : page.conversations
              ).map((row) => [row.id, row]),
            ).values(),
          ),
        );
        return page.conversations;
      } finally {
        if (generation === state.generation) {
          state.loading = false;
          setIsLoadingConversations(false);
        }
      }
    },
    [endpoints],
  );
  const loadMoreConversations = useCallback(async () => {
    await fetchConversations(true);
  }, [fetchConversations]);

  const reconnectToConversation = useCallback(
    async (conversation: ConversationSummary, epoch?: number) => {
      if (epoch !== undefined && epoch !== connectEpochRef.current) return;
      // The conversation_id from the server response is authoritative — extract
      // from wsPath as a fallback for older route shapes during deploys.
      const conversationId =
        conversation.id || extractConversationId(conversation.wsPath);
      if (!conversationId) {
        throw new Error("Conversation missing id");
      }
      conversationIdRef.current = conversationId;
      const wsPath = await endpoints.mintWsPath(
        conversationId,
        conversation.wsPath,
      );
      // The server replays the conversation's full history into a fresh socket,
      // so the local copy must be dropped before the replay lands — otherwise a
      // reconnect (e.g. sendMessage after the socket idled out) appends the
      // replay onto messages already on screen, duplicating the thread and
      // misaligning widget turn indexes. connectWebSocket performs the clear at
      // the winning socket's onopen so a FAILED reconnect keeps the visible
      // thread intact.
      await connectWebSocket(wsPath, epoch, { clearHistoryOnOpen: true });
    },
    [endpoints, connectWebSocket],
  );

  const createConversation = useCallback(
    async (epoch: number): Promise<string> => {
      const { conversationId, wsPath } = await endpoints.createConversation();
      if (epoch === connectEpochRef.current) {
        conversationIdRef.current = conversationId;
        const timestamp = new Date().toISOString();
        listStateRef.current.generation++;
        listStateRef.current.loading = false;
        setIsLoadingConversations(false);
        setConversations((previous) => [
          {
            id: conversationId,
            title: null,
            createdAt: timestamp,
            lastActiveAt: timestamp,
            wsPath,
          },
          ...previous.filter((row) => row.id !== conversationId),
        ]);
      }
      return wsPath;
    },
    [endpoints],
  );

  const connect = useCallback(async () => {
    // Already connected — nothing to do. This check MUST come before the
    // epoch bump below: claiming a generation for a no-op connect orphans the
    // live socket (its onmessage guard drops every subsequent frame) and the
    // chat goes permanently one-way. The alwaysCreateNew path keeps its
    // up-front bump — it closes the socket immediately.
    if (
      !options?.alwaysCreateNew &&
      wsRef.current?.readyState === WebSocket.OPEN
    )
      return;

    // Open a new connect generation. Each connect awaits a fetch before its
    // socket is assigned, so without this a second connect (e.g. the report
    // rail re-running on navigation, or the panel being closed/reopened during
    // connect) would leave the previous attempt's socket live and interleaving
    // a stale conversation. Capturing the generation lets the loser's socket
    // tear itself down once it finally opens.
    const epoch = ++connectEpochRef.current;

    // A KNOWN conversation (the embedding application owns its id from the
    // URL): there is nothing to list and nothing to create — connect straight
    // to it, spending the caller's wsPath once and minting afterwards.
    if (options.conversationId) {
      conversationIdRef.current = options.conversationId;
      setIsReconnecting(true);
      try {
        let wsPath = initialWsPathRef.current;
        if (wsPath) {
          initialWsPathRef.current = undefined;
        } else {
          wsPath = await endpoints.mintWsPath(options.conversationId);
        }
        if (epoch !== connectEpochRef.current) return;
        // The server replays this conversation's history into the fresh
        // socket, so the local copy is dropped at its onopen (a FAILED
        // reconnect keeps the visible thread intact).
        await connectWebSocket(wsPath, epoch, { clearHistoryOnOpen: true });
        if (epoch !== connectEpochRef.current) return;
        setIsReconnecting(false);
      } catch (err) {
        if (epoch !== connectEpochRef.current) return;
        setIsReconnecting(false);
        setError(err instanceof Error ? err.message : "Failed to connect");
      }
      return;
    }

    // Two flows land here: embedded / page-scoped assistants, which always
    // start a fresh conversation bound to the current page rather than
    // resurrecting the user's last global chat; and any flow with no listing
    // endpoint, for which there is no "most recent conversation" to restore in
    // the first place. If a previous page's WS is still open (the user
    // navigated between reports), close it before creating the new one.
    if (
      options?.alwaysCreateNew ||
      (!endpoints.listConversations && !endpoints.listConversationsPage)
    ) {
      resetTurnState();
      if (wsRef.current) {
        wsRef.current.close(1000, "New page context");
        wsRef.current = null;
      }
      conversationIdRef.current = null;
      setIsConnected(false);
      setMessages([]);
      setToolResults([]);
      setError(null);
      setStaleConversation(null);
      forceNewConversationRef.current = false;
      setIsReconnecting(true);
      try {
        const wsPath = await createConversation(epoch);
        // A newer connect superseded us while createConversation was in flight;
        // bail rather than open a socket the user no longer wants.
        if (epoch !== connectEpochRef.current) return;
        await connectWebSocket(wsPath, epoch);
        if (epoch !== connectEpochRef.current) return;
        setIsReconnecting(false);
      } catch (err) {
        if (epoch !== connectEpochRef.current) return;
        setIsReconnecting(false);
        setError(err instanceof Error ? err.message : "Failed to start chat");
      }
      return;
    }

    setIsReconnecting(true);
    try {
      const list = await fetchConversations();
      // A newer connect started while we were fetching — let it win.
      if (epoch !== connectEpochRef.current) return;
      if (list.length === 0) {
        setIsReconnecting(false);
        return;
      }
      const mostRecent = list[0];
      const ageMs = Date.now() - new Date(mostRecent.lastActiveAt).getTime();
      // Treat unparseable timestamps as "fresh" rather than stale — surfacing
      // them as stale would feed NaN to formatDistanceToNow in the view and
      // throw at render time.
      if (Number.isNaN(ageMs) || ageMs < STALE_CONVERSATION_TTL_MS) {
        // Fresh — restore the previous conversation as today.
        setStaleConversation(null);
        forceNewConversationRef.current = false;
        await reconnectToConversation(mostRecent, epoch);
      } else {
        // Stale — default to a new chat, surface the previous one for resume.
        setStaleConversation(mostRecent);
        forceNewConversationRef.current = true;
        setIsReconnecting(false);
      }
    } catch {
      if (epoch !== connectEpochRef.current) return;
      setIsReconnecting(false);
    }
  }, [
    fetchConversations,
    reconnectToConversation,
    options?.alwaysCreateNew,
    options.conversationId,
    endpoints,
    createConversation,
    connectWebSocket,
    resetTurnState,
    setMessages,
  ]);

  const sendMessage = useCallback(
    async (
      content: string,
      sendOptions?: { expectedConversationId: string },
    ) => {
      if (!content.trim()) return;
      const checkConversation = () => {
        if (
          sendOptions &&
          sendOptions.expectedConversationId !== conversationIdRef.current
        )
          throw new Error(
            "The conversation changed. Return to the original conversation to continue the approved action.",
          );
      };
      checkConversation();
      const sendEpoch = ++sendEpochRef.current;
      setIsLoading(true);
      setError(null);

      try {
        // A connect may still be mid-replay (wsRef is assigned at onopen, so
        // "readyState OPEN" doesn't mean the history replay has finished). Wait
        // for it so this send lands after the replayed thread rather than in
        // the middle of it — this also serialises rapid sends across a single
        // reconnect. A failed connect is its owner's to surface; the
        // reconnect/readyState logic below recovers here.
        const pendingConnect = connectPromiseRef.current;
        if (pendingConnect) {
          try {
            await pendingConnect;
          } catch {
            // Swallowed deliberately — fall through to the reconnect below.
          }
        }

        // Reconnect to existing conversation or create new one. Read the epoch
        // WITHOUT bumping when the socket is already OPEN — claiming a
        // generation for a plain send would orphan the healthy socket.
        let epoch = connectEpochRef.current;
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          // Lazily opening a socket here is itself a connect — claim a generation
          // so an in-flight connect() can't open a competing socket underneath us.
          epoch = ++connectEpochRef.current;
          const selectedId =
            options.conversationId ||
            (!forceNewConversationRef.current && conversationIdRef.current);
          if (selectedId) {
            // Reconnect to the selected conversation, including after an idle disconnect. Listing (or creating)
            // here would silently move the user to a different board's chat.
            const wsPath = await endpoints.mintWsPath(selectedId);
            await connectWebSocket(wsPath, epoch, { clearHistoryOnOpen: true });
          } else if (forceNewConversationRef.current) {
            // TTL-stale intent: commit to a fresh conversation rather than
            // resurrect the previous one. The banner clears once the new
            // conversation is created server-side.
            const wsPath = await createConversation(epoch);
            await connectWebSocket(wsPath, epoch);
            forceNewConversationRef.current = false;
            setStaleConversation(null);
          } else {
            const list = await fetchConversations();
            const existing = list.length > 0 ? list[0] : null;
            if (existing) {
              await reconnectToConversation(existing, epoch);
            } else {
              const wsPath = await createConversation(epoch);
              await connectWebSocket(wsPath, epoch);
            }
          }
        }

        // Superseded while reconnecting (the user switched conversation or
        // started a new chat mid-flight) — drop the send rather than deliver it
        // into whichever conversation wsRef now holds.
        if (
          epoch !== connectEpochRef.current ||
          sendEpoch !== sendEpochRef.current
        )
          return;

        checkConversation();
        // Send message. The outgoing message is appended AFTER any reconnect
        // above — connectWebSocket resolves once the server's history replay
        // has finished ('ready'), so the new message always lands at the end of
        // the replayed thread instead of being buried by it.
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          const requestId = options.identifiedRequests
            ? crypto.randomUUID()
            : undefined;
          activeRequestIdRef.current = requestId;
          latestRequestIdRef.current = requestId;
          currentTurnRef.current = -1;
          streamingTextRef.current = "";
          ignoreLegacyFramesRef.current = false;
          setIsLoading(true);
          const pageContext = getMessageContextRef.current?.();
          wsRef.current.send(
            JSON.stringify({
              type: "message",
              content,
              ...(requestId ? { request_id: requestId } : {}),
              ...(pageContext ? { pageContext } : {}),
            }),
          );
          setMessages((prev) => [...prev, { role: "user", content }]);
        } else {
          throw new Error(
            `Couldn't reach ${agentLabelRef.current} to send that. Please try again.`,
          );
        }
      } catch (err) {
        if (sendEpoch !== sendEpochRef.current) return;
        console.error("Agent connection operation failed");
        setError(err instanceof Error ? err.message : "Failed to send message");
        setIsLoading(false);
        throw err;
      }
    },
    [
      fetchConversations,
      reconnectToConversation,
      createConversation,
      connectWebSocket,
      options.conversationId,
      options.identifiedRequests,
      endpoints,
      setMessages,
    ],
  );

  const newConversation = useCallback(async () => {
    // Supersede any in-flight connect so its socket can't open underneath the
    // fresh conversation the user just asked for.
    const epoch = ++connectEpochRef.current;
    resetTurnState();
    sendEpochRef.current++;
    researchRef.current.clear();
    setIsResearching(false);
    if (wsRef.current) {
      wsRef.current.close(1000, "New conversation");
      wsRef.current = null;
    }
    conversationIdRef.current = null;
    setIsConnected(false);
    setMessages([]);
    setToolResults([]);
    setError(null);
    setStaleConversation(null);
    forceNewConversationRef.current = false;
    setIsReconnecting(true);
    try {
      // Create a fresh conversation server-side and connect to it. Without
      // this, sendMessage's auto-reconnect logic would pick up the most-recent
      // existing conversation and put the user right back in the old one.
      const wsPath = await createConversation(epoch);
      await connectWebSocket(wsPath, epoch);
    } catch (err) {
      if (epoch !== connectEpochRef.current) return;
      setIsReconnecting(false);
      setError(err instanceof Error ? err.message : "Failed to start new chat");
    }
  }, [createConversation, connectWebSocket, resetTurnState, setMessages]);

  const switchConversation = useCallback(
    async (conversation: ConversationSummary) => {
      // Supersede any in-flight connect so it can't clobber the conversation the
      // user is switching to.
      const epoch = ++connectEpochRef.current;
      resetTurnState();
      sendEpochRef.current++;
      researchRef.current.clear();
      setIsResearching(false);
      if (wsRef.current) {
        wsRef.current.close(1000, "Switching conversation");
        wsRef.current = null;
      }
      setIsConnected(false);
      setMessages([]);
      setToolResults([]);
      setError(null);
      setIsReconnecting(true);
      try {
        await reconnectToConversation(conversation, epoch);
      } catch {
        if (epoch !== connectEpochRef.current) return;
        setIsReconnecting(false);
      }
    },
    [reconnectToConversation, resetTurnState, setMessages],
  );

  const refreshConversations = useCallback(async () => {
    await fetchConversations();
  }, [fetchConversations]);

  const resumeStaleConversation = useCallback(async () => {
    const target = staleConversation;
    if (!target) return;
    forceNewConversationRef.current = false;
    setStaleConversation(null);
    await switchConversation(target);
  }, [staleConversation, switchConversation]);

  const reset = useCallback(() => {
    // Invalidate any in-flight connect so it can't reopen a socket after reset.
    connectEpochRef.current++;
    listStateRef.current.generation++;
    listStateRef.current.loading = false;
    setIsLoadingConversations(false);
    if (wsRef.current) {
      wsRef.current.close(1000, "Reset");
      wsRef.current = null;
    }
    conversationIdRef.current = null;
    forceNewConversationRef.current = false;
    setIsConnected(false);
    resetTurnState();
    sendEpochRef.current++;
    researchRef.current.clear();
    setIsResearching(false);
    setIsReconnecting(false);
    setMessages([]);
    setToolResults([]);
    setError(null);
    setStaleConversation(null);
  }, [resetTurnState, setMessages]);

  const deleteConversation = useCallback(
    async (id: string) => {
      try {
        if (!endpoints.deleteConversation) return;
        const response = await endpoints.deleteConversation(id);
        // 409 means the conversation is still streaming a turn server-side.
        // Surface the user-actionable message the route deliberately
        // propagated from the DO, and DO NOT mutate the local list — the
        // conversation still exists on the server. The user can retry once
        // the turn finishes.
        if (response.status === 409) {
          let message =
            "Conversation is currently processing a message; try again in a moment.";
          try {
            const body = (await response.json()) as { error?: string };
            if (body && typeof body.error === "string" && body.error) {
              message = body.error;
            }
          } catch {
            // Defensive: body was missing or not JSON. Fall through to the
            // generic 409 copy above.
          }
          setError(message);
          return;
        }
        if (!response.ok) {
          throw new Error(`Failed to delete conversation: ${response.status}`);
        }
        listStateRef.current.generation++;
        listStateRef.current.loading = false;
        setIsLoadingConversations(false);
        setConversations((prev) => prev.filter((c) => c.id !== id));
        // If the deleted conversation is the currently-active one, drop back to
        // a blank panel state so the user isn't stuck looking at a zombie chat.
        if (conversationIdRef.current === id) {
          reset();
        }
      } catch (err) {
        console.error("Agent connection operation failed");
        setError(
          err instanceof Error ? err.message : "Failed to delete conversation",
        );
      }
    },
    [reset, endpoints],
  );

  return {
    isConnected,
    isLoading,
    isStreaming,
    isReconnecting,
    isResearching,
    conversationId: conversationIdRef.current,
    conversations,
    hasMoreConversations,
    isLoadingConversations,
    loadMoreConversations,
    messages,
    activeToolCalls,
    toolResults,
    error,
    staleConversation,
    connect,
    sendMessage,
    cancel,
    cancelResearch,
    newConversation,
    switchConversation,
    refreshConversations,
    resumeStaleConversation,
    deleteConversation,
    reset,
  };
}

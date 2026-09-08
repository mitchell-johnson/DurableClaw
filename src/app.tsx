import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useAgentChat, type ToolResultRecord } from "./hooks/useAgentChat";
import { createApi, createChatEndpoints, type Api } from "./hooks/api";
import "./styles.css";

type Tab = "chat" | "settings" | "memory" | "activity";
function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}

export function App() {
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  if (token)
    return (
      <Workspace
        token={token}
        signOut={() => {
          setToken("");
          setDraft("");
        }}
      />
    );
  async function signIn(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await createApi(draft)("/api/agent/init", { method: "POST", body: "{}" });
      setToken(draft);
      setDraft("");
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="login">
      <form className="login-card" onSubmit={signIn}>
        <div className="brand-mark">D</div>
        <h1>DurableClaw</h1>
        <p>Your persistent agent workspace.</p>
        <label>
          Access token
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            required
          />
        </label>
        <p className="muted">
          Use an access token issued by your workspace operator. It stays in
          this browser tab’s memory.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button className="primary" disabled={pending || !draft.trim()}>
          {pending ? "Connecting…" : "Open workspace"}
        </button>
      </form>
    </main>
  );
}
function Workspace({ token, signOut }: { token: string; signOut: () => void }) {
  const api = useMemo(() => createApi(token), [token]);
  const endpoints = useMemo(() => createChatEndpoints(token), [token]);
  const chat = useAgentChat({
    endpoints,
    identifiedRequests: true,
    agentLabel: "DurableClaw",
  });
  const [tab, setTab] = useState<Tab>("chat");
  const [draft, setDraft] = useState("");
  const [actionError, setActionError] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void chat.connect().catch((error) => setActionError(errorText(error)));
  }, [token]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [chat.messages, chat.activeToolCalls]);
  const busy = chat.isLoading || chat.isStreaming;
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    const content = draft;
    setDraft("");
    setActionError("");
    try {
      await chat.sendMessage(content);
    } catch (error) {
      setActionError(errorText(error));
      setDraft(content);
    }
  }
  async function decision(
    result: ToolResultRecord,
    id: string,
    approved: boolean,
  ) {
    const conversationId = chat.conversationId;
    if (!conversationId)
      throw new Error("Open the original conversation to review this action.");
    await api(
      `/api/agent/conversations/${encodeURIComponent(conversationId)}/confirmations/${encodeURIComponent(id)}`,
      {
        method: "POST",
        body: JSON.stringify({ decision: approved ? "confirmed" : "declined" }),
      },
    );
    if (approved)
      await chat.sendMessage(
        `I approved confirmation ${id}. Continue with the approved ${result.toolName} action using the same arguments and that confirmation ID.`,
        { expectedConversationId: conversationId },
      );
  }
  return (
    <div className="workspace">
      <aside className="sidebar">
        <h1>
          <span className="brand-mark small">D</span> DurableClaw
        </h1>
        <button
          className="primary"
          onClick={() => {
            chat.newConversation();
            setTab("chat");
          }}
        >
          New conversation
        </button>
        <nav aria-label="Workspace sections">
          {(["chat", "settings", "memory", "activity"] as Tab[]).map(
            (value) => (
              <button
                className={tab === value ? "selected" : ""}
                key={value}
                onClick={() => setTab(value)}
              >
                {value === "chat"
                  ? "Conversations"
                  : value[0].toUpperCase() + value.slice(1)}
              </button>
            ),
          )}
        </nav>
        <div className="conversation-list">
          {chat.conversations.map((conversation) => (
            <div className="conversation-row" key={conversation.id}>
              <button
                className={
                  conversation.id === chat.conversationId ? "selected" : ""
                }
                onClick={() => {
                  setTab("chat");
                  void chat
                    .switchConversation(conversation)
                    .catch((error) => setActionError(errorText(error)));
                }}
              >
                {conversation.title || "Untitled conversation"}
              </button>
              <button
                className="icon-button"
                aria-label={`Delete ${conversation.title || "conversation"}`}
                onClick={() => setDeleting(conversation.id)}
              >
                ×
              </button>
            </div>
          ))}
          {chat.hasMoreConversations && (
            <button
              disabled={chat.isLoadingConversations}
              onClick={() =>
                void chat
                  .loadMoreConversations()
                  .catch((error) => setActionError(errorText(error)))
              }
            >
              Load older conversations
            </button>
          )}
        </div>
        <button
          onClick={() => {
            chat.reset();
            signOut();
          }}
        >
          Sign out
        </button>
      </aside>
      <main className="main-panel">
        <header className="panel-header">
          <h2>
            {tab === "chat"
              ? "Conversation"
              : tab[0].toUpperCase() + tab.slice(1)}
          </h2>
          <span className={`connection ${chat.isConnected ? "connected" : ""}`}>
            {chat.isReconnecting
              ? "Reconnecting…"
              : chat.isConnected
                ? "Connected"
                : "Offline"}
          </span>
        </header>
        {(actionError || chat.error) && (
          <p role="alert" className="error banner">
            {actionError || chat.error}
          </p>
        )}
        {tab === "chat" ? (
          <>
            <div className="transcript" aria-live="polite">
              {chat.staleConversation && (
                <div className="notice">
                  Your previous conversation is available.{" "}
                  <button
                    onClick={() =>
                      void chat
                        .resumeStaleConversation()
                        .catch((error) => setActionError(errorText(error)))
                    }
                  >
                    Resume conversation
                  </button>
                </div>
              )}
              {chat.messages.length === 0 && (
                <div className="empty-state">
                  <h3>What would you like to work on?</h3>
                  <p>
                    Search your workspace, explore a question, or ask for
                    several independent investigations.
                  </p>
                </div>
              )}
              {chat.messages.map((message, index) => (
                <article
                  className={`message ${message.role}`}
                  key={`${chat.conversationId}:${index}`}
                >
                  <span className="message-role">
                    {message.role === "user" ? "You" : "DurableClaw"}
                  </span>
                  <div className="message-text">
                    {message.content ||
                      (busy && index === chat.messages.length - 1
                        ? "Working…"
                        : "")}
                  </div>
                  {message.stopped &&
                    !message.content.includes("_(Stopped)_") && (
                      <span className="muted">Stopped</span>
                    )}
                  {chat.toolResults
                    .filter((result) => result.turn === index)
                    .map((result, i) => (
                      <ToolResult
                        key={`${result.toolName}:${i}:${result.rawJson}`}
                        result={result}
                        busy={busy}
                        decide={decision}
                      />
                    ))}
                </article>
              ))}
              {chat.activeToolCalls.length > 0 && (
                <p className="muted">
                  {chat.activeToolCalls
                    .map((tool) => `${tool.toolName}: ${tool.status}`)
                    .join(" · ")}
                </p>
              )}
              {chat.isResearching && (
                <div className="notice">
                  Research is running. You can continue this conversation.
                  <button onClick={chat.cancelResearch}>Stop research</button>
                </div>
              )}
              <div ref={endRef} />
            </div>
            <form className="composer" onSubmit={send}>
              <label className="sr-only" htmlFor="message">
                Message
              </label>
              <textarea
                id="message"
                placeholder="Ask DurableClaw…"
                value={draft}
                rows={3}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send(event);
                  }
                }}
              />
              <div className="composer-actions">
                <span className="muted">Shift + Enter for a new line</span>
                {busy ? (
                  <button type="button" onClick={chat.cancel}>
                    Stop
                  </button>
                ) : (
                  <button className="primary" disabled={!draft.trim()}>
                    Send
                  </button>
                )}
              </div>
            </form>
          </>
        ) : tab === "settings" ? (
          <Settings api={api} />
        ) : tab === "memory" ? (
          <Memories api={api} />
        ) : (
          <Activity api={api} />
        )}
      </main>
      {deleting && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
          >
            <h3 id="delete-title">Delete conversation?</h3>
            <p>
              This removes its transcript and stops its research. Memories can
              be managed separately.
            </p>
            <div className="button-row">
              <button onClick={() => setDeleting(null)}>
                Keep conversation
              </button>
              <button
                className="danger"
                onClick={async () => {
                  try {
                    await chat.deleteConversation(deleting);
                    setDeleting(null);
                  } catch (error) {
                    setActionError(errorText(error));
                  }
                }}
              >
                Delete conversation
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
function ToolResult({
  result,
  busy,
  decide,
}: {
  result: ToolResultRecord;
  busy: boolean;
  decide: (
    result: ToolResultRecord,
    id: string,
    approved: boolean,
  ) => Promise<void>;
}) {
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(result.rawJson);
    if (parsed && typeof parsed === "object") data = parsed;
  } catch {
    /* Plain text tool result. */
  }
  const [state, setState] = useState<
    "pending" | "saving" | "approved" | "declined"
  >("pending");
  const [error, setError] = useState("");
  async function apply(approved: boolean) {
    setState("saving");
    setError("");
    try {
      await decide(result, data.confirmation_id as string, approved);
      setState(approved ? "approved" : "declined");
    } catch (error) {
      setState("pending");
      setError(errorText(error));
    }
  }
  return (
    <details className="tool-result" open={data.needs_confirmation === true}>
      <summary>{result.toolName}</summary>
      {data.needs_confirmation === true &&
      typeof data.confirmation_id === "string" ? (
        <>
          <p>
            {typeof data.preview === "string"
              ? data.preview
              : "Review this action before it runs."}
          </p>
          {state === "pending" ? (
            <div className="button-row">
              <button
                disabled={busy}
                className="primary"
                onClick={() => void apply(true)}
              >
                Approve
              </button>
              <button disabled={busy} onClick={() => void apply(false)}>
                Decline
              </button>
            </div>
          ) : (
            <p>
              {state === "saving"
                ? "Saving decision…"
                : state === "approved"
                  ? "Approved"
                  : "Declined"}
            </p>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </>
      ) : (
        <pre>{result.rawJson}</pre>
      )}
    </details>
  );
}
function Settings({ api }: { api: Api }) {
  const [persona, setPersona] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [pending, setPending] = useState(false);
  const [mcp, setMcp] = useState("[]");
  const [disabled, setDisabled] = useState("");
  useEffect(() => {
    let active = true;
    void api("/api/agent/persona")
      .then((data) => {
        if (!active) return;
        setPersona(data.persona);
        setMcp(JSON.stringify(data.persona.mcp_servers ?? [], null, 2));
        setDisabled((data.persona.disabled_tools ?? []).join(", "));
      })
      .catch((error) => {
        if (active) setError(errorText(error));
      });
    return () => {
      active = false;
    };
  }, [api]);
  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    setSaved(false);
    try {
      const servers = JSON.parse(mcp);
      if (!Array.isArray(servers))
        throw new Error("MCP servers must be a JSON array.");
      await api("/api/agent/persona", {
        method: "PUT",
        body: JSON.stringify({
          identity_override: persona?.identity_override || null,
          persona: persona?.persona || null,
          reasoning_effort: persona?.reasoning_effort || null,
          memory_enabled: persona?.memory_enabled,
          wake_interval_minutes: persona?.wake_interval_minutes || null,
          dream_interval_hours: persona?.dream_interval_hours || null,
          disabled_tools: disabled
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
          mcp_servers: servers,
        }),
      });
      setSaved(true);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setPending(false);
    }
  }
  const update = (key: string, value: unknown) => {
    setSaved(false);
    setPersona((previous) => ({ ...previous, [key]: value }));
  };
  return (
    <section className="settings-page">
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {persona ? (
        <form onSubmit={save}>
          <label>
            Agent instructions
            <textarea
              rows={5}
              value={persona.persona ?? ""}
              onChange={(event) => update("persona", event.target.value)}
            />
          </label>
          <label>
            Identity and tone
            <textarea
              rows={3}
              value={persona.identity_override ?? ""}
              onChange={(event) =>
                update("identity_override", event.target.value)
              }
            />
          </label>
          <label>
            Response depth
            <select
              value={persona.reasoning_effort ?? ""}
              onChange={(event) =>
                update("reasoning_effort", event.target.value || null)
              }
            >
              <option value="">Provider default</option>
              <option value="fast">Fast</option>
              <option value="thorough">Thorough</option>
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={persona.memory_enabled !== false}
              onChange={(event) =>
                update("memory_enabled", event.target.checked)
              }
            />
            Remember conversation context
          </label>
          <label>
            Proactive check-ins
            <select
              value={persona.wake_interval_minutes ?? ""}
              onChange={(event) =>
                update(
                  "wake_interval_minutes",
                  Number(event.target.value) || null,
                )
              }
            >
              <option value="">Off</option>
              {[10, 20, 30, 45, 60].map((value) => (
                <option key={value} value={value}>
                  Every {value} minutes
                </option>
              ))}
            </select>
          </label>
          <label>
            Memory consolidation
            <select
              value={persona.dream_interval_hours ?? ""}
              onChange={(event) =>
                update(
                  "dream_interval_hours",
                  Number(event.target.value) || null,
                )
              }
            >
              <option value="">Off</option>
              {[12, 24, 48].map((value) => (
                <option key={value} value={value}>
                  Every {value} hours
                </option>
              ))}
            </select>
          </label>
          <details>
            <summary>Tool and MCP configuration</summary>
            <label>
              Disabled tools (comma separated)
              <input
                value={disabled}
                onChange={(event) => setDisabled(event.target.value)}
              />
            </label>
            <label>
              MCP servers (JSON)
              <textarea
                className="code-input"
                rows={8}
                value={mcp}
                onChange={(event) => setMcp(event.target.value)}
              />
            </label>
            <p className="muted">
              Use the server configuration format documented in the repository.
              Remote tools require your approval before execution.
            </p>
          </details>
          <div className="button-row">
            <button className="primary" disabled={pending}>
              {pending ? "Saving…" : "Save settings"}
            </button>
            {saved && <span role="status">Saved</span>}
          </div>
        </form>
      ) : (
        !error && <p>Loading settings…</p>
      )}
    </section>
  );
}
function Memories({ api }: { api: Api }) {
  const [memories, setMemories] = useState<Record<string, any>[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [forget, setForget] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const generation = useRef(0);
  const mutations = useRef(new Set<string>());
  const [loading, setLoading] = useState(false);
  const [pendingDeletes, setPendingDeletes] = useState(new Set<string>());
  function invalidate() {
    generation.current++;
    setLoading(false);
  }
  async function load(next?: string) {
    if (mutations.current.size) return;
    const epoch = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const data = await api(
        `/api/agent/memories${next ? `?cursor=${encodeURIComponent(next)}` : ""}`,
      );
      if (epoch !== generation.current) return;
      setMemories(
        (previous) =>
          Array.from(
            new Map(
              (next ? [...previous, ...data.memories] : data.memories).map(
                (memory: Record<string, any>) => [memory.vector_id, memory],
              ),
            ).values(),
          ) as Record<string, any>[],
      );
      setCursor(data.next_cursor ?? null);
    } catch (error) {
      if (epoch === generation.current) setError(errorText(error));
    } finally {
      if (epoch === generation.current) setLoading(false);
    }
  }
  async function remove(id: string, operation: () => Promise<void>) {
    if (mutations.current.has(id)) return;
    mutations.current.add(id);
    setPendingDeletes(new Set(mutations.current));
    invalidate();
    setError("");
    try {
      await operation();
    } catch (error) {
      setError(errorText(error));
    } finally {
      invalidate();
      mutations.current.delete(id);
      setPendingDeletes(new Set(mutations.current));
    }
  }
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [api]);
  return (
    <section className="settings-page">
      <div className="button-row">
        <button
          disabled={loading || pendingDeletes.size > 0}
          onClick={() => void load()}
        >
          Refresh
        </button>
        <button
          className="danger"
          disabled={pendingDeletes.size > 0}
          onClick={() => setForget(true)}
        >
          Forget all memories
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {memories.length === 0 && (
        <p className="muted">No memories to display.</p>
      )}
      {memories.map((memory) => (
        <article className="record-card" key={memory.vector_id}>
          <div className="button-row">
            <span className="badge">
              {memory.type} · {memory.tier}
            </span>
            <button
              disabled={
                pendingDeletes.has(memory.vector_id) ||
                pendingDeletes.has("all")
              }
              onClick={() =>
                void remove(memory.vector_id, async () => {
                  await api(
                    `/api/agent/memories/${encodeURIComponent(memory.vector_id)}`,
                    { method: "DELETE" },
                  );
                  setMemories((previous) =>
                    previous.filter(
                      (item) => item.vector_id !== memory.vector_id,
                    ),
                  );
                })
              }
            >
              Forget
            </button>
          </div>
          <p className="message-text">{memory.content_preview}</p>
        </article>
      ))}
      {cursor && (
        <button
          disabled={loading || pendingDeletes.size > 0}
          onClick={() => void load(cursor)}
        >
          Load more
        </button>
      )}
      {forget && (
        <div className="notice">
          <h3>Forget all memories</h3>
          <p>
            This removes remembered context and archived memories. Type FORGET
            to continue.
          </p>
          <label>
            Confirmation
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button
              onClick={() => {
                setForget(false);
                setConfirmation("");
              }}
            >
              Cancel
            </button>
            <button
              className="danger"
              disabled={confirmation !== "FORGET" || pendingDeletes.size > 0}
              onClick={() =>
                void remove("all", async () => {
                  await api("/api/agent/memories/forget-all", {
                    method: "POST",
                    body: JSON.stringify({ confirm: confirmation }),
                  });
                  setMemories([]);
                  setCursor(null);
                  setForget(false);
                  setConfirmation("");
                })
              }
            >
              Forget all
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
function Activity({ api }: { api: Api }) {
  const [runs, setRuns] = useState<Record<string, any>[]>([]);
  const [inbox, setInbox] = useState<Record<string, any>[]>([]);
  const [transcript, setTranscript] = useState<unknown>(null);
  const [error, setError] = useState("");
  async function load() {
    setError("");
    const results = await Promise.allSettled([
      api("/api/agent/activity/wakes"),
      api("/api/inbox"),
    ]);
    if (results[0].status === "fulfilled") setRuns(results[0].value.runs ?? []);
    else setError(errorText(results[0].reason));
    if (results[1].status === "fulfilled")
      setInbox(results[1].value.items ?? results[1].value.inbox ?? []);
    else setError(errorText(results[1].reason));
  }
  useEffect(() => {
    void load();
  }, [api]);
  return (
    <section className="settings-page">
      <button onClick={() => void load()}>Refresh activity</button>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <h3>Inbox</h3>
      {inbox.length === 0 && <p className="muted">No messages yet.</p>}
      {inbox.map((item, index) => (
        <article className="record-card" key={item.id ?? index}>
          <h4>{item.title ?? item.kind ?? "Agent update"}</h4>
          <p className="message-text">
            {item.content ?? item.message ?? item.body}
          </p>
        </article>
      ))}
      <h3>Proactive activity</h3>
      {runs.length === 0 && (
        <p className="muted">
          No proactive runs yet. Enable check-ins in Settings when you want the
          agent to review workspace signals.
        </p>
      )}
      {runs.map((run) => (
        <article className="record-card" key={run.run_id}>
          <div className="button-row">
            <span className="badge">{run.status}</span>
            <time>{new Date(run.started_at).toLocaleString()}</time>
          </div>
          <p>{run.excerpt}</p>
          <button
            onClick={async () => {
              try {
                setTranscript(
                  await api(
                    `/api/agent/activity/wakes/${encodeURIComponent(run.run_id)}`,
                  ),
                );
              } catch (error) {
                setError(errorText(error));
              }
            }}
          >
            View run details
          </button>
        </article>
      ))}
      {transcript !== null && (
        <details open>
          <summary>Run details</summary>
          <pre className="json-view">{JSON.stringify(transcript, null, 2)}</pre>
        </details>
      )}
    </section>
  );
}

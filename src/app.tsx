import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useAgentChat, type ToolResultRecord } from "./hooks/useAgentChat";
import { createApi, createChatEndpoints, type Api } from "./hooks/api";
import { Connections } from "./components/Connections";
import { ServiceConnections } from "./components/ServiceConnections";
import { NativeLogin } from "./components/NativeLogin";
import { AccountSecurity } from "./components/AccountSecurity";
import {
  authRequest,
  authErrorStatus,
  type AuthMode,
  type AuthOptions,
} from "./hooks/authClient";
import "./styles.css";

type Tab = "chat" | "settings" | "memory" | "activity" | "connections";

function useCompactLayout() {
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width: 860px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 860px)");
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return compact;
}

function Modal({
  children,
  className = "modal",
  labelledBy,
  onClose,
}: {
  children: ReactNode;
  className?: string;
  labelledBy: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      {children}
    </dialog>
  );
}
function errorText(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}

export function App() {
  const [session, setSession] = useState<{
    token: string;
    mode: AuthMode;
  } | null>(null);
  const [options, setOptions] = useState<AuthOptions>({
    enabled: false,
    accessRecovery: false,
  });
  const [checking, setChecking] = useState(true);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      const [configuration, current] = await Promise.allSettled([
        authRequest<AuthOptions>("/api/auth/options"),
        authRequest<{ authenticated: boolean; auth_mode: AuthMode }>(
          "/api/session",
        ),
      ]);
      if (!active) return;
      if (configuration.status === "fulfilled")
        setOptions({
          enabled: configuration.value?.enabled === true,
          accessRecovery: configuration.value?.accessRecovery === true,
        });
      let exchangingAccess = false;
      try {
        if (
          current.status === "fulfilled" &&
          current.value.authenticated &&
          ["native", "access"].includes(current.value.auth_mode)
        ) {
          if (
            current.value.auth_mode === "access" &&
            configuration.status === "fulfilled" &&
            configuration.value?.enabled === true
          ) {
            window.location.assign("/api/auth/access");
            exchangingAccess = true;
            return;
          }
          await createApi("")("/api/agent/init", {
            method: "POST",
            body: "{}",
          });
          if (active) setSession({ token: "", mode: current.value.auth_mode });
        } else if (
          current.status === "rejected" &&
          authErrorStatus(current.reason) !== 401
        ) {
          setError("Your session could not be checked. Please sign in again.");
        }
      } catch {
        if (active)
          setError(
            "The workspace could not be opened. Please try signing in again.",
          );
      } finally {
        if (active && !exchangingAccess) setChecking(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);
  async function nativeSignedIn() {
    const current = await authRequest<{
      authenticated: boolean;
      auth_mode: AuthMode;
    }>("/api/session");
    if (!current.authenticated || current.auth_mode !== "native")
      throw new Error("Native session unavailable");
    await createApi("")("/api/agent/init", { method: "POST", body: "{}" });
    setError("");
    setSession({ token: "", mode: "native" });
  }
  async function signOut() {
    if (session?.mode === "native") await authRequest("/api/auth/sign-out", {});
    else if (session?.mode === "access")
      window.location.assign("/cdn-cgi/access/logout");
    setSession(null);
    setDraft("");
    setError("");
  }
  if (session !== null)
    return (
      <Workspace
        token={session.token}
        signOut={signOut}
        authOptions={options}
      />
    );
  if (checking)
    return (
      <main className="login">
        <section className="login-card">
          <div className="brand-mark">D</div>
          <h1>DurableClaw</h1>
          <p role="status">Checking your session…</p>
        </section>
      </main>
    );
  if (options.enabled)
    return (
      <NativeLogin
        accessRecovery={options.accessRecovery}
        onAuthenticated={nativeSignedIn}
        sessionError={error}
      />
    );
  async function signIn(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await createApi(draft)("/api/agent/init", { method: "POST", body: "{}" });
      setSession({ token: draft, mode: "token" });
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
function Workspace({
  token,
  signOut,
  authOptions,
}: {
  token: string;
  signOut: () => Promise<void>;
  authOptions: AuthOptions;
}) {
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
  const [menuOpen, setMenuOpen] = useState(false);
  const compact = useCompactLayout();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const followMessages = useRef(true);
  useEffect(() => {
    void chat.connect().catch((error) => setActionError(errorText(error)));
  }, [token]);
  useEffect(() => {
    if (!compact) setMenuOpen(false);
  }, [compact]);
  useLayoutEffect(() => {
    // Safari's on-screen keyboard changes the visual viewport, not 100dvh.
    const viewport = window.visualViewport;
    const workspace = workspaceRef.current;
    if (!compact || !viewport || !workspace) return;
    const resize = () => {
      // Preserve native pinch zoom instead of resizing the UI while zooming.
      if (viewport.scale !== 1) return;
      workspace.style.setProperty("--workspace-height", `${viewport.height}px`);
      workspace.style.setProperty("--workspace-top", `${viewport.offsetTop}px`);
      const transcript = transcriptRef.current;
      if (transcript && followMessages.current)
        transcript.scrollTop = transcript.scrollHeight;
    };
    resize();
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("scroll", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      viewport.removeEventListener("scroll", resize);
      workspace.style.removeProperty("--workspace-height");
      workspace.style.removeProperty("--workspace-top");
    };
  }, [compact]);
  useLayoutEffect(() => {
    followMessages.current = true;
  }, [chat.conversationId, tab]);
  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript && followMessages.current)
      transcript.scrollTop = transcript.scrollHeight;
  }, [chat.messages, chat.activeToolCalls, chat.conversationId, tab]);
  useLayoutEffect(() => {
    const input = composerRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight + 2}px`;
    const transcript = transcriptRef.current;
    if (transcript && followMessages.current)
      transcript.scrollTop = transcript.scrollHeight;
  }, [draft, tab]);
  function newConversation() {
    chat.newConversation();
    setTab("chat");
    setMenuOpen(false);
  }
  const busy = chat.isLoading || chat.isStreaming;
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    const content = draft;
    followMessages.current = true;
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
  const navigation = (
    <aside className="sidebar" aria-label="Workspace navigation">
      <div className="sidebar-heading">
        <h1 id="navigation-title">
          <span className="brand-mark small">D</span> DurableClaw
        </h1>
        {compact && (
          <button
            className="icon-button"
            aria-label="Close navigation"
            onClick={() => setMenuOpen(false)}
          >
            <span aria-hidden="true">×</span>
          </button>
        )}
      </div>
      <button className="primary" onClick={newConversation}>
        New conversation
      </button>
      <nav aria-label="Workspace sections">
        {(
          ["chat", "settings", "connections", "memory", "activity"] as Tab[]
        ).map((value) => (
          <button
            className={tab === value ? "selected" : ""}
            aria-current={tab === value ? "page" : undefined}
            key={value}
            onClick={() => {
              setTab(value);
              setMenuOpen(false);
            }}
          >
            {value === "chat"
              ? "Conversations"
              : value[0].toUpperCase() + value.slice(1)}
          </button>
        ))}
      </nav>
      <div className="conversation-list">
        <h2 className="conversation-list-heading">Recent conversations</h2>
        {chat.conversations.map((conversation) => (
          <div className="conversation-row" key={conversation.id}>
            <button
              className={
                conversation.id === chat.conversationId ? "selected" : ""
              }
              onClick={() => {
                setTab("chat");
                setMenuOpen(false);
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
              onClick={() => {
                setMenuOpen(false);
                setDeleting(conversation.id);
              }}
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
        onClick={async () => {
          try {
            await signOut();
            chat.reset();
          } catch {
            setMenuOpen(false);
            setActionError(
              "Sign-out could not be completed. Please try again.",
            );
          }
        }}
      >
        Sign out
      </button>
    </aside>
  );
  return (
    <div className="workspace" ref={workspaceRef}>
      {compact
        ? menuOpen && (
            <Modal
              className="navigation-drawer"
              labelledBy="navigation-title"
              onClose={() => setMenuOpen(false)}
            >
              {navigation}
            </Modal>
          )
        : navigation}
      <main className="main-panel">
        <header className="panel-header">
          {compact && (
            <button
              className="icon-button"
              aria-label="Open navigation"
              aria-haspopup="dialog"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          )}
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
          {compact && (
            <button
              className="icon-button"
              aria-label="New conversation"
              onClick={newConversation}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}
        </header>
        {(actionError || chat.error) && (
          <p role="alert" className="error banner">
            {actionError || chat.error}
          </p>
        )}
        {tab === "chat" ? (
          <>
            <div
              className="transcript"
              aria-live="polite"
              ref={transcriptRef}
              onScroll={(event) => {
                const transcript = event.currentTarget;
                followMessages.current =
                  transcript.scrollHeight -
                    transcript.scrollTop -
                    transcript.clientHeight <
                  80;
              }}
            >
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
            </div>
            <form className="composer" onSubmit={send}>
              <label className="sr-only" htmlFor="message">
                Message
              </label>
              <textarea
                id="message"
                ref={composerRef}
                placeholder="Ask DurableClaw…"
                value={draft}
                rows={1}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !window.matchMedia("(pointer: coarse)").matches &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void send(event);
                  }
                }}
              />
              <div className="composer-actions">
                <span className="muted keyboard-hint">
                  Shift + Enter for a new line
                </span>
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
          <Settings
            api={api}
            authOptions={authOptions}
            onSignInAgain={signOut}
          />
        ) : tab === "connections" ? (
          <div className="settings-page connections-page">
            <ServiceConnections api={api} />
            <Connections api={api} conversationId={chat.conversationId} />
          </div>
        ) : tab === "memory" ? (
          <Memories api={api} />
        ) : (
          <Activity api={api} />
        )}
      </main>
      {deleting && (
        <Modal labelledBy="delete-title" onClose={() => setDeleting(null)}>
          <h3 id="delete-title">Delete conversation?</h3>
          <p>
            This removes its transcript and stops its research. Memories can be
            managed separately.
          </p>
          <div className="button-row">
            <button onClick={() => setDeleting(null)}>Keep conversation</button>
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
        </Modal>
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
type HeartbeatStatus = {
  enabled: boolean;
  intervalMinutes: number | null;
  nextRunAt: number | null;
  lastRun: {
    status: string;
    startedAt: number;
    completedAt: number | null;
    error: string | null;
  } | null;
};

function HeartbeatSchedule({ heartbeat }: { heartbeat: HeartbeatStatus }) {
  const lastRun = heartbeat.lastRun;
  const lastCheck = lastRun ? (lastRun.completedAt ?? lastRun.startedAt) : null;
  const outcome =
    lastRun?.status === "failed"
      ? "The last check could not finish."
      : lastRun?.error != null
        ? "Some sources could not be checked. They will be retried."
        : lastRun?.status === "quiet"
          ? "Nothing needed your attention."
          : lastRun?.status === "running"
            ? "Checking now…"
            : lastRun?.status === "awaiting_batch"
              ? "Reviewing new events…"
              : lastRun?.status === "completed"
                ? "Check complete."
                : null;
  return (
    <div className="muted" aria-live="polite">
      {lastCheck !== null && (
        <p>
          Last check:{" "}
          <time dateTime={new Date(lastCheck).toISOString()}>
            {new Date(lastCheck).toLocaleString()}
          </time>
        </p>
      )}
      {outcome && <p>{outcome}</p>}
      {heartbeat.enabled && heartbeat.nextRunAt !== null && (
        <p>
          Next check:{" "}
          <time dateTime={new Date(heartbeat.nextRunAt).toISOString()}>
            {new Date(heartbeat.nextRunAt).toLocaleString()}
          </time>
        </p>
      )}
    </div>
  );
}

function Settings({
  api,
  authOptions,
  onSignInAgain,
}: {
  api: Api;
  authOptions: AuthOptions;
  onSignInAgain: () => Promise<void>;
}) {
  const [persona, setPersona] = useState<Record<string, any> | null>(null);
  const [heartbeat, setHeartbeat] = useState<HeartbeatStatus | null>(null);
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
        setHeartbeat(data.heartbeat ?? null);
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
      const result = await api("/api/agent/persona", {
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
      const status = result?.heartbeat
        ? result
        : await api("/api/agent/persona");
      setHeartbeat(status.heartbeat ?? null);
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
            Heartbeat
            <select
              aria-describedby="heartbeat-description"
              value={persona.wake_interval_minutes ?? ""}
              onChange={(event) =>
                update(
                  "wake_interval_minutes",
                  Number(event.target.value) || null,
                )
              }
            >
              <option value="">Off</option>
              {[10, 15, 20, 30, 45, 60, 120, 240, 720, 1440].map((value) => (
                <option key={value} value={value}>
                  {value < 60
                    ? `Every ${value} minutes`
                    : `Every ${value / 60} ${value === 60 ? "hour" : "hours"}`}
                </option>
              ))}
            </select>
          </label>
          <p className="muted" id="heartbeat-description">
            Checks workspace events and connected Gmail, then stays quiet when
            nothing needs your attention. Important updates appear in your Inbox
            and linked messaging apps.
          </p>
          {heartbeat && <HeartbeatSchedule heartbeat={heartbeat} />}
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
      {authOptions.enabled && (
        <AccountSecurity
          accessRecovery={authOptions.accessRecovery}
          onSignInAgain={onSignInAgain}
        />
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

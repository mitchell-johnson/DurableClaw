import { Suspense, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import "./styles.css";

function getOrCreateSessionId(): string {
  const hash = window.location.hash.slice(1);
  if (hash) return hash;

  const stored = localStorage.getItem("durableclaw-session");
  if (stored) {
    window.location.hash = stored;
    return stored;
  }

  const id = crypto.randomUUID().slice(0, 8);
  localStorage.setItem("durableclaw-session", id);
  window.location.hash = id;
  return id;
}

function isToolPart(
  part: UIMessage["parts"][number]
): part is UIMessage["parts"][number] & {
  type: string;
  toolName: string;
  toolCallId: string;
  state: string;
  input: unknown;
  output?: unknown;
} {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

function renderCodeBlocks(text: string) {
  const segments: Array<{ type: "text" | "code"; content: string }> = [];
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "code", content: match[2] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }

  return segments.map((segment, i) => {
    if (segment.type === "code") {
      return (
        <pre key={i} style={styles.codeBlock}>
          <code>{segment.content}</code>
        </pre>
      );
    }
    return <span key={i}>{segment.content}</span>;
  });
}

function ToolCallDisplay({ part }: { part: {
  toolName: string;
  toolCallId: string;
  state: string;
  input: unknown;
  output?: unknown;
  errorText?: string;
} }) {
  const stateLabel =
    part.state === "input-streaming"
      ? "streaming..."
      : part.state === "input-available"
        ? "calling..."
        : part.state === "output-available"
          ? "done"
          : part.state === "output-error"
            ? "error"
            : part.state;

  const stateColor =
    part.state === "output-available"
      ? "#4ade80"
      : part.state === "output-error"
        ? "#f87171"
        : "#facc15";

  return (
    <div style={styles.toolCall}>
      <div style={styles.toolCallHeader}>
        <span style={{ color: "#a78bfa", fontFamily: "monospace" }}>
          {part.toolName}
        </span>
        <span style={{ color: stateColor, fontSize: "0.75rem", marginLeft: "8px" }}>
          {stateLabel}
        </span>
      </div>
      {part.state === "output-available" && part.output != null && (
        <pre style={styles.toolOutput}>
          {typeof part.output === "string"
            ? part.output
            : JSON.stringify(part.output, null, 2)}
        </pre>
      )}
      {part.state === "output-error" && part.errorText && (
        <pre style={{ ...styles.toolOutput, color: "#f87171" }}>
          {part.errorText}
        </pre>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";

  return (
    <div style={{ ...styles.messageRow, justifyContent: isUser ? "flex-end" : "flex-start" }}>
      <div style={isUser ? styles.userBubble : styles.assistantBubble}>
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return <div key={i} style={styles.textContent}>{renderCodeBlocks(part.text)}</div>;
          }
          if (isToolPart(part)) {
            return <ToolCallDisplay key={i} part={part} />;
          }
          return null;
        })}
      </div>
    </div>
  );
}

function ConnectionIndicator({ readyState }: { readyState: number }) {
  const labels: Record<number, { label: string; color: string }> = {
    0: { label: "Connecting", color: "#facc15" },
    1: { label: "Connected", color: "#4ade80" },
    2: { label: "Closing", color: "#facc15" },
    3: { label: "Disconnected", color: "#f87171" },
  };
  const state = labels[readyState] ?? { label: "Unknown", color: "#6b7280" };

  return (
    <div style={styles.connectionStatus}>
      <div style={{ ...styles.connectionDot, backgroundColor: state.color }} />
      <span style={{ fontSize: "0.7rem", color: "#6b7280" }}>{state.label}</span>
    </div>
  );
}

function ChatInner() {
  const [agentName] = useState(getOrCreateSessionId);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [inputValue, setInputValue] = useState("");

  const agent = useAgent({
    agent: "nano-chat-agent",
    name: agentName,
  });

  const { messages, sendMessage, status } = useAgentChat({
    agent,
  });

  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = (e?: { preventDefault?: () => void }) => {
    e?.preventDefault?.();
    const trimmed = inputValue.trim();
    if (!trimmed || isStreaming) return;
    sendMessage({ text: trimmed });
    setInputValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <h1 style={styles.title}>DurableClaw</h1>
          <span style={styles.sessionId}>#{agentName}</span>
        </div>
        <ConnectionIndicator readyState={agent.readyState} />
      </header>

      <div style={styles.messagesContainer}>
        {messages.length === 0 && (
          <div style={styles.emptyState}>
            <p style={{ fontSize: "1.1rem", color: "#6b7280" }}>Start a conversation</p>
          </div>
        )}
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} style={styles.inputArea}>
        <div style={styles.inputWrapper}>
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            style={styles.textarea}
            disabled={agent.readyState !== 1}
          />
          <button
            type="submit"
            disabled={!inputValue.trim() || isStreaming || agent.readyState !== 1}
            style={{
              ...styles.sendButton,
              opacity: !inputValue.trim() || isStreaming ? 0.4 : 1,
            }}
          >
            {isStreaming ? "..." : "\u2191"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function App() {
  return (
    <Suspense
      fallback={
        <div style={styles.loading}>
          <p style={{ color: "#6b7280" }}>Loading...</p>
        </div>
      }
    >
      <ChatInner />
    </Suspense>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    maxWidth: "800px",
    margin: "0 auto",
    background: "#0a0a0a",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #1f1f1f",
  },
  headerLeft: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
  },
  title: {
    fontSize: "1rem",
    fontWeight: 600,
    color: "#e5e5e5",
    letterSpacing: "-0.02em",
  },
  sessionId: {
    fontSize: "0.75rem",
    color: "#525252",
    fontFamily: "monospace",
  },
  connectionStatus: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  connectionDot: {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
  },
  messagesContainer: {
    flex: 1,
    overflowY: "auto",
    padding: "16px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  emptyState: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  messageRow: {
    display: "flex",
    width: "100%",
  },
  userBubble: {
    maxWidth: "75%",
    padding: "10px 14px",
    borderRadius: "12px 12px 2px 12px",
    background: "#1e3a5f",
    color: "#e5e5e5",
    fontSize: "0.9rem",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  assistantBubble: {
    maxWidth: "85%",
    padding: "10px 14px",
    borderRadius: "12px 12px 12px 2px",
    background: "#1a1a1a",
    color: "#d4d4d4",
    fontSize: "0.9rem",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  textContent: {
    whiteSpace: "pre-wrap",
  },
  codeBlock: {
    background: "#111111",
    border: "1px solid #2a2a2a",
    borderRadius: "6px",
    padding: "10px 12px",
    margin: "6px 0",
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
    fontSize: "0.82rem",
    overflowX: "auto",
    color: "#a3e635",
    whiteSpace: "pre",
  },
  toolCall: {
    margin: "6px 0",
    padding: "8px 10px",
    background: "#111111",
    border: "1px solid #2a2a2a",
    borderRadius: "6px",
  },
  toolCallHeader: {
    display: "flex",
    alignItems: "center",
    fontSize: "0.82rem",
  },
  toolOutput: {
    marginTop: "6px",
    padding: "6px 8px",
    background: "#0a0a0a",
    borderRadius: "4px",
    fontFamily: "'SF Mono', 'Fira Code', monospace",
    fontSize: "0.78rem",
    color: "#a3a3a3",
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    maxHeight: "200px",
    overflowY: "auto",
  },
  inputArea: {
    padding: "12px 16px",
    borderTop: "1px solid #1f1f1f",
  },
  inputWrapper: {
    display: "flex",
    alignItems: "flex-end",
    gap: "8px",
    background: "#141414",
    border: "1px solid #2a2a2a",
    borderRadius: "10px",
    padding: "8px 12px",
  },
  textarea: {
    flex: 1,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "#e5e5e5",
    fontSize: "0.9rem",
    fontFamily: "inherit",
    resize: "none",
    lineHeight: 1.5,
    maxHeight: "120px",
  },
  sendButton: {
    width: "32px",
    height: "32px",
    borderRadius: "8px",
    border: "none",
    background: "#3b82f6",
    color: "#fff",
    fontSize: "1.1rem",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  loading: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
    background: "#0a0a0a",
  },
};

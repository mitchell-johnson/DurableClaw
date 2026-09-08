/**
 * Conversation history persistence for conversational agent DOs.
 *
 * Extracted from NanoChatAgent (DurableClaw) — the schema and row semantics are
 * exactly DurableClaw's `conversations` / `messages` tables, so DurableClaw adopts this
 * store with zero data migration. Other DOs (WorkflowConversation) call
 * `ensureTables()` to create the same tables in their own SqlStorage.
 *
 * The store does NOT own schema versioning (DurableClaw's `schema_meta` stays in
 * the DO) and does NOT own DurableClaw-specifics (titles, vector_id stamping,
 * summarization cursors) — those callers reach the tables through their own
 * SQL where they need to.
 */
import type { ModelMessage } from "ai";

export interface AgentConversationRow {
  conversation_id: string;
  title: string | null;
  created_at: number;
  last_active_at: number;
  message_count: number;
  summarized_through_message_id: string | null;
}

export interface AgentMessageRow {
  message_id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_name: string | null;
  vector_id: string | null;
  created_at: number;
}

export const DEFAULT_HISTORY_LIMIT = 50;

/**
 * DDL for the two conversation tables. Idempotent. Byte-for-byte the shape
 * DurableClaw's INITIAL_SCHEMA_SQL creates (including `vector_id`, which only
 * DurableClaw writes — harmless elsewhere), so existing DurableClaw DOs match without
 * migration.
 *
 * CHANGING THIS COLUMN SET REQUIRES A MATCHING `schema_meta` MIGRATION IN
 * NanoChatAgent. Every CREATE here is `IF NOT EXISTS`, which is a no-op
 * against the tables an existing DurableClaw DO already created — so a bare edit
 * gives brand-new DOs the column and leaves every existing DO without it,
 * with no error at any point. The divergence only surfaces later, as a
 * `no such column` at runtime for the users who have been around longest.
 * Add the column here AND bump the DO's schema version with an
 * `ALTER TABLE ... ADD COLUMN` migration.
 *
 * This store deliberately does NOT own schema versioning — each consumer
 * owns its own migration path. DurableClaw's is the `schema_meta` table read and
 * written by `NanoChatAgent.ensureSchema`. A NEW consumer calling
 * `ensureTables()` must establish an equivalent version stamp BEFORE its DOs
 * hold live data: retrofitting a stamp onto populated storage cannot tell a
 * DO that was migrated apart from one that merely ran this DDL, and getting
 * that wrong in either direction corrupts the migration decision for every
 * DO already in the field.
 */
export const CONVERSATION_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  title TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  summarized_through_message_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversations_last_active ON conversations(last_active_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  vector_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
`;

export class ConversationHistoryStore {
  constructor(private sql: SqlStorage) {}

  ensureTables(): void {
    this.sql.exec(CONVERSATION_TABLES_SQL);
  }

  getConversationRow(conversationId: string): AgentConversationRow | null {
    const cursor = this.sql.exec(
      "SELECT * FROM conversations WHERE conversation_id = ? LIMIT 1",
      conversationId,
    );
    const rows = cursor.toArray() as unknown as AgentConversationRow[];
    return rows.length > 0 ? rows[0] : null;
  }

  ensureConversationRow(conversationId: string): AgentConversationRow {
    const existing = this.getConversationRow(conversationId);
    if (existing) {
      const now = Date.now();
      this.sql.exec(
        "UPDATE conversations SET last_active_at = ? WHERE conversation_id = ?",
        now,
        conversationId,
      );
      return { ...existing, last_active_at: now };
    }
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO conversations (conversation_id, title, created_at, last_active_at, message_count)
       VALUES (?, NULL, ?, ?, 0)`,
      conversationId,
      now,
      now,
    );
    return {
      conversation_id: conversationId,
      title: null,
      created_at: now,
      last_active_at: now,
      message_count: 0,
      summarized_through_message_id: null,
    };
  }

  /**
   * Append a message row and bump conversation counters.
   *
   * `content` is TEXT — for tool rows it holds the JSON-encoded tool output,
   * for assistant rows the visible text part. `toolCallId` / `toolName` carry
   * the AI SDK contract fields on tool-result rows.
   */
  appendMessage(args: {
    messageId?: string;
    conversationId: string;
    role: "user" | "assistant" | "tool";
    content: string;
    toolCalls?: unknown;
    toolCallId?: string | null;
    toolName?: string | null;
  }): string {
    const messageId = args.messageId ?? crypto.randomUUID();
    if (args.messageId) {
      const existing = this.sql
        .exec(
          "SELECT conversation_id FROM messages WHERE message_id = ?",
          messageId,
        )
        .toArray()[0];
      if (existing) {
        if (existing.conversation_id !== args.conversationId)
          throw new Error("Message belongs to another conversation");
        return messageId;
      }
    }
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO messages (message_id, conversation_id, role, content, tool_calls, tool_call_id, tool_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      messageId,
      args.conversationId,
      args.role,
      args.content,
      args.toolCalls ? JSON.stringify(args.toolCalls) : null,
      args.toolCallId ?? null,
      args.toolName ?? null,
      now,
    );
    this.sql.exec(
      `UPDATE conversations SET message_count = message_count + 1, last_active_at = ? WHERE conversation_id = ?`,
      now,
      args.conversationId,
    );
    return messageId;
  }

  /**
   * Load the most recent N message rows (raw form) in chronological order.
   * Callers that need the raw columns (tool_call_id, tool_name, tool_calls
   * JSON) — history replay in particular — use this rather than
   * `loadRecentMessages`.
   */
  loadRecentMessageRows(
    conversationId: string,
    limit = DEFAULT_HISTORY_LIMIT,
  ): AgentMessageRow[] {
    const cursor = this.sql.exec(
      `SELECT * FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
      conversationId,
      limit,
    );
    return (cursor.toArray() as unknown as AgentMessageRow[]).reverse();
  }

  /**
   * Load the most recent N messages in chronological order, as a prompt the
   * provider will accept.
   *
   * The window is a fixed-size tail, so it can open in the MIDDLE of a turn —
   * a `tool` row whose assistant tool-call was one row too far back, or an
   * assistant row whose tool-calls were answered outside the window. Providers
   * reject both: every tool result must follow the assistant message that
   * requested it, and every tool call must be answered. A conversation long
   * enough to fill the window would start failing on that alone.
   *
   * The repair happens AFTER slicing, and only here. `loadRecentMessageRows`
   * stays byte-identical because replay is a different contract: the client
   * anchors `history_tool_result` widgets by message index, so dropping rows
   * there would silently misalign them.
   */
  loadRecentMessages(
    conversationId: string,
    limit = DEFAULT_HISTORY_LIMIT,
  ): ModelMessage[] {
    const rows = this.loadRecentMessageRows(conversationId, limit);

    let start = 0;
    // 1. Leading `tool` rows are orphans: whatever called them is behind the
    //    window.
    while (start < rows.length && rows[start].role === "tool") start++;

    // 2. A leading assistant row carrying tool-calls whose results are NOT in
    //    the window is the mirror case — the provider sees a request that is
    //    never answered. Only the FIRST turn can be split this way, so one
    //    pass is enough.
    if (start < rows.length) {
      const head = rows[start];
      if (head.role === "assistant" && head.tool_calls) {
        let callIds: string[] = [];
        try {
          const parsed = JSON.parse(head.tool_calls);
          if (Array.isArray(parsed)) {
            callIds = parsed
              .map((p: any) => p?.toolCallId ?? p?.id)
              .filter(
                (id: unknown): id is string =>
                  typeof id === "string" && id.length > 0,
              );
          }
        } catch {
          // Malformed tool_calls JSON: rowToModelMessage degrades this row to
          // a plain assistant turn, which is always valid — leave it in.
          callIds = [];
        }
        if (callIds.length > 0) {
          const answered = new Set(
            rows
              .slice(start + 1)
              .filter((r) => r.role === "tool" && r.tool_call_id)
              .map((r) => r.tool_call_id as string),
          );
          if (!callIds.every((id) => answered.has(id))) {
            start++;
            // Its results, if any survived, are now orphans themselves.
            while (start < rows.length && rows[start].role === "tool") start++;
          }
        }
      }
    }

    // 3. The repair must never hand back an EMPTY prompt for a conversation
    //    that has messages — a turn with no messages at all is a different
    //    (and worse) provider error than the one we just avoided. Fall back to
    //    the last `user` row: it is always a valid opening message and it
    //    carries the live request, which is the one thing the turn cannot do
    //    without. With no user row anywhere in the window there is nothing
    //    salvageable, and empty is the honest answer.
    //
    //    Defensive rather than hot: the walk above stops at the first `user`
    //    row, so today it can only empty a window that held none. A future
    //    rule that drops more aggressively would land here instead of
    //    silently sending nothing.
    if (start >= rows.length && rows.length > 0) {
      const lastUser = rows.map((r) => r.role).lastIndexOf("user");
      if (lastUser === -1) return [];
      start = lastUser;
    }

    return rows.slice(start).map((r) => this.rowToModelMessage(r));
  }

  /**
   * Materialize a stored message row back into the AI SDK `ModelMessage`
   * shape so multi-step tool-call history round-trips correctly.
   *
   * - Assistant rows with `tool_calls` set: emit `{role:'assistant', content: [text?, ...tool-call parts]}`.
   * - Tool rows: emit `{role:'tool', content: [{type:'tool-result', toolCallId, toolName, output}]}`.
   *   `output` is parsed from the JSON-encoded `content` column; if parsing
   *   fails the raw string is used as a fallback so the model still sees
   *   something meaningful.
   * - User / plain assistant rows: existing `{role, content}` string shape.
   */
  rowToModelMessage(row: AgentMessageRow): ModelMessage {
    if (row.role === "tool") {
      let output: unknown = row.content;
      if (row.content) {
        try {
          output = JSON.parse(row.content);
        } catch {
          // Round-tripping a non-JSON tool output (rare, but possible if the
          // tool returned a bare string). Keep the raw text in that case.
          output = row.content;
        }
      }
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: row.tool_call_id ?? "",
            toolName: row.tool_name ?? "",
            output,
          },
        ],
      } as unknown as ModelMessage;
    }

    if (row.role === "assistant" && row.tool_calls) {
      let parsed: any[] = [];
      try {
        const decoded = JSON.parse(row.tool_calls);
        if (Array.isArray(decoded)) parsed = decoded;
      } catch {
        // Malformed tool_calls JSON: fall back to the plain-string shape
        // below so the assistant turn still appears in history.
        parsed = [];
      }
      const parts: any[] = [];
      if (row.content) {
        parts.push({ type: "text", text: row.content });
      }
      for (const p of parsed) {
        // Persisted shape is whatever streamText handed us — accept both
        // the AI SDK v5 `tool-call` shape and the older `tool_use` alias.
        if (p && (p.type === "tool-call" || p.type === "tool_use")) {
          parts.push({
            type: "tool-call",
            toolCallId: p.toolCallId ?? p.id ?? "",
            toolName: p.toolName ?? p.name ?? "",
            // AI SDK v6 renamed the tool-call payload field `args` → `input`.
            // Read either persisted shape but always emit `input`, or
            // standardizePrompt rejects the whole ModelMessage[] at the next turn.
            input: p.args ?? p.input ?? {},
            // Signed provider metadata must survive hibernation and history replay.
            ...(p.providerOptions
              ? { providerOptions: p.providerOptions }
              : {}),
          });
        }
      }
      // If no parts at all (no text, no tool-calls), fall back to a plain
      // empty-text assistant turn so the model doesn't see a stray empty
      // array (which some providers reject).
      const content = parts.length > 0 ? parts : row.content;
      return { role: "assistant", content } as unknown as ModelMessage;
    }

    return {
      role: row.role as "user" | "assistant" | "tool",
      content: row.content,
    } as ModelMessage;
  }

  /**
   * Persist a completed turn's provider messages (assistant text, tool-call
   * parts, per-tool result rows). Falls back to a single assistant row when
   * the provider returned no messages but the turn produced text (e.g. a
   * canned fallback). Ported from NanoChatAgent.handleUserMessage's
   * persistence block. Returns the final assistant row's immutable ID so
   * detached post-turn work can refer to its source even after later turns.
   */
  appendTurnMessages(
    conversationId: string,
    responseMessages: ModelMessage[],
    fullText: string,
  ): string | null {
    let assistantMessageId: string | null = null;
    let hasAssistantText = false;
    if (responseMessages && responseMessages.length > 0) {
      for (const msg of responseMessages) {
        const text =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? (msg.content as any[])
                  .filter((p: any) => p.type === "text")
                  .map((p: any) => p.text)
                  .join("")
              : "";
        if (msg.role === "assistant") {
          hasAssistantText ||= text.length > 0;
          assistantMessageId = this.appendMessage({
            conversationId,
            role: "assistant",
            content: text,
            toolCalls: Array.isArray(msg.content)
              ? (msg.content as any[]).filter(
                  (p: any) => p.type === "tool-call" || p.type === "tool_use",
                )
              : undefined,
          });
        } else if (msg.role === "tool") {
          // Tool turns from the AI SDK are arrays of tool-result parts.
          // Persist each tool-result as its own row so history replay can
          // emit a per-tool `history_tool_result` event.
          if (Array.isArray(msg.content)) {
            for (const part of msg.content as any[]) {
              if (
                !part ||
                (part.type !== "tool-result" && part.type !== "tool_result")
              )
                continue;
              const rawOutput = part.output ?? part.result ?? "";
              const contentStr =
                typeof rawOutput === "string"
                  ? rawOutput
                  : JSON.stringify(rawOutput);
              this.appendMessage({
                conversationId,
                role: "tool",
                content: contentStr,
                toolCallId: part.toolCallId ?? part.tool_call_id ?? null,
                toolName: part.toolName ?? part.tool_name ?? null,
              });
            }
          } else if (text) {
            // Fallback: a tool turn with a flat string body. Persist as a
            // single tool row without ids — replay will treat it as a
            // best-effort orphan.
            this.appendMessage({ conversationId, role: "tool", content: text });
          }
        }
      }
    }
    // A tool-only response still has provider messages. Its visible fallback
    // needs its own durable bubble so replay can also anchor the tool results.
    if (fullText && !hasAssistantText) {
      assistantMessageId = this.appendMessage({
        conversationId,
        role: "assistant",
        content: fullText,
      });
    }
    return assistantMessageId;
  }
}

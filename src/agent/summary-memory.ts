import type { UIMessage } from "ai";

export const RECENT_CHAT_CONTEXT_MESSAGES = 40;
export const SUMMARY_CONTEXT_LIMIT = 4;
export const SUMMARY_MAINTENANCE_INTERVAL_SECONDS = 900;
export const SUMMARY_MAX_BATCHES_PER_RUN = 2;
export const SUMMARY_MAX_MESSAGES = 24;
export const SUMMARY_MIN_MESSAGES = 8;
export const SUMMARY_RETAIN_RECENT_MESSAGES = 24;
export const SUMMARY_SCHEDULE_META_KEY = "summary_maintenance_schedule_id";
const MAX_ARCHIVED_CONTENT_CHARS = 4000;

export interface ArchivedConversationMessage {
  sequence: number;
  messageId: string;
  role: string;
  content: string;
  createdAt: number;
}

export interface ConversationSummary {
  id: string;
  startSequence: number;
  endSequence: number;
  messageCount: number;
  summary: string;
  createdAt: number;
}

export interface SummarySelectionOptions {
  lastSummarizedSequence: number;
  retainRecentMessages: number;
  minMessages: number;
  maxMessages: number;
}

type ToolLikePart = UIMessage["parts"][number] & {
  toolName?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

interface ArchivedConversationMessageRow extends Record<
  string,
  SqlStorageValue
> {
  sequence: number;
  message_id: string;
  role: string;
  content: string;
  created_at: number;
}

interface ConversationSummaryRow extends Record<string, SqlStorageValue> {
  id: string;
  start_sequence: number;
  end_sequence: number;
  message_count: number;
  summary: string;
  created_at: number;
}

interface SummaryMetaRow extends Record<string, SqlStorageValue> {
  value: string;
}

export function extractMessageContent(message: UIMessage): string {
  const segments: string[] = [];

  for (const part of message.parts) {
    if (part.type === "text") {
      const text = part.text.trim();
      if (text) {
        segments.push(text);
      }
      continue;
    }

    if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      const toolPart = part as ToolLikePart;
      const toolName = toolPart.toolName ?? toolPart.type.replace(/^tool-/, "");
      const details = [`Tool ${toolName}`];

      if (toolPart.state) {
        details.push(`state=${toolPart.state}`);
      }
      if (toolPart.input !== undefined) {
        details.push(`input=${safeSerialize(toolPart.input)}`);
      }
      if (toolPart.output !== undefined) {
        details.push(`output=${safeSerialize(toolPart.output)}`);
      }
      if (toolPart.errorText) {
        details.push(`error=${toolPart.errorText}`);
      }

      segments.push(details.join(" "));
    }
  }

  return clampArchivedContent(segments.join("\n").trim());
}

export function selectMessagesForSummary(
  messages: ArchivedConversationMessage[],
  options: SummarySelectionOptions,
): ArchivedConversationMessage[] {
  const ordered = [...messages].sort((a, b) => a.sequence - b.sequence);
  const unsummarized = ordered.filter(
    (message) => message.sequence > options.lastSummarizedSequence,
  );

  if (unsummarized.length <= options.retainRecentMessages) {
    return [];
  }

  const eligibleCount = unsummarized.length - options.retainRecentMessages;
  const eligible = unsummarized.slice(0, eligibleCount);
  const selected = eligible.slice(0, options.maxMessages);

  if (selected.length < options.minMessages) {
    return [];
  }

  return selected;
}

export function buildSummaryContext(
  summaries: ConversationSummary[],
  limit = 5,
): string {
  const selected = [...summaries]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);

  if (selected.length === 0) {
    return "";
  }

  return [
    "<conversation_summaries>",
    "The following summaries capture older conversation context that has been condensed for long-term memory:",
    ...selected.map(
      (summary) =>
        `- Messages ${summary.startSequence}-${summary.endSequence} (${summary.messageCount} messages): ${summary.summary}`,
    ),
    "</conversation_summaries>",
  ].join("\n");
}

export function formatMessagesForSummary(
  messages: ArchivedConversationMessage[],
): string {
  return [...messages]
    .sort((a, b) => a.sequence - b.sequence)
    .map(
      (message) => `[${message.sequence}] ${message.role}: ${message.content}`,
    )
    .join("\n");
}

export class SummaryMemoryStore {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  syncMessages(messages: UIMessage[]): void {
    const now = Date.now();

    for (const message of messages) {
      const content = extractMessageContent(message);
      if (!content) {
        continue;
      }

      this.sql.exec(
        "INSERT OR IGNORE INTO archived_messages (message_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        message.id,
        message.role,
        content,
        now,
      );
    }
  }

  getMessagesForSummary(
    options: SummarySelectionOptions,
  ): ArchivedConversationMessage[] {
    const rows = this.sql
      .exec<ArchivedConversationMessageRow>(
        "SELECT sequence, message_id, role, content, created_at FROM archived_messages ORDER BY sequence ASC",
      )
      .toArray();

    return selectMessagesForSummary(
      rows.map((row) => ({
        sequence: row.sequence,
        messageId: row.message_id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
      })),
      {
        ...options,
        lastSummarizedSequence: this.getLatestSummaryEndSequence(),
      },
    );
  }

  storeSummary(summary: string, messages: ArchivedConversationMessage[]): void {
    if (messages.length === 0) {
      return;
    }

    const ordered = [...messages].sort((a, b) => a.sequence - b.sequence);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];

    this.sql.exec(
      `INSERT INTO conversation_summaries
        (id, start_sequence, end_sequence, message_count, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      first.sequence,
      last.sequence,
      ordered.length,
      summary,
      Date.now(),
    );
  }

  getSummaryContext(limit = SUMMARY_CONTEXT_LIMIT): string {
    return buildSummaryContext(this.listSummaries(limit), limit);
  }

  getMeta(key: string): string | null {
    const rows = this.sql
      .exec<SummaryMetaRow>("SELECT value FROM memory_meta WHERE key = ?", key)
      .toArray();

    if (rows.length === 0) {
      return null;
    }

    return rows[0].value;
  }

  setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO memory_meta (key, value, updated_at) VALUES (?, ?, ?)",
      key,
      value,
      Date.now(),
    );
  }

  private getLatestSummaryEndSequence(): number {
    const rows = this.sql
      .exec<{ end_sequence: number } & Record<string, SqlStorageValue>>(
        "SELECT COALESCE(MAX(end_sequence), 0) AS end_sequence FROM conversation_summaries",
      )
      .toArray();

    return rows[0]?.end_sequence ?? 0;
  }

  private listSummaries(limit: number): ConversationSummary[] {
    const rows = this.sql
      .exec<ConversationSummaryRow>(
        `SELECT id, start_sequence, end_sequence, message_count, summary, created_at
         FROM conversation_summaries
         ORDER BY end_sequence DESC
         LIMIT ?`,
        limit,
      )
      .toArray();

    return rows.map((row) => ({
      id: row.id,
      startSequence: row.start_sequence,
      endSequence: row.end_sequence,
      messageCount: row.message_count,
      summary: row.summary,
      createdAt: row.created_at,
    }));
  }
}

function safeSerialize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clampArchivedContent(content: string): string {
  if (content.length <= MAX_ARCHIVED_CONTENT_CHARS) {
    return content;
  }

  return `${content.slice(0, MAX_ARCHIVED_CONTENT_CHARS - 14)}[truncated]`;
}

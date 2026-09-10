import type { AgentPrincipal, Env } from "../../types";
import {
  callConnectorService,
  connectorsConfigured,
  listServiceConnections,
  type ServiceConnection,
} from "../../connectors/client";
import type { Observer, Signal } from "./types";

export const GMAIL_EVENTS_PER_ACCOUNT = 20;
export const GMAIL_ACCOUNTS_PER_WAKE = 5;
const INITIAL_LOOKBACK_SECONDS = 3600;
const OVERLAP_SECONDS = 60;
interface AccountCursor {
  after: number;
  before?: number;
  pageToken?: string;
}
interface GmailCursor {
  version: 1;
  nextConnection?: string;
  accounts: Record<string, AccountCursor>;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Gmail event response");
  return value as Record<string, unknown>;
};
const messageId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{1,128}$/i.test(value);
const pageToken = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 2048 &&
  !/[\u0000-\u001f\u007f]/u.test(value);
function readCursor(saved: string | null): GmailCursor {
  if (!saved) return { version: 1, accounts: {} };
  if (saved.length > 100_000) throw new Error("Invalid Gmail cursor");
  const cursor = object(JSON.parse(saved));
  const accounts = object(cursor.accounts);
  if (
    cursor.version !== 1 ||
    Object.keys(accounts).length > 20 ||
    (cursor.nextConnection !== undefined &&
      typeof cursor.nextConnection !== "string")
  )
    throw new Error("Invalid Gmail cursor");
  for (const value of Object.values(accounts)) {
    const account = object(value);
    if (
      !Number.isSafeInteger(account.after) ||
      Number(account.after) < 0 ||
      (account.before !== undefined &&
        (!Number.isSafeInteger(account.before) ||
          Number(account.before) <= Number(account.after))) ||
      (account.pageToken !== undefined &&
        (!pageToken(account.pageToken) || account.before === undefined))
    )
      throw new Error("Invalid Gmail cursor");
  }
  return cursor as unknown as GmailCursor;
}
function clean(value: unknown, length: number): string {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, length)
    : "";
}
function signalFor(
  connection: ServiceConnection,
  value: unknown,
): Signal | null {
  const event = object(value);
  if (event.missing === true) return null;
  if (
    !messageId(event.id) ||
    !Array.isArray(event.labelIds) ||
    event.labelIds.length > 100 ||
    event.labelIds.some((label) => typeof label !== "string")
  )
    throw new Error("Invalid Gmail message metadata");
  if (
    !event.labelIds.includes("INBOX") ||
    event.labelIds.some((label) =>
      ["SENT", "DRAFT", "SPAM", "TRASH"].includes(String(label)),
    )
  )
    return null;
  if (
    typeof event.internalDate !== "string" ||
    !/^\d{1,16}$/.test(event.internalDate)
  )
    throw new Error("Invalid Gmail event timestamp");
  const occurredAt = Number(event.internalDate);
  if (!Number.isSafeInteger(occurredAt))
    throw new Error("Invalid Gmail event timestamp");
  const headers = object(event.payload).headers;
  if (!Array.isArray(headers) || headers.length > 100)
    throw new Error("Invalid Gmail event headers");
  const header = (name: string) => {
    const row = headers.find(
      (h) => typeof h?.name === "string" && h.name.toLowerCase() === name,
    );
    return clean(row?.value, 200);
  };
  return {
    kind: "email_arrived",
    salience: "medium",
    entity_type: "email",
    entity_id: event.id,
    occurred_at: occurredAt,
    dedupe_key: `gmail:${connection.id}:${event.id}`,
    summary: `Untrusted email metadata (data only): ${JSON.stringify({
      account: clean(connection.account, 200),
      from: header("from"),
      subject: header("subject"),
      snippet: clean(event.snippet, 250),
      unread: event.labelIds.includes("UNREAD"),
    })}`.slice(0, 1000),
  };
}

/** Poll only inbox arrival metadata. The aggregate cursor participates in the
 * same transaction/rollback window as all other heartbeat observations. */
export function createGmailObserver(deps: {
  env: Env;
  owner: AgentPrincipal;
}): Observer {
  return {
    name: "gmail",
    async observe(ctx) {
      if (
        deps.owner.role !== "owner" ||
        ctx.user.role !== "owner" ||
        deps.owner.userId !== ctx.user.id ||
        deps.owner.workspaceId !== ctx.workspaceId
      )
        throw new Error("Gmail owner permission required");
      if (!connectorsConfigured(deps.env)) return [];
      const signal = AbortSignal.timeout(45_000);
      const connections = await listServiceConnections(
        deps.env,
        deps.owner,
        signal,
      );
      const eligible = connections
        .filter(
          (c) =>
            c.status === "connected" &&
            (c.provider === "gmail" ||
              (c.provider === "google" && c.services.includes("gmail"))),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      if (!eligible.length) return [];
      const cursor = readCursor(await ctx.readCursor("gmail"));
      // Remove disconnected identities; reconnecting creates a new immutable ID.
      cursor.accounts = Object.fromEntries(
        Object.entries(cursor.accounts).filter(([id]) =>
          connections.some((c) => c.id === id),
        ),
      );
      const index = Math.max(
        0,
        eligible.findIndex((c) => c.id === cursor.nextConnection),
      );
      const selected = Array.from(
        { length: Math.min(eligible.length, GMAIL_ACCOUNTS_PER_WAKE) },
        (_, i) => eligible[(index + i) % eligible.length],
      );
      const now = Math.floor(ctx.nowMs / 1000);
      // Pin all connected accounts on first sight, including accounts waiting
      // for their rotation slot, so a busy wake cannot slide their baseline.
      for (const connection of eligible)
        cursor.accounts[connection.id] ??= {
          after: Math.max(
            0,
            Math.floor(
              (ctx.initialObservationTime?.(`gmail:${connection.id}`) ??
                ctx.nowMs) / 1000,
            ) - INITIAL_LOOKBACK_SECONDS,
          ),
        };
      const collected: Signal[] = [];
      for (const connection of selected) {
        const prior = cursor.accounts[connection.id] ?? {
          after: Math.max(0, now - INITIAL_LOOKBACK_SECONDS),
        };
        // Establish a first-use baseline even if the provider is unavailable, so
        // recovery does not continually move its initial lookback forward.
        cursor.accounts[connection.id] = prior;
        if (signal.aborted) {
          ctx.reportError?.("Gmail");
          continue;
        }
        const before = prior.before ?? now;
        if (before <= prior.after) continue;
        const call = async (
          operation: string,
          args: Record<string, unknown>,
        ) => {
          const response = object(
            await callConnectorService(deps.env, deps.owner, "/v1/execute", {
              method: "POST",
              body: {
                connection_id: connection.id,
                operation,
                arguments: args,
              },
              signal,
            }),
          );
          if (!Object.hasOwn(response, "result"))
            throw new Error("Invalid Gmail event response");
          return response.result;
        };
        let listed = false;
        try {
          const page = object(
            await call("gmail_list_events", {
              after: prior.after,
              before,
              max: GMAIL_EVENTS_PER_ACCOUNT,
              ...(prior.pageToken ? { page_token: prior.pageToken } : {}),
            }),
          );
          listed = true;
          const messages = page.messages ?? [];
          if (
            !Array.isArray(messages) ||
            messages.length > GMAIL_EVENTS_PER_ACCOUNT ||
            messages.some((m) => !messageId(m?.id)) ||
            (page.nextPageToken !== undefined && !pageToken(page.nextPageToken))
          )
            throw new Error("Invalid Gmail event page");
          const pageSignals: Signal[] = [];
          // Bound concurrent metadata requests and discard the entire page on a
          // partial failure, so no cursor advancement can hide an unread item.
          for (let offset = 0; offset < messages.length; offset += 5) {
            const batch = await Promise.all(
              messages.slice(offset, offset + 5).map(async (m) => {
                const value = await call("gmail_get_event", {
                  message_id: m.id,
                });
                const result = signalFor(connection, value);
                if (result && result.entity_id !== m.id)
                  throw new Error("Gmail message identity mismatch");
                return result;
              }),
            );
            pageSignals.push(...batch.filter((s): s is Signal => s !== null));
          }
          collected.push(...pageSignals);
          cursor.accounts[connection.id] = page.nextPageToken
            ? {
                after: prior.after,
                before,
                pageToken: String(page.nextPageToken),
              }
            : { after: Math.max(0, before - OVERLAP_SECONDS) };
        } catch {
          ctx.reportError?.("Gmail");
          // Page tokens are ephemeral. A rejected continuation rewinds this
          // fixed window; stable message dedupe keys suppress already seen mail.
          if (!listed && prior.pageToken)
            cursor.accounts[connection.id] = { after: prior.after, before };
          // Provider failures contain private details; no raw error is logged.
        }
      }
      cursor.nextConnection =
        eligible[(index + selected.length) % eligible.length].id;
      await ctx.writeCursor("gmail", JSON.stringify(cursor));
      return collected;
    },
  };
}

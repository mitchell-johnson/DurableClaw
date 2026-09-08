/**
 * Server-side tool-confirmation contract (server authorization).
 *
 * Two-phase confirm tools no longer accept a model-authored `confirm` boolean.
 * The preview phase returns a SERVER-ISSUED `confirmation_id`; execution is
 * only possible when the owning Durable Object's storage holds a matching,
 * unexpired, unconsumed record for that id — and (Stage B) one whose status
 * has been flipped to `approved` by the session-bound HTTP decision endpoint,
 * the only transport that can approve.
 *
 * This module defines the narrow interface the generic tool layer needs plus
 * the canonical argument hashing every phase agrees on. The SQLite
 * implementation lives with the owning DO (`durable-objects/assistant/
 * toolConfirmations.ts`) so the action-library import graph stays one-way.
 */

/** Canonical JSON: recursively key-sorted, so arg order never changes a hash. */
export function canonicalJsonString(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonString).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonString(v)}`).join(",")}}`;
}

/**
 * sha256 over the canonical JSON of the tool input MINUS `confirmation_id`.
 * Two calls agree only when they carry the same arguments in substance, not
 * just in key order — a model cannot retarget an approved confirmation to
 * different arguments by reusing its id.
 */
export async function computeArgsHash(
  input: Record<string, unknown>,
  confirmationScope?: string,
): Promise<string> {
  const { confirmation_id: _omitted, ...rest } = input;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      canonicalJsonString(
        confirmationScope === undefined ? rest : [confirmationScope, rest],
      ),
    ),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface ConfirmationIssueArgs {
  conversationId: string;
  toolName: string;
  argsHash: string;
}

export interface ConfirmationVerifyArgs extends ConfirmationIssueArgs {
  confirmationId: string;
}

/**
 * The store the owning DO binds into confirm tools at ToolSet build time.
 *
 * Every method fails closed: an unknown id, a hash/tool/conversation mismatch,
 * an expired record, or a missing approval all read as "not executable" and
 * the caller re-runs the preview phase instead of executing.
 */
export interface ToolConfirmationCoordinator {
  /** Mint a pending record; returns its server-generated UUIDv4 id. */
  issue(args: ConfirmationIssueArgs): Promise<string>;
  /**
   * True ONLY when the stored record matches id + conversation + tool +
   * args hash, is unexpired, unconsumed AND approved. Does not consume.
   */
  isExecutable(args: ConfirmationVerifyArgs): Promise<boolean>;
  /**
   * Atomically mark a verified record consumed. Returns false when another
   * execution already won the race or the record is not in an executable
   * state — the caller must NOT execute on false.
   */
  consume(confirmationId: string): Promise<boolean>;
}

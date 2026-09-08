/**
 * Shared helpers for AssistantAgent tools.
 *
 * - `defineTool` wraps the AI SDK jsonSchema/tool shape with a typed execute fn.
 * - `defineConfirmTool` adds two-phase confirmation (preview + confirm).
 * - `entityDispatch` builds a type-safe entity-type → request shape table.
 * - `formatRecordList` builds the standard `record_list` widget envelope.
 * - `formatResponse` is the existing error-and-truncate formatter, lifted from
 *   the original tools.ts so the helper is the single source of truth.
 * - `sanitizeToolOutput` strips common prompt-injection markers from tool result
 *   text before it enters model context (advisory defense-in-depth).
 */

import { jsonSchema } from "ai";
import {
  computeArgsHash,
  type ToolConfirmationCoordinator,
} from "./confirmations";

export type APIClient = {
  callAPI: (method: string, path: string, body?: unknown) => Promise<Response>;
};

/**
 * Common prompt-injection markers found in adversarial payloads embedded in
 * user-uploaded documents, resumes, emails, etc.
 *
 * Advisory defense-in-depth: strips/quotes these before tool-result text
 * enters the model context. This is a server-side pre-pass that complements
 * the system-prompt guidance (which is also advisory, not a hard guarantee).
 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\[INST\]/gi, replacement: "[INST_REMOVED]" },
  { pattern: /<\|im_start\|>/gi, replacement: "[IM_START_REMOVED]" },
  { pattern: /<\|im_end\|>/gi, replacement: "[IM_END_REMOVED]" },
  { pattern: /<\|endoftext\|>/gi, replacement: "[EOT_REMOVED]" },
  {
    pattern: /ignore\s+previous\s+instructions?/gi,
    replacement: "[INJECTION_REMOVED]",
  },
  { pattern: /###\s*system:/gi, replacement: "[SYSTEM_REMOVED]" },
];

/**
 * Strip known prompt-injection markers from tool-result text before it goes
 * into the model context. Returns the sanitized string. Non-string inputs are
 * returned as-is (callers should stringify first).
 *
 * This is advisory defense-in-depth — the system prompt also instructs the
 * model to treat tool results as inert data, but a server-side pre-pass
 * reduces reliance on model-level compliance alone.
 */
export function sanitizeToolOutput(text: string): string {
  let result = text;
  for (const { pattern, replacement } of INJECTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Existing pattern, lifted from old tools.ts. */
export function defineTool<T>(config: {
  description: string;
  properties: Record<string, object>;
  required?: string[];
  execute: (input: T) => Promise<string>;
}) {
  return {
    description: config.description,
    inputSchema: jsonSchema({
      type: "object" as const,
      properties: config.properties,
      required: config.required || [],
      additionalProperties: false,
    }),
    execute: config.execute as (input: unknown) => Promise<string>,
  };
}

/** Options every confirm-tool factory threads into its defineConfirmTool calls. */
export interface ConfirmToolOptions {
  /** Store bound to the owning DO + conversation. Absent = fail closed. */
  confirmations?: ToolConfirmationCoordinator;
  /** Conversation the ToolSet was built for; scopes every record. */
  conversationId?: string;
}

/**
 * Wraps execute with two-phase confirmation (server authorization).
 *
 * The model can no longer satisfy confirmation by emitting a boolean. Phase
 * one returns a preview plus a SERVER-ISSUED `confirmation_id` recorded in
 * the owning DO's storage; execution requires that record to exist, match
 * this tool name AND these exact arguments, be unexpired, unconsumed and —
 * Stage B — approved through the session-bound decision endpoint. Any
 * mismatch re-runs the preview phase; it never executes.
 *
 * `confirm_args` is gone entirely: pre-satisfied arguments must never reach
 * model context again.
 */
export function defineConfirmTool<T extends Record<string, unknown>>(
  /** Registry key this tool is published under; scopes the store record. */
  toolName: string,
  config: {
    description: string;
    properties: Record<string, object>;
    required?: string[];
    buildPreview: (input: T) => string | Promise<string>;
    execute: (input: T) => Promise<string>;
  },
  options?: {
    /** Store bound to the owning DO + conversation. Absent = fail closed. */
    confirmations?: ToolConfirmationCoordinator;
    /** Conversation the ToolSet was built for; scopes every record. */
    conversationId?: string;
  },
) {
  const props = {
    ...config.properties,
    confirmation_id: {
      type: "string",
      description:
        "Server-issued id returned by the previous needs_confirmation result for these same arguments. " +
        "The action runs only after the user approves that id; call once without it to request a fresh one.",
    },
  };
  const required = config.required ?? [];
  const gated = defineTool<T>({
    description: config.description,
    properties: props,
    required,
    execute: async (rawInput) => {
      const input = rawInput as T & { confirmation_id?: unknown };
      const argsHash = await computeArgsHash(input as Record<string, unknown>);
      const coordinator = options?.confirmations;
      const conversationId = options?.conversationId;

      // No store bound (e.g. catalogue introspection outside a conversation):
      // preview only, never executable.
      if (!coordinator || !conversationId) {
        const preview = await config.buildPreview(input);
        return JSON.stringify({
          needs_confirmation: true,
          preview,
          note: "Confirmation is unavailable in this context; this action cannot be executed here.",
        });
      }

      const presentedId =
        typeof input.confirmation_id === "string" ? input.confirmation_id : "";

      if (
        !presentedId ||
        !(await coordinator.isExecutable({
          confirmationId: presentedId,
          conversationId,
          toolName,
          argsHash,
        })) ||
        !(await coordinator.consume(presentedId))
      ) {
        // Fail closed: issue a FRESH pending record so the human approval
        // path stays reachable, but never fall through to execute on a
        // mismatched, expired, unapproved or spent id.
        const issuedId = await coordinator.issue({
          conversationId,
          toolName,
          argsHash,
        });
        const preview = await config.buildPreview(input);
        return JSON.stringify({
          needs_confirmation: true,
          preview,
          confirmation_id: issuedId,
        });
      }

      const { confirmation_id: _verified, ...toolArgs } = input;
      return config.execute(toolArgs as T);
    },
  });
  return {
    ...gated,
    // Explicit direct path for trusted adapters that have their own authorization.
    directExecute: config.execute as (input: unknown) => Promise<string>,
    directInputSchema: jsonSchema({
      type: "object" as const,
      properties: config.properties,
      required: config.required || [],
      additionalProperties: false,
    }),
    buildReviewSummary: config.buildPreview as (
      input: unknown,
    ) => string | Promise<string>,
  };
}

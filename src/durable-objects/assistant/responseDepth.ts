/**
 * Response depth — the per-user reasoning-effort knob on the DurableClaw persona.
 *
 * The settings UI asks a user a question they can actually answer ("do
 * you want quick answers or careful ones?"), so the persona API speaks in
 * `'fast' | 'thorough' | null` rather than in provider effort levels. This
 * module is the ONE place that translation happens: the route validates
 * against `RESPONSE_DEPTHS`, the DO stores the same vocabulary in its
 * `persona.reasoning_effort` column, and `resolveReasoningEffort` maps it to
 * the level the AI SDK understands right before the turn starts.
 *
 * `null` (or anything unrecognised — including the retired `model_preference`
 * values 'flash'/'pro') means "send nothing", so the request body is byte
 * identical to what it was before this knob existed and the provider's own
 * default applies.
 *
 * Level choice:
 *   - fast     → 'low'   — noticeably quicker, still reasons enough to plan a
 *                          tool call. 'none'/'minimal' regularly costs the
 *                          model its multi-step tool planning, which is most
 *                          of what DurableClaw does.
 *   - thorough → 'high'  — deeper reasoning on a turn the user is waiting on.
 *                          'xhigh'/'max' are reserved for background flows
 *                          (`BACKGROUND_REASONING_EFFORT`), where nobody is
 *                          watching a spinner.
 */

import type { ReasoningEffort } from "../../action-library/loop";

/** The values the persona API accepts. `null` = provider default. */
export const RESPONSE_DEPTHS = ["fast", "thorough"] as const;

export type ResponseDepth = (typeof RESPONSE_DEPTHS)[number];

const EFFORT_BY_DEPTH: Record<ResponseDepth, ReasoningEffort> = {
  fast: "low",
  thorough: "high",
};

export function isResponseDepth(value: unknown): value is ResponseDepth {
  return (
    typeof value === "string" &&
    (RESPONSE_DEPTHS as readonly string[]).includes(value)
  );
}

/**
 * Map a stored persona value to an SDK reasoning-effort level.
 *
 * Returns `undefined` for null/unknown values so the caller can omit the
 * provider option entirely rather than sending a default it did not choose.
 */
export function resolveReasoningEffort(
  value: unknown,
): ReasoningEffort | undefined {
  return isResponseDepth(value) ? EFFORT_BY_DEPTH[value] : undefined;
}

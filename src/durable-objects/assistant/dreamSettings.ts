/** Opt-in memory consolidation cadences. A null persona value means off. */
export const DREAM_INTERVAL_HOURS = [12, 24, 48] as const;

export type DreamIntervalHours = (typeof DREAM_INTERVAL_HOURS)[number];

/** Shared by the HTTP boundary and the Durable Object scheduler. */
export function isDreamIntervalHours(
  value: unknown,
): value is DreamIntervalHours {
  return (
    typeof value === "number" &&
    (DREAM_INTERVAL_HOURS as readonly number[]).includes(value)
  );
}

/** The single recurring dreaming job in the shared alarm scheduler. */
export const DREAM_JOB_ID = "dream";

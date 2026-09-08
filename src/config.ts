import type { Env } from "./types";
export type RequestPurpose = "foreground" | "background";
export const CHAT_MODEL = "chat";
export const BACKGROUND_MODEL = "background";
export const BATCH_MODEL = "batch";
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export function modelFor(
  env: Partial<Pick<Env, "CHAT_MODEL" | "BACKGROUND_MODEL" | "BATCH_MODEL">>,
  purpose: string,
): string {
  const value =
    purpose === "batch"
      ? env.BATCH_MODEL
      : purpose === "background"
        ? env.BACKGROUND_MODEL
        : env.CHAT_MODEL;
  if (!value)
    throw new Error(
      `Configure ${purpose.toUpperCase()}_MODEL before using this capability`,
    );
  return value;
}
export const BACKGROUND_REASONING_EFFORT = "max";

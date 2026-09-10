import { createAuthClient } from "better-auth/react";
import { passkeyClient } from "@better-auth/passkey/client";

// The browser uses same-origin HttpOnly session cookies. Credentials are never
// copied to localStorage, sessionStorage, URLs, or the agent's request payloads.
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [passkeyClient()],
  fetchOptions: { credentials: "same-origin" },
});

export interface AuthOptions {
  enabled: boolean;
  accessRecovery: boolean;
}
export type AuthMode = "native" | "access" | "token" | "service";
export class AuthRequestError extends Error {
  constructor(public readonly status: number) {
    super("Account request failed");
  }
}
export async function authRequest<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (!response.ok) throw new AuthRequestError(response.status);
  return response.status === 204 ? (undefined as T) : response.json();
}
export function authErrorStatus(error: unknown): number | undefined {
  return error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined;
}
export function accountError(error: unknown, fallback: string): string {
  switch (authErrorStatus(error)) {
    case 401:
      return "Your session expired. Sign in again to continue.";
    case 403:
      return "This sign-in is no longer recent enough. Verify your identity and try again.";
    case 429:
      return "Too many attempts. Wait a moment before trying again.";
    default:
      return fallback;
  }
}

/** Short-lived HMAC envelopes for coordinator-to-child service calls. */
export interface InternalAuthContext {
  userId: string;
  organizationId: string;
  tenantBinding: string;
  role: string;
  ts: number;
}

const MAX_AGE_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const encoder = new TextEncoder();

async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createInternalAuthHeaders(
  context: Omit<InternalAuthContext, "ts">,
  secret: string,
): Promise<Record<string, string>> {
  if (!secret) throw new Error("Internal authentication secret is required");
  const payload = JSON.stringify({ ...context, ts: Date.now() });
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await key(secret),
      encoder.encode(payload),
    ),
  );
  return {
    "X-Internal-Auth": payload,
    "X-Internal-Signature": Array.from(signature, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    "Content-Type": "application/json",
  };
}

export async function validateInternalAuth(
  payload: string | null,
  signature: string | null,
  secret: string,
): Promise<InternalAuthContext | null> {
  if (
    !payload ||
    payload.length > 4096 ||
    !signature ||
    !/^[a-f0-9]{64}$/i.test(signature) ||
    !secret
  )
    return null;
  try {
    const bytes = Uint8Array.from(signature.match(/../g)!, (pair) =>
      Number.parseInt(pair, 16),
    );
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await key(secret),
        bytes,
        encoder.encode(payload),
      ))
    )
      return null;
    const context: unknown = JSON.parse(payload);
    if (!context || typeof context !== "object" || Array.isArray(context))
      return null;
    const value = context as Record<string, unknown>;
    if (
      !["userId", "organizationId", "tenantBinding", "role"].every(
        (field) =>
          typeof value[field] === "string" &&
          (value[field] as string).length > 0,
      )
    )
      return null;
    if (typeof value.ts !== "number" || !Number.isFinite(value.ts)) return null;
    const age = Date.now() - value.ts;
    if (age > MAX_AGE_MS || age < -MAX_CLOCK_SKEW_MS) return null;
    return value as unknown as InternalAuthContext;
  } catch {
    return null;
  }
}

export async function readInternalAuth(
  request: Request,
  env: { INTERNAL_AUTH_SECRET?: string },
): Promise<InternalAuthContext | null> {
  return validateInternalAuth(
    request.headers.get("X-Internal-Auth"),
    request.headers.get("X-Internal-Signature"),
    env.INTERNAL_AUTH_SECRET ?? "",
  );
}

export async function requireInternalAuth(
  request: Request,
  env: { INTERNAL_AUTH_SECRET?: string },
): Promise<boolean> {
  return (await readInternalAuth(request, env)) !== null;
}

export const INTERNAL_AUTH_MIGRATION_WINDOW = false;
export async function checkInternalAuth(
  request: Request,
  env: { INTERNAL_AUTH_SECRET?: string },
): Promise<"ok" | "invalid" | "missing"> {
  if (
    !request.headers.has("X-Internal-Auth") ||
    !request.headers.has("X-Internal-Signature")
  )
    return "missing";
  return (await requireInternalAuth(request, env)) ? "ok" : "invalid";
}

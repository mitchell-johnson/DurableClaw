import { APIError } from "better-auth/api";

export const FRESH_MS = 5 * 60_000;
export const BODY_LIMIT = 32 * 1024;

export interface AccessEvidence {
  issuedAt: number;
  expiresAt: number;
  authenticatedAt: number | null;
}

export function validAccessEvidence(
  value: AccessEvidence,
  now = Date.now(),
): boolean {
  return (
    Boolean(value) &&
    Number.isSafeInteger(value.issuedAt) &&
    value.issuedAt > 0 &&
    value.issuedAt <= now &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > now &&
    value.expiresAt > value.issuedAt &&
    (value.authenticatedAt === null ||
      (Number.isSafeInteger(value.authenticatedAt) &&
        value.authenticatedAt > 0 &&
        value.authenticatedAt <= value.issuedAt))
  );
}

export function enrollmentCompleted(storage: DurableObjectStorage): boolean {
  return (
    storage.sql
      .exec<{ enrolled_at: number | null }>(
        "SELECT enrolled_at FROM identity_policy WHERE id=1",
      )
      .one().enrolled_at !== null
  );
}

export function completeEnrollment(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    storage.sql.exec(
      "UPDATE identity_policy SET enrolled_at=COALESCE(enrolled_at,?) WHERE id=1",
      Date.now(),
    );
    storage.sql.exec(
      "DELETE FROM identity_session WHERE auth_method='access' AND auth_proof='enrollment'",
    );
  });
}

interface SessionProof {
  createdAt: Date | string | number;
  authMethod?: unknown;
  authProof?: unknown;
}

export function freshAuthority(
  session: SessionProof,
  enrolled: boolean,
  now = Date.now(),
): boolean {
  if (!freshSession(session.createdAt, now)) return false;
  if (session.authMethod === "password" || session.authMethod === "passkey")
    return true;
  return (
    session.authMethod === "access" &&
    (session.authProof === "upstream" ||
      (session.authProof === "enrollment" && !enrolled))
  );
}

export function recoveryAuthority(
  session: SessionProof,
  enrolled: boolean,
  now = Date.now(),
): boolean {
  return (
    freshAuthority(session, enrolled, now) &&
    (session.authMethod === "passkey" ||
      (session.authMethod === "access" && session.authProof === "upstream"))
  );
}

export function accessSessionProof(
  evidence: AccessEvidence,
  enrolled: boolean,
) {
  return evidence.authenticatedAt !== null
    ? { createdAt: new Date(evidence.authenticatedAt), authProof: "upstream" }
    : !enrolled
      ? { createdAt: new Date(evidence.issuedAt), authProof: "enrollment" }
      : { createdAt: new Date(0), authProof: "none" };
}

export function requireUserVerification(verified: boolean | undefined): void {
  if (verified !== true)
    throw new APIError("FORBIDDEN", {
      code: "USER_VERIFICATION_REQUIRED",
      message: "Verify with your device PIN or biometrics.",
    });
}

export function freshSession(
  createdAt: Date | string | number,
  now = Date.now(),
): boolean {
  const age = now - new Date(createdAt).getTime();
  return Number.isFinite(age) && age >= 0 && age < FRESH_MS;
}

export function consumeRateLimits(
  storage: DurableObjectStorage,
  keys: string[],
  maximum: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  return storage.transactionSync(() => {
    storage.sql.exec(
      "DELETE FROM identity_rate_limit WHERE reset_at <= ?",
      now,
    );
    for (const key of keys) {
      const row = storage.sql
        .exec<{ count: number }>(
          "SELECT count FROM identity_rate_limit WHERE key = ?",
          key,
        )
        .toArray()[0];
      if (row && row.count >= maximum) return false;
    }
    for (const key of keys) {
      storage.sql.exec(
        "INSERT INTO identity_rate_limit(key,count,reset_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
        key,
        now + windowMs,
      );
    }
    return true;
  });
}

export async function boundedJson(
  request: Request,
): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader)
    throw new APIError("BAD_REQUEST", { message: "JSON body required." });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) {
        await reader.cancel();
        throw new APIError("PAYLOAD_TOO_LARGE", {
          message: "Request body too large.",
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(data),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new APIError("BAD_REQUEST", { message: "Invalid JSON body." });
  }
}

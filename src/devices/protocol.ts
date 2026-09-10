/** v1 protocol: signatures bind device, method, exact URL, freshness and bytes. */
export const DEVICE_SIGNATURE_VERSION = "durableclaw-device-v1";
export const MAX_RESULT_BYTES = 64 * 1024;
export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_COMMAND_BYTES = 16000;
export const MAX_TIMEOUT_MS = 120000;
export const CLOCK_SKEW_MS = 60000;
const encoder = new TextEncoder();
export function byteLength(value: string): number {
  return encoder.encode(value).length;
}
export async function sha256(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function encodeBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}
export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("Invalid base64");
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}
export async function verifySignature(
  publicKey: string,
  signature: string,
  text: string,
): Promise<boolean> {
  try {
    const bytes = decodeBase64(signature);
    if (bytes.length !== 64) return false;
    const key = await crypto.subtle.importKey(
      "spki",
      decodeBase64(publicKey),
      "Ed25519",
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      bytes,
      encoder.encode(text),
    );
  } catch {
    return false;
  }
}
export async function deviceSigningText(
  request: Request,
  rawBody: string,
): Promise<string> {
  const url = new URL(request.url);
  return [
    DEVICE_SIGNATURE_VERSION,
    request.headers.get("X-Device-Id"),
    request.method,
    url.origin + url.pathname + url.search,
    request.headers.get("X-Device-Timestamp"),
    request.headers.get("X-Device-Nonce"),
    await sha256(rawBody),
  ].join("\n");
}
export class DeviceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function requireSecureTransport(
  request: Request,
  localDev?: string,
): void {
  const url = new URL(request.url);
  if (url.protocol === "https:") return;
  if (
    localDev === "true" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    return;
  throw new DeviceError("HTTPS required");
}
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<string> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > maxBytes)
    throw new DeviceError("Request too large", 413);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let raw = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new DeviceError("Request too large", 413);
      }
      raw += decoder.decode(value, { stream: true });
    }
    return raw + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}
export function objectBody(raw: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DeviceError("Invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DeviceError("Expected JSON object");
  return value as Record<string, unknown>;
}
export function uuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

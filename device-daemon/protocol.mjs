import { createHash, randomUUID, sign } from "node:crypto";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export class AuthError extends HttpError {}

export function validateOrigin(value, allowLocalHttp = false) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(allowLocalHttp && loopback && url.protocol === "http:"))
  ) {
    throw new Error(
      "Server must be an HTTPS origin without credentials, path, query, or fragment",
    );
  }
  return url.origin;
}

export function signRequest({
  deviceId,
  privateKey,
  url,
  method = "POST",
  body = "{}",
  timestamp = Date.now(),
  nonce = randomUUID(),
}) {
  url = new URL(url);
  const digest = createHash("sha256").update(body).digest("hex");
  const text = `durableclaw-device-v1\n${deviceId}\n${method}\n${url.origin + url.pathname + url.search}\n${timestamp}\n${nonce}\n${digest}`;
  return {
    "X-Device-Id": deviceId,
    "X-Device-Timestamp": String(timestamp),
    "X-Device-Nonce": nonce,
    "X-Device-Signature": sign(null, Buffer.from(text), privateKey).toString(
      "base64",
    ),
  };
}

export function enrollProof(code, publicKey, privateKey) {
  return sign(
    null,
    Buffer.from(`durableclaw-enroll-v1\n${code}\n${publicKey}`),
    privateKey,
  ).toString("base64");
}

export async function requestJson(
  url,
  { body = "{}", headers = {}, signal, fetchImpl = fetch } = {},
) {
  const response = await fetchImpl(url, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (response.status >= 300 && response.status < 400)
    throw new HttpError(response.status, "Server redirect rejected");
  if (!response.ok) {
    await response.body?.cancel();
    const ErrorType = [401, 403].includes(response.status)
      ? AuthError
      : HttpError;
    throw new ErrorType(
      response.status,
      `Server returned HTTP ${response.status}`,
    );
  }
  const reader = response.body?.getReader();
  const chunks = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 98304) throw new Error("Server response too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function deviceRequest(config, privateKey, path, body, options = {}) {
  if (!["/api/devices/poll", "/api/devices/result"].includes(path))
    throw new Error("Invalid device endpoint");
  const origin = validateOrigin(config.origin, config.allowLocalHttp === true);
  const url = new URL(path, origin);
  const raw = JSON.stringify(body);
  return requestJson(url, {
    ...options,
    body: raw,
    headers: signRequest({
      deviceId: config.deviceId,
      privateKey,
      url,
      body: raw,
    }),
  });
}

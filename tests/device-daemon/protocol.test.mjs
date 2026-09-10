import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify, createHash } from "node:crypto";
import {
  validateOrigin,
  signRequest,
  enrollProof,
  requestJson,
  AuthError,
} from "../../device-daemon/protocol.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
test("device signatures bind the complete request and body bytes", () => {
  const url = new URL("https://example.com/api/devices/result?x=1");
  const headers = signRequest({
    deviceId: "device-1",
    privateKey,
    url,
    method: "POST",
    body: "{}",
    timestamp: 1234,
    nonce: "nonce",
  });
  const digest = createHash("sha256").update("{}").digest("hex");
  const message = `durableclaw-device-v1\ndevice-1\nPOST\n${url.href}\n1234\nnonce\n${digest}`;
  assert.equal(
    verify(
      null,
      Buffer.from(message),
      publicKey,
      Buffer.from(headers["X-Device-Signature"], "base64"),
    ),
    true,
  );
  assert.equal(
    verify(
      null,
      Buffer.from(message.replace("{}", "{ }") + "x"),
      publicKey,
      Buffer.from(headers["X-Device-Signature"], "base64"),
    ),
    false,
  );
  assert.equal(headers["X-Device-Timestamp"], "1234");
});
test("enrollment proof binds both one-use code and public key", () => {
  const key = publicKey
    .export({ format: "der", type: "spki" })
    .toString("base64");
  assert.equal(
    verify(
      null,
      Buffer.from(`durableclaw-enroll-v1\ncode\n${key}`),
      publicKey,
      Buffer.from(enrollProof("code", key, privateKey), "base64"),
    ),
    true,
  );
});
test("only a clean HTTPS origin or explicitly allowed loopback HTTP is accepted", () => {
  assert.equal(validateOrigin("https://example.com/"), "https://example.com");
  for (const value of [
    "http://example.com",
    "https://u:p@example.com",
    "https://example.com/path",
    "https://example.com?x=1",
    "https://example.com/#x",
  ])
    assert.throws(() => validateOrigin(value));
  assert.throws(() => validateOrigin("http://127.0.0.1:8787"));
  assert.equal(
    validateOrigin("http://127.0.0.1:8787", true),
    "http://127.0.0.1:8787",
  );
  assert.throws(() => validateOrigin("http://example.com", true));
});
test("HTTP transport never follows redirects or accepts oversized responses", async () => {
  let options;
  await assert.rejects(
    requestJson("https://example.com/a", {
      fetchImpl: async (_url, opts) => {
        options = opts;
        return new Response(null, {
          status: 302,
          headers: { location: "https://evil.example" },
        });
      },
    }),
    /redirect/i,
  );
  assert.equal(options.redirect, "error");
  await assert.rejects(
    requestJson("https://example.com/a", {
      fetchImpl: async () => new Response("x".repeat(100000)),
    }),
    /large/i,
  );
  await assert.rejects(
    requestJson("https://example.com/a", {
      fetchImpl: async () => new Response("{}", { status: 401 }),
    }),
    AuthError,
  );
});

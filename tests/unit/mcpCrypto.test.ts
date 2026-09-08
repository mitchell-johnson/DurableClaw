/**
 * unit tests for `durable-objects/assistant/mcpCrypto.ts`.
 *
 * Covers the three guarantees the encryption layer must hold:
 *   1. Roundtrip (encrypt → decrypt) reproduces the original payload exactly.
 *   2. Tampered ciphertext fails the AES-GCM auth tag check and throws.
 *   3. Two calls with the same payload produce different ciphertexts thanks
 *      to the random IV. Without this property an attacker with read-only
 *      access to many users' encrypted blobs could correlate identical
 *      tokens across users.
 */

import { describe, it, expect } from "vitest";
import {
  encryptCredentials,
  decryptCredentials,
} from "../../src/durable-objects/assistant/mcpCrypto";

const scope = {
  userId: "owner",
  workspaceId: "default",
  serverName: "example",
  serverUrl: "https://mcp.example.invalid",
};
const env = {
  MCP_CREDENTIALS_SECRET: "test-key-material-do-not-use-in-production",
};

describe("mcpCrypto", () => {
  it("roundtrips a credentials payload through encrypt + decrypt", async () => {
    const payload = {
      Authorization: "Bearer s3cret-token-value",
      "X-Custom-Header": "extra",
    };
    const encrypted = await encryptCredentials(env, payload, scope);
    expect(typeof encrypted).toBe("string");
    expect(encrypted.length).toBeGreaterThan(0);

    const decrypted = await decryptCredentials(env, encrypted, scope);
    expect(decrypted).toEqual(payload);
  });

  it("throws when the ciphertext has been tampered with", async () => {
    const payload = { Authorization: "Bearer original" };
    const encrypted = await encryptCredentials(env, payload, scope);

    // Flip one byte in the middle (skip the 12-byte IV prefix and corrupt
    // the AES-GCM ciphertext body). The auth tag check must catch this.
    const bytes = atob(encrypted.slice(3));
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    // Pick a byte well after the IV but before the auth tag tail.
    buf[20] = (buf[20] + 1) & 0xff;
    let tamperedB64 = "";
    for (let i = 0; i < buf.length; i++)
      tamperedB64 += String.fromCharCode(buf[i]);
    tamperedB64 = "v2:" + btoa(tamperedB64);

    await expect(decryptCredentials(env, tamperedB64, scope)).rejects.toThrow();
  });

  it("produces different ciphertexts for identical payloads (random IV)", async () => {
    const payload = { Authorization: "Bearer same-token" };
    const a = await encryptCredentials(env, payload, scope);
    const b = await encryptCredentials(env, payload, scope);
    expect(a).not.toEqual(b);

    // Both still decrypt to the same plaintext — sanity-check that the
    // randomness is in the IV, not in the payload.
    expect(await decryptCredentials(env, a, scope)).toEqual(payload);
    expect(await decryptCredentials(env, b, scope)).toEqual(payload);
  });
});

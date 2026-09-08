/**
 * MCP credential encryption helpers — DurableClaw memory and personas.
 *
 * Persona.mcp_servers entries carry an opaque `headers_encrypted` blob that
 * holds bearer tokens / API keys for outbound MCP server calls. Those tokens
 * never leave DurableClaw's namespace in plaintext: they're encrypted at the route
 * boundary (`/api/assistant/mcp/encrypt-credentials`) and stay encrypted on
 * disk inside the DO. Only the DO's tool-discovery + tool-call paths decrypt.
 *
 * Crypto choices:
 *   - AES-GCM via Web Crypto (`crypto.subtle`) — workerd has a native impl,
 *     no external deps.
 *   - 256-bit key derived from `env.MCP_CREDENTIALS_SECRET` via HKDF with a
 *     stable `info` label and salt so re-deriving on the next request
 *     produces the same key. `MCP_CREDENTIALS_SECRET` is already a high-entropy
 *     secret (BetterAuth signing key), suitable as HKDF input keying
 *     material.
 *   - 12-byte random IV per encryption (NIST-recommended for GCM).
 *   - Output: base64(IV || ciphertext) — a single self-describing string.
 *
 * Threat model: the goal is "anyone with read access to the DO storage cannot
 * pop out raw bearer tokens". A full break still requires `MCP_CREDENTIALS_SECRET`,
 * which is treated as the platform-wide root secret already.
 */

const HKDF_INFO = "durableclaw-mcp-credentials-v1";
const HKDF_SALT = "durableclaw-mcp";
const IV_LENGTH = 12; // bytes — standard AES-GCM IV size

/**
 * Minimal env shape required by the crypto helpers. Defined locally rather
 * than importing the full `Env` so this module stays unit-testable without
 * the full env mock.
 */
export interface McpCryptoEnv {
  MCP_CREDENTIALS_SECRET?: string;
}

/**
 * Derive a 256-bit AES-GCM key from MCP_CREDENTIALS_SECRET via HKDF. Derived per operation without a global credential cache.
 */
async function deriveKey(env: McpCryptoEnv): Promise<CryptoKey> {
  const secret = env.MCP_CREDENTIALS_SECRET;
  if (!secret || typeof secret !== "string") {
    throw new Error(
      "MCP_CREDENTIALS_SECRET is required for MCP credential crypto",
    );
  }

  const encoder = new TextEncoder();
  const ikm = encoder.encode(secret);

  // Step 1: import the raw secret as HKDF input keying material.
  const baseKey = await crypto.subtle.importKey(
    "raw",
    ikm,
    { name: "HKDF" },
    false,
    ["deriveKey"],
  );

  // Step 2: derive a 256-bit AES-GCM key from the HKDF input.
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: encoder.encode(HKDF_SALT),
      info: encoder.encode(HKDF_INFO),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Base64-encode a `Uint8Array`. Uses `btoa` rather than Node's `Buffer`
 * because Cloudflare Workers' runtime is browser-flavoured.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Reverse of `bytesToBase64`. Throws on non-base64 input.
 */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Encrypt a credentials payload (e.g. `{ "Authorization": "Bearer x" }`) to
 * a single base64 blob. Each call uses a fresh random IV so identical inputs
 * produce different ciphertexts — a non-determinism property tests assert.
 */
export async function encryptCredentials(
  env: McpCryptoEnv,
  payload: Record<string, string>,
): Promise<string> {
  const key = await deriveKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  // Concatenate IV || ciphertext so decrypt can split without a separate
  // metadata blob.
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return bytesToBase64(out);
}

/**
 * Decrypt a base64(IV||ciphertext) blob produced by `encryptCredentials`.
 * Throws on:
 *   - bad base64
 *   - truncated input (less than IV_LENGTH bytes)
 *   - GCM auth-tag mismatch (tampered ciphertext)
 *   - JSON parse failure on the decrypted plaintext
 */
export async function decryptCredentials(
  env: McpCryptoEnv,
  ciphertext: string,
): Promise<Record<string, string>> {
  const bytes = base64ToBytes(ciphertext);
  if (bytes.length <= IV_LENGTH) {
    throw new Error("encrypted credentials blob is truncated");
  }
  const iv = bytes.subarray(0, IV_LENGTH);
  const data = bytes.subarray(IV_LENGTH);

  const key = await deriveKey(env);
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(iv) },
    key,
    new Uint8Array(data),
  );
  const text = new TextDecoder().decode(plaintextBuf);
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("decrypted MCP credentials payload is not an object");
  }
  if (
    Object.entries(parsed).some(
      ([key, value]) =>
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
        typeof value !== "string" ||
        /[\r\n]/.test(value),
    )
  ) {
    throw new Error(
      "decrypted MCP credentials must contain valid string headers",
    );
  }
  return parsed as Record<string, string>;
}

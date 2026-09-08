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
 *     dedicated random secret, suitable as HKDF input keying
 *     material.
 *   - 12-byte random IV per encryption (NIST-recommended for GCM).
 *   - Output: v2:base64(IV || ciphertext). Owner, workspace, server name and
 *     canonical destination URL are authenticated additional data.
 *
 * Threat model: the goal is "anyone with read access to the DO storage cannot
 * pop out raw bearer tokens". A full break still requires `MCP_CREDENTIALS_SECRET`,
 * which is treated as the platform-wide root secret already.
 */

const HKDF_INFO = "durableclaw-mcp-credentials-v1";
const HKDF_SALT = "durableclaw-mcp";
const IV_LENGTH = 12; // bytes — standard AES-GCM IV size
const VERSION_PREFIX = "v2:";
export interface McpCredentialScope {
  userId: string;
  workspaceId: string;
  serverName: string;
  serverUrl: string;
}
function associatedData(scope: McpCredentialScope): Uint8Array<ArrayBuffer> {
  if (
    !scope?.userId ||
    !scope.workspaceId ||
    !scope.serverName ||
    !scope.serverUrl
  )
    throw new Error("MCP credential scope is required");
  return new TextEncoder().encode(
    JSON.stringify([
      VERSION_PREFIX,
      scope.userId,
      scope.workspaceId,
      scope.serverName,
      new URL(scope.serverUrl).href,
    ]),
  );
}
export function validateMcpHeaders(
  payload: unknown,
): asserts payload is Record<string, string> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new Error("MCP credentials must contain valid string headers");
  const entries = Object.entries(payload);
  if (
    entries.length > 32 ||
    entries.some(
      ([key, value]) =>
        key.length > 128 ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
        typeof value !== "string" ||
        /[\x00-\x1f\x7f]/.test(value) ||
        value.length > 8192,
    ) ||
    new TextEncoder().encode(JSON.stringify(payload)).byteLength > 10_000
  )
    throw new Error(
      "MCP credentials must contain valid string headers within size limits",
    );
}

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
  scope: McpCredentialScope,
): Promise<string> {
  validateMcpHeaders(payload);
  const key = await deriveKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: associatedData(scope) },
      key,
      plaintext,
    ),
  );
  // Concatenate IV || ciphertext so decrypt can split without a separate
  // metadata blob.
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return VERSION_PREFIX + bytesToBase64(out);
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
  scope: McpCredentialScope,
): Promise<Record<string, string>> {
  if (!ciphertext.startsWith(VERSION_PREFIX))
    throw new Error(
      "Legacy MCP credentials require trusted stored configuration",
    );
  return decryptStoredCredentials(env, ciphertext, scope);
}

/** Only call on an existing server read from the owner's durable persona row. */
export async function decryptStoredCredentials(
  env: McpCryptoEnv,
  ciphertext: string,
  scope: McpCredentialScope,
): Promise<Record<string, string>> {
  const aad = associatedData(scope);
  const scoped = ciphertext.startsWith(VERSION_PREFIX);
  // Legacy blobs can only come from an existing persisted server configuration.
  // The persona boundary disallows submitting or retargeting an arbitrary blob.
  const bytes = base64ToBytes(
    scoped ? ciphertext.slice(VERSION_PREFIX.length) : ciphertext,
  );
  if (bytes.length <= IV_LENGTH) {
    throw new Error("encrypted credentials blob is truncated");
  }
  const iv = bytes.subarray(0, IV_LENGTH);
  const data = bytes.subarray(IV_LENGTH);

  const key = await deriveKey(env);
  const plaintextBuf = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(iv),
      ...(scoped ? { additionalData: aad } : {}),
    },
    key,
    new Uint8Array(data),
  );
  const text = new TextDecoder().decode(plaintextBuf);
  const parsed = JSON.parse(text) as unknown;
  validateMcpHeaders(parsed);
  return parsed;
}

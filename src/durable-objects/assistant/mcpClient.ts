/**
 * HTTP MCP client — DurableClaw memory and personas.
 *
 * Implements the Model Context Protocol over HTTPS using JSON-RPC 2.0. Only
 * the two operations DurableClaw needs are exposed:
 *
 *   - `discoverMCPTools()` — runs `initialize` then `tools/list`, returns the
 *     normalized tool catalog the DO will register.
 *   - `callMCPTool()` — runs `tools/call` against the same server, returns
 *     the tool result raw (the DO stringifies it before handing to the LLM).
 *
 * Hard limits / safety:
 *   - HTTPS only — `http://` URLs are rejected up front. This prevents both
 *     accidental cleartext transport and SSRF-style probing of internal
 *     services that are usually `http://...:<port>`.
 *   - AbortController-backed timeouts so a slow/hostile MCP server can't
 *     wedge a turn. Discovery uses a short 5s budget; tool calls get 30s.
 *   - Non-2xx responses throw with the status code in the message — the DO
 *     catches and logs at the call site.
 *
 * Supports Streamable HTTP JSON/SSE responses, initialization, session headers,
 * bounded catalog pagination and session termination. Resources, prompts, OAuth
 * refresh and background notification streams are left to custom adapters.
 */

import type { Env } from "../../types";
import { sanitizeToolOutput } from "../../action-library/helpers";

/**
 * Untrusted content: MCP servers are third-party, user-configured and untrusted — their
 * tool descriptions and results are attacker-controllable text that lands
 * in model context. Every string is passed through the same
 * `sanitizeToolOutput` pre-pass used for internal tool output (advisory
 * injection-marker stripping) AT INGESTION: descriptions at discovery,
 * result strings when a call returns.
 */
function sanitizeMCPValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return sanitizeToolOutput(value);
  if (depth >= 8) return "[nested value omitted]"; // bound recursion on hostile shapes
  if (Array.isArray(value))
    return value.map((v) => sanitizeMCPValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizeToolOutput(k)] = sanitizeMCPValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Normalized MCP tool shape — the same fields the SDK uses, narrowed to
 * what DurableClaw actually consumes. `inputSchema` is forwarded verbatim to
 * the LLM via the Vercel AI SDK's `jsonSchema()` wrapper.
 */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: object;
}

/**
 * Persisted shape under `persona.mcp_servers[]`. The encrypted blob is the
 * output of `mcpCrypto.encryptCredentials` — opaque to everything outside
 * the DO.
 */
export interface MCPServerConfig {
  name: string;
  url: string;
  headers_encrypted?: string;
}

/** MCP protocol version DurableClaw speaks. Bump in lockstep with the spec. */
const MCP_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_VERSIONS = new Set([
  MCP_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
]);
const MCP_CLIENT_INFO = { name: "durableclaw", version: "1.0" };
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 30_000;
export const MAX_MCP_CATALOG_BYTES = 512 * 1024;
export const MAX_MCP_TOTAL_CATALOG_BYTES = 1024 * 1024;
const MAX_MCP_SCHEMA_BYTES = 128 * 1024;

/** Schema keywords, references and literal values are data, never rewritten. */
function boundedMcpSchema(value: unknown): object | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("MCP tool input schema must be an object");
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 10_000 || item.depth > 64)
      throw new Error("MCP input schema exceeds complexity limit");
    if (item.value && typeof item.value === "object")
      for (const child of Object.values(item.value))
        pending.push({ value: child, depth: item.depth + 1 });
  }
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    MAX_MCP_SCHEMA_BYTES
  )
    throw new Error("MCP input schema exceeds size limit");
  return value;
}
export function mcpCatalogBytes(tools: MCPTool[]): number {
  return new TextEncoder().encode(JSON.stringify(tools)).byteLength;
}
/** Configuration identity includes credential rotation, without exposing it in a tool name. */
export function mcpServerFingerprint(server: MCPServerConfig): string {
  return JSON.stringify([
    server.name,
    new URL(server.url).href,
    server.headers_encrypted ?? null,
  ]);
}

/** Parse a literal dotted-decimal IPv4 address into 4 octets, or null. */
function parseIPv4(input: string): [number, number, number, number] | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

/** True if a literal IPv4 address falls in a private/loopback/link-local range. */
function isPrivateIPv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 — "this host"
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && (b === 168 || b === 0)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // shared address space
  if (a >= 224 || (a === 198 && (b === 18 || b === 19))) return true; // 192.168.0.0/16
  return false;
}

/**
 * Expand a literal IPv6 address (no brackets) into 8 hextets, handling `::`
 * compression and a trailing embedded IPv4 (e.g. `::ffff:192.168.1.1`).
 * Returns null if the input is not a parseable IPv6 literal.
 */
function expandIPv6(input: string): number[] | null {
  let str = input;
  let ipv4Tail: [number, number, number, number] | null = null;

  // Split off an embedded IPv4 suffix (`...:a.b.c.d`).
  if (str.includes(".")) {
    const idx = str.lastIndexOf(":");
    if (idx === -1) return null;
    const v4 = parseIPv4(str.slice(idx + 1));
    if (!v4) return null;
    ipv4Tail = v4;
    str = str.slice(0, idx); // keep the colon-delimited hex portion
  }

  const halves = str.split("::");
  if (halves.length > 2) return null;

  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };

  const head = parseGroups(halves[0]);
  let tail = halves.length === 2 ? parseGroups(halves[1]) : [];
  if (head === null || tail === null) return null;

  if (ipv4Tail) {
    tail = [
      ...tail,
      (ipv4Tail[0] << 8) | ipv4Tail[1],
      (ipv4Tail[2] << 8) | ipv4Tail[3],
    ];
  }

  let hextets: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    hextets = [...head, ...new Array(missing).fill(0), ...tail];
  } else {
    hextets = [...head, ...tail];
  }
  return hextets.length === 8 ? hextets : null;
}

/** True if a parsed IPv6 address (8 hextets) is loopback/ULA/link-local/internal. */
function isInternalIPv6(h: number[]): boolean {
  if (h.every((x) => x === 0)) return true; // :: unspecified
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1 loopback
  // IPv4-mapped (::ffff:a.b.c.d) / IPv4-compatible (::a.b.c.d) — inspect the embedded v4.
  const firstFiveZero = h.slice(0, 5).every((x) => x === 0);
  if (firstFiveZero && (h[5] === 0xffff || h[5] === 0)) {
    const v4: [number, number, number, number] = [
      h[6] >> 8,
      h[6] & 0xff,
      h[7] >> 8,
      h[7] & 0xff,
    ];
    if (isPrivateIPv4(v4)) return true;
  }
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((h[0] & 0xff00) === 0xff00 || (h[0] & 0xffc0) === 0xfec0) return true;
  if ((h[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/**
 * SSRF guard (SSRF guard). True when `hostname` (a parsed URL hostname — IPv6 may
 * be bracketed) is a private, loopback, link-local or known-internal host that
 * a server-side fetch must never target.
 *
 * DNS resolution is unavailable in the Workers runtime, so this can only reason
 * about literal IPs and exact internal hostnames; a public hostname that
 * resolves to a private IP cannot be caught here and must be guarded by network
 * policy. The check still blocks the direct-literal SSRF vectors (metadata
 * endpoints, RFC1918, loopback) an authenticated user could otherwise point a
 * persona's MCP server URL at to probe internal infra and exfiltrate the
 * attached credential headers.
 */
export function isPrivateOrInternalHost(hostname: string): boolean {
  let host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return true;

  // Known-internal hostnames (literal matches only — no DNS in Workers).
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (
    host === "metadata.google.internal" ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  )
    return true;

  const v4 = parseIPv4(host);
  if (v4) return isPrivateIPv4(v4);

  if (host.includes(":")) {
    const v6 = expandIPv6(host);
    // A colon host that won't parse as IPv6 is malformed — treat as suspect.
    return v6 ? isInternalIPv6(v6) : true;
  }

  return false;
}

/**
 * Validate transport — HTTPS only, and never a private/internal host. Returns a
 * parsed URL on success, throws a stable error message on failure (route + DO
 * log it). Applied in both discovery and call paths.
 */
export function requireHttpsURL(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("MCP server URL is malformed");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `MCP server URL must use https:// (got ${parsed.protocol}//)`,
    );
  }
  if (parsed.username || parsed.password || parsed.hash)
    throw new Error(
      "MCP server URL must not contain credentials or a fragment",
    );
  // SSRF guard: block SSRF to internal infrastructure / metadata endpoints.
  if (isPrivateOrInternalHost(parsed.hostname)) {
    throw new Error("MCP server URL cannot target a private or internal host");
  }
  return parsed;
}

interface Connection {
  url: URL;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  deadline: number;
  sessionId?: string;
  protocolVersion?: string;
}
function connectionHeaders(connection: Connection): Record<string, string> {
  return {
    ...connection.headers,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(connection.sessionId ? { "MCP-Session-Id": connection.sessionId } : {}),
    ...(connection.protocolVersion
      ? { "MCP-Protocol-Version": connection.protocolVersion }
      : {}),
  };
}
/** A request owns one deadline, including consuming a slow chunked body. */
async function jsonRpcRequest(
  connection: Connection,
  method: string,
  params: unknown,
  notification = false,
): Promise<unknown> {
  const remaining = connection.deadline - Date.now();
  if (remaining <= 0) throw new Error("MCP operation timed out");
  const id = crypto.randomUUID();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), remaining);
  try {
    const response = await connection.fetchImpl(connection.url.href, {
      method: "POST",
      redirect: "manual",
      headers: connectionHeaders(connection),
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(notification ? {} : { id }),
        method,
        params,
      }),
      signal: ctrl.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`MCP server returned ${response.status}`);
    }
    if (notification) {
      await response.body?.cancel().catch(() => {});
      return;
    }
    if (method === "initialize") {
      const sessionId = response.headers.get("MCP-Session-Id");
      if (sessionId) {
        if (!/^[\x21-\x7e]{1,1024}$/.test(sessionId))
          throw new Error("MCP session identifier invalid");
        connection.sessionId = sessionId;
      }
    }
    const parsed = (await readRpcResponse(response, id)) as {
      jsonrpc?: string;
      id?: unknown;
      result?: unknown;
      error?: { code?: number };
    };
    if (!parsed || parsed.jsonrpc !== "2.0" || parsed.id !== id)
      throw new Error("MCP response identity invalid");
    if (parsed.error)
      throw new Error(`MCP server error ${parsed.error.code ?? "unknown"}`);
    return parsed.result;
  } finally {
    clearTimeout(timer);
  }
}
async function initialize(connection: Connection): Promise<void> {
  const result = (await jsonRpcRequest(connection, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: MCP_CLIENT_INFO,
  })) as { protocolVersion?: string };
  if (!result || !SUPPORTED_VERSIONS.has(result.protocolVersion ?? ""))
    throw new Error("MCP protocol version unsupported");
  connection.protocolVersion = result.protocolVersion;
  await jsonRpcRequest(connection, "notifications/initialized", {}, true);
}
/** Best effort explicit session retirement; never replay a tool call on failure. */
async function closeSession(connection: Connection): Promise<void> {
  if (!connection.sessionId) return;
  const remaining = connection.deadline - Date.now();
  if (remaining <= 0) return;
  try {
    const response = await connection.fetchImpl(connection.url.href, {
      method: "DELETE",
      redirect: "manual",
      headers: connectionHeaders(connection),
      signal: AbortSignal.timeout(Math.min(1000, remaining)),
    });
    await response.body?.cancel().catch(() => {});
  } catch {
    /* Session expiry remains the server's fallback cleanup. */
  }
}
function connect(
  args: {
    server: MCPServerConfig;
    decryptedHeaders?: Record<string, string>;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  },
  fallback: number,
): Connection {
  return {
    url: requireHttpsURL(args.server.url),
    headers: args.decryptedHeaders ?? {},
    fetchImpl: args.fetchImpl ?? fetch,
    deadline:
      Date.now() + Math.max(1, Math.min(60_000, args.timeoutMs ?? fallback)),
  };
}
/** Discover a bounded catalog using one temporary, invocation-owned session. */
export async function discoverMCPTools(args: {
  env: Env;
  server: MCPServerConfig;
  decryptedHeaders?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<MCPTool[]> {
  const connection = connect(args, DEFAULT_DISCOVERY_TIMEOUT_MS);
  try {
    await initialize(connection);
    const out: MCPTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let catalogBytes = 2;
    let cursor: string | undefined;
    do {
      const result = (await jsonRpcRequest(
        connection,
        "tools/list",
        cursor ? { cursor } : {},
      )) as { tools?: unknown[]; nextCursor?: unknown };
      if (!result || !Array.isArray(result.tools))
        throw new Error("MCP tool catalog invalid");
      for (const tool of result.tools) {
        if (!tool || typeof tool !== "object") continue;
        const item = tool as Record<string, unknown>;
        if (
          typeof item.name !== "string" ||
          !/^[a-zA-Z0-9_.-]{1,128}$/.test(item.name) ||
          names.has(item.name)
        )
          continue;
        names.add(item.name);
        const discovered: MCPTool = {
          name: item.name,
          description:
            typeof item.description === "string"
              ? sanitizeToolOutput(item.description).slice(0, 8000)
              : undefined,
          inputSchema: boundedMcpSchema(item.inputSchema),
        };
        catalogBytes += mcpCatalogBytes([discovered]);
        if (catalogBytes > MAX_MCP_CATALOG_BYTES)
          throw new Error("MCP tool catalog exceeds byte limit");
        out.push(discovered);
        if (out.length > 200)
          throw new Error("MCP tool catalog exceeds size limit");
      }
      cursor =
        typeof result.nextCursor === "string" && result.nextCursor
          ? result.nextCursor
          : undefined;
      if (cursor) {
        if (cursors.has(cursor) || cursors.size >= 10)
          throw new Error("MCP tool pagination exceeds limit");
        cursors.add(cursor);
      }
    } while (cursor);
    return out;
  } finally {
    await closeSession(connection);
  }
}
/** Calls are never retried: an interrupted response can hide a completed effect. */
export async function callMCPTool(args: {
  env: Env;
  server: MCPServerConfig;
  decryptedHeaders?: Record<string, string>;
  tool_name: string;
  tool_args: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  beforeCall?: () => void | Promise<void>;
}): Promise<unknown> {
  const connection = connect(args, DEFAULT_CALL_TIMEOUT_MS);
  try {
    await initialize(connection);
    await args.beforeCall?.();
    return sanitizeMCPValue(
      await jsonRpcRequest(connection, "tools/call", {
        name: args.tool_name,
        arguments: args.tool_args ?? {},
      }),
    );
  } finally {
    await closeSession(connection);
  }
}
/** Consume JSON or SSE until this request's response, with a strict byte cap. */
async function readRpcResponse(
  response: Response,
  requestId: string,
): Promise<unknown> {
  if (!response.body) throw new Error("MCP response body missing");
  const sse = response.headers
    .get("Content-Type")
    ?.includes("text/event-stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) {
        await reader.cancel();
        throw new Error("MCP response exceeds size limit");
      }
      text += decoder.decode(value, { stream: true });
      if (sse) {
        const events = text.split(/\r?\n\r?\n/);
        text = events.pop()!;
        for (const event of events) {
          const data = event
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const parsed = parseJson(data) as {
            id?: unknown;
            result?: unknown;
            error?: unknown;
          };
          if (
            parsed?.id === requestId &&
            ("result" in parsed || "error" in parsed)
          ) {
            await reader.cancel();
            return parsed;
          }
        }
      }
    }
    text += decoder.decode();
    if (sse) throw new Error("MCP stream ended before a response");
    return parseJson(text);
  } finally {
    reader.releaseLock();
  }
}
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("MCP response is not valid JSON");
  }
}

import {
  readInternalAuth,
  type InternalAuthContext,
} from "../../../src/utils/internalAuth";

import { ConnectorError, record, fields, textValue } from "./validation";
import { SERVICE_PROVIDERS, type ServiceProvider } from "./providers";
import { normalizeScope } from "./google";
import { delegationConfigured } from "./delegation";
import {
  cleanupWarnings,
  type CleanupWarning,
} from "../vendor/gogcli/diagnostics";
const encoder = new TextEncoder();
const OAUTH_TTL = 10 * 60_000;
const MAX_BODY = 32 * 1024;
const MAX_RESULT = 256 * 1024;

export interface ConnectorConfig {
  CONNECTOR_AUTH_SECRET: string;
  CONNECTOR_CREDENTIALS_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_WORKSPACE_DOMAIN?: string;
  GOOGLE_MAPS_API_KEY?: string;
}

export interface ConnectorSql {
  exec(
    query: string,
    ...bindings: (string | number | null)[]
  ): {
    toArray(): Record<string, unknown>[];
  };
}

export interface ConnectorDependencies {
  fetch(request: Request): Promise<Response>;
  native(request: Request): Promise<Response>;
  now(): number;
  providers?: ReadonlyMap<string, ServiceProvider>;
}

interface Credentials {
  account: string;
  subject: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  scopes: string[];
  services: string[];
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
function base64url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (char) => char.charCodeAt(0),
  );
}
function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
async function hash(value: string): Promise<string> {
  return base64url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}

/** Includes every authenticated namespace coordinate; never accept any of these from request JSON. */
export function connectorIdentity(context: InternalAuthContext): string {
  return JSON.stringify([
    context.organizationId,
    context.tenantBinding,
    context.userId,
  ]);
}
export async function connectorObjectName(
  context: InternalAuthContext,
): Promise<string> {
  return `connector-owner-v1:${await hash(connectorIdentity(context))}`;
}

async function readJson(
  body: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<unknown> {
  if (!body) throw new ConnectorError(400, "Invalid request");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new ConnectorError(413, "Response or request too large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(all));
  } catch {
    throw new ConnectorError(400, "Invalid JSON");
  }
}

/** Hard deadline covers both response headers and a potentially stalled/oversized body. */
async function boundedJsonRequest(
  fetcher: (request: Request) => Promise<Response>,
  request: Request,
  max: number,
  timeoutMs = 12_000,
  readBody = true,
): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ConnectorError(504, "Connector timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        const response = await fetcher(
          new Request(request, {
            signal: controller.signal,
            redirect: "manual",
          }),
        );
        if (response.status >= 300 && response.status < 400)
          throw new ConnectorError(502, "Connector request failed");
        const body =
          !readBody || response.status === 204
            ? {}
            : await readJson(response.body, max);
        if (!readBody) await response.body?.cancel();
        return { response, body };
      })(),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A single owner's durable vault. All mutations and external calls run in a bounded serial queue. */
export class ConnectorService {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  constructor(
    private sql: ConnectorSql,
    private config: ConnectorConfig,
    private dependencies: ConnectorDependencies,
  ) {
    sql.exec(`CREATE TABLE IF NOT EXISTS connector_identity (id INTEGER PRIMARY KEY CHECK (id = 1), identity TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connector_pending (state_hash TEXT PRIMARY KEY, connection_id TEXT NOT NULL, provider TEXT NOT NULL, expires_at INTEGER NOT NULL, sealed TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connector_connections (id TEXT PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, services TEXT NOT NULL, sealed TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connector_invocations (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, digest TEXT NOT NULL, issued_at INTEGER NOT NULL, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL);
      UPDATE connector_invocations SET status = 'unknown' WHERE status = 'running';`);
  }

  async fetch(request: Request): Promise<Response> {
    if ((this.config.CONNECTOR_AUTH_SECRET ?? "").length < 32)
      return json(
        { error: "Connector authentication configuration required" },
        503,
      );
    const context = await readInternalAuth(request, {
      INTERNAL_AUTH_SECRET: this.config.CONNECTOR_AUTH_SECRET,
    });
    if (!context) return json({ error: "Unauthorized" }, 401);
    if (context.role !== "owner")
      return json({ error: "Owner access required" }, 403);
    if (this.pending >= 32) return json({ error: "Connector busy" }, 429);
    this.pending++;
    const predecessor = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await predecessor;
      return await this.route(request, connectorIdentity(context));
    } catch (error) {
      if (error instanceof ConnectorError)
        return json({ error: error.message }, error.status);
      // Upstream exceptions may contain credentials, codes or message content. Never log or return them.
      return json({ error: "Connector unavailable" }, 503);
    } finally {
      this.pending--;
      release();
    }
  }

  private async body(request: Request): Promise<Record<string, unknown>> {
    if (
      !request.headers
        .get("Content-Type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      throw new ConnectorError(415, "JSON required");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return record(
        await Promise.race([
          readJson(
            request.body,
            new URL(request.url).pathname === "/v1/execute"
              ? 8 * 1024 * 1024
              : MAX_BODY,
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new ConnectorError(408, "Request timed out"));
            }, 10_000);
          }),
        ]),
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async route(request: Request, identity: string): Promise<Response> {
    this.sql.exec(
      "INSERT OR IGNORE INTO connector_identity (id, identity) VALUES (1, ?)",
      identity,
    );
    if (
      this.sql
        .exec("SELECT identity FROM connector_identity WHERE id = 1")
        .toArray()[0]?.identity !== identity
    )
      throw new ConnectorError(403, "Owner does not match connector vault");
    const url = new URL(request.url);
    if (url.search) throw new ConnectorError(400, "Invalid request");
    if (request.method === "GET" && url.pathname === "/v1/capabilities")
      return json({
        google_workspace_delegation: delegationConfigured(this.config),
        google_maps: !!this.config.GOOGLE_MAPS_API_KEY,
      });
    if (request.method === "GET" && url.pathname === "/v1/connections")
      return json({
        connections: this.connections().map((row) => ({
          id: row.id,
          provider: row.provider,
          account: row.account,
          status: row.status,
          created_at: row.created_at,
          services: JSON.parse(String(row.services)),
        })),
      });
    const invocationMatch = /^\/v1\/invocations\/([a-f0-9-]{36})$/i.exec(
      url.pathname,
    );
    if (request.method === "GET" && invocationMatch) {
      const row = this.sql
        .exec(
          "SELECT * FROM connector_invocations WHERE id = ?",
          invocationMatch[1],
        )
        .toArray()[0];
      if (!row) throw new ConnectorError(404, "Invocation not found");
      return json({
        invocation: {
          id: row.id,
          connection_id: row.connection_id,
          status: row.status,
          issued_at: row.issued_at,
          created_at: row.created_at,
          ...(typeof row.result === "string"
            ? { result: record(JSON.parse(row.result)).result }
            : {}),
        },
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/oauth/start")
      return this.start(await this.body(request), identity);
    if (request.method === "POST" && url.pathname === "/v1/oauth/callback")
      return this.callback(await this.body(request), identity);
    if (request.method === "POST" && url.pathname === "/v1/catalog")
      return this.catalog(await this.body(request), identity);
    if (request.method === "POST" && url.pathname === "/v1/execute")
      return this.execute(await this.body(request), identity);
    const connection = /^\/v1\/connections\/([a-zA-Z0-9_-]{1,128})$/.exec(
      url.pathname,
    );
    if (request.method === "DELETE" && connection)
      return this.disconnect(connection[1], identity);
    throw new ConnectorError(404, "Not found");
  }

  private connections(): Record<string, unknown>[] {
    return this.sql
      .exec(
        "SELECT id, provider, account, status, created_at, services FROM connector_connections ORDER BY created_at, id",
      )
      .toArray();
  }

  private provider(id: unknown): ServiceProvider {
    const provider =
      typeof id === "string"
        ? (this.dependencies.providers ?? SERVICE_PROVIDERS).get(id)
        : undefined;
    if (!provider)
      throw new ConnectorError(400, "Unsupported connector provider");
    return provider;
  }

  private configured(provider: ServiceProvider): void {
    const oauth = provider.oauth(this.config);
    if (
      (this.config.CONNECTOR_CREDENTIALS_SECRET ?? "").length < 32 ||
      !oauth.clientId ||
      !oauth.clientSecret ||
      !provider.scopes.length
    )
      throw new ConnectorError(503, "Connector configuration required");
    for (const address of [
      oauth.redirectUri,
      provider.authorizationEndpoint,
      provider.tokenEndpoint,
      provider.revokeEndpoint,
      provider.profileEndpoint,
    ]) {
      const url = new URL(address);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      )
        throw new ConnectorError(503, "Connector configuration required");
    }
    if (
      !new URL(oauth.redirectUri).pathname.startsWith("/api/connectors/") ||
      !new URL(oauth.redirectUri).pathname.endsWith("/callback")
    )
      throw new ConnectorError(503, "Connector configuration required");
  }

  private async aesKey(identity: string, id: string): Promise<CryptoKey> {
    if ((this.config.CONNECTOR_CREDENTIALS_SECRET ?? "").length < 32)
      throw new ConnectorError(503, "Connector configuration required");
    const root = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.config.CONNECTOR_CREDENTIALS_SECRET),
      "HKDF",
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: encoder.encode(identity),
        info: encoder.encode(`durableclaw-connector-key-v1:${id}`),
      },
      root,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  }
  private aad(
    identity: string,
    id: string,
    provider: string,
  ): Uint8Array<ArrayBuffer> {
    return encoder.encode(
      JSON.stringify(["durableclaw-connector-v1", identity, id, provider]),
    );
  }
  private async seal(
    value: unknown,
    identity: string,
    id: string,
    provider: string,
  ): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: this.aad(identity, id, provider) },
      await this.aesKey(identity, id),
      encoder.encode(JSON.stringify(value)),
    );
    return JSON.stringify({
      v: 1,
      iv: base64url(iv),
      ciphertext: base64url(new Uint8Array(ciphertext)),
    });
  }
  private async open(
    sealed: string,
    identity: string,
    id: string,
    provider: string,
  ): Promise<Record<string, unknown>> {
    const envelope = record(JSON.parse(sealed));
    if (
      envelope.v !== 1 ||
      typeof envelope.iv !== "string" ||
      typeof envelope.ciphertext !== "string"
    )
      throw new Error("Invalid ciphertext");
    const cleartext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unbase64url(envelope.iv),
        additionalData: this.aad(identity, id, provider),
      },
      await this.aesKey(identity, id),
      unbase64url(envelope.ciphertext),
    );
    return record(JSON.parse(new TextDecoder().decode(cleartext)));
  }

  private async start(
    input: Record<string, unknown>,
    identity: string,
  ): Promise<Response> {
    const provider = this.provider(input.provider);
    const grant = provider.grant
      ? provider.grant(input, this.config)
      : { services: [provider.id], scopes: [...provider.scopes] };
    if (!provider.grant) fields(input, ["provider"]);
    this.configured(provider);
    const oauth = provider.oauth(this.config);
    const now = this.dependencies.now();
    this.sql.exec("DELETE FROM connector_pending WHERE expires_at <= ?", now);
    if (this.connections().length >= 20)
      throw new ConnectorError(
        409,
        "Connection limit reached; disconnect an account first",
      );
    if (
      this.sql.exec("SELECT state_hash FROM connector_pending").toArray()
        .length >= 5
    )
      throw new ConnectorError(429, "Too many pending connections");
    const state = randomToken();
    const verifier = randomToken();
    const id = crypto.randomUUID();
    const expires = now + OAUTH_TTL;
    this.sql.exec(
      "INSERT INTO connector_pending (state_hash, connection_id, provider, expires_at, sealed) VALUES (?, ?, ?, ?, ?)",
      await hash(state),
      id,
      provider.id,
      expires,
      await this.seal(
        { verifier, ...grant },
        identity,
        `pending:${id}`,
        provider.id,
      ),
    );
    const url = new URL(provider.authorizationEndpoint);
    url.search = new URLSearchParams({
      ...provider.authorizationParameters,
      client_id: oauth.clientId,
      redirect_uri: oauth.redirectUri,
      response_type: "code",
      scope: grant.scopes.join(" "),
      state,
      code_challenge: await hash(verifier),
      code_challenge_method: "S256",
    }).toString();
    return json({ authorization_url: url.toString(), expires_at: expires });
  }

  private async token(
    provider: ServiceProvider,
    requestedScopes: readonly string[],
    services: readonly string[],
    form: URLSearchParams,
    previous?: Credentials,
  ): Promise<Credentials> {
    const oauth = provider.oauth(this.config);
    form.set("client_id", oauth.clientId);
    form.set("client_secret", oauth.clientSecret);
    let upstream: { response: Response; body: unknown };
    try {
      upstream = await boundedJsonRequest(
        this.dependencies.fetch,
        new Request(provider.tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
        }),
        MAX_BODY,
      );
    } catch {
      throw new ConnectorError(502, "Provider authorization unavailable");
    }
    const body = record(upstream.body);
    if (!upstream.response.ok) {
      if (body.error === "invalid_grant" && previous)
        throw new ConnectorError(409, "Connector reauthorization required");
      throw new ConnectorError(502, "Provider authorization failed");
    }
    const scopes =
      typeof body.scope === "string"
        ? body.scope.split(/\s+/).filter(Boolean).map(normalizeScope)
        : previous
          ? [...requestedScopes]
          : [];
    if (
      scopes.length !== requestedScopes.length ||
      !requestedScopes.every((scope) =>
        scopes.includes(normalizeScope(scope)),
      ) ||
      body.token_type !== "Bearer" ||
      !Number.isInteger(body.expires_in) ||
      Number(body.expires_in) < 60 ||
      Number(body.expires_in) > 86_400
    )
      throw new ConnectorError(502, "Provider returned invalid authorization");
    const access = body.access_token;
    const refresh = body.refresh_token ?? previous?.refresh_token;
    if (
      typeof access !== "string" ||
      access.length < 1 ||
      access.length > 8192 ||
      typeof refresh !== "string" ||
      refresh.length < 1 ||
      refresh.length > 8192 ||
      /[\u0000-\u0020\u007f]/u.test(access + refresh)
    )
      throw new ConnectorError(502, "Provider returned invalid authorization");
    return {
      account: previous?.account ?? "",
      subject: previous?.subject ?? "",
      access_token: access,
      refresh_token: refresh,
      expires_at: this.dependencies.now() + Number(body.expires_in) * 1000,
      scopes: [...requestedScopes],
      services: [...services],
    };
  }

  private async callback(
    input: Record<string, unknown>,
    identity: string,
  ): Promise<Response> {
    fields(input, ["state", "code", "error"]);
    if (
      typeof input.state !== "string" ||
      !/^[a-zA-Z0-9_-]{43}$/.test(input.state)
    )
      throw new ConnectorError(400, "Invalid or expired OAuth state");
    const stateHash = await hash(input.state);
    const pending = this.sql
      .exec(
        "DELETE FROM connector_pending WHERE state_hash = ? RETURNING *",
        stateHash,
      )
      .toArray()[0];
    if (!pending || Number(pending.expires_at) <= this.dependencies.now())
      throw new ConnectorError(400, "Invalid or expired OAuth state");
    if (input.error !== undefined)
      throw new ConnectorError(400, "Provider connection was not authorized");
    const provider = this.provider(pending.provider);
    this.configured(provider);
    const code = textValue(input.code, 8192);
    const id = String(pending.connection_id);
    const { verifier, scopes, services } = await this.open(
      String(pending.sealed),
      identity,
      `pending:${id}`,
      provider.id,
    );
    if (
      typeof verifier !== "string" ||
      !Array.isArray(scopes) ||
      !scopes.every((item) => typeof item === "string") ||
      !Array.isArray(services) ||
      !services.every((item) => typeof item === "string")
    )
      throw new Error("Invalid pending state");
    const credentials = await this.token(
      provider,
      scopes,
      services,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: provider.oauth(this.config).redirectUri,
      }),
    );
    let account: string;
    let subject: string;
    try {
      const profile = await boundedJsonRequest(
        this.dependencies.fetch,
        new Request(provider.profileEndpoint, {
          headers: { Authorization: `Bearer ${credentials.access_token}` },
        }),
        MAX_BODY,
      );
      if (!profile.response.ok) throw new Error("Profile failed");
      account = textValue(provider.account(profile.body), 320);
      subject = provider.subject
        ? textValue(provider.subject(profile.body), 255)
        : account;
    } catch {
      throw new ConnectorError(502, "Could not verify provider account");
    }
    provider.validateAccount?.(account, services as string[], this.config);
    credentials.account = account;
    credentials.subject = subject;
    const existing = this.sql
      .exec(
        "SELECT id FROM connector_connections WHERE provider = ? AND subject = ?",
        provider.id,
        subject,
      )
      .toArray()[0];
    if (!existing && this.connections().length >= 20)
      throw new ConnectorError(
        409,
        "Connection limit reached; disconnect an account first",
      );
    const connectionId = existing ? String(existing.id) : id;
    const sealed = await this.seal(
      credentials,
      identity,
      connectionId,
      provider.id,
    );
    this.sql.exec(
      "INSERT INTO connector_connections (id, provider, account, subject, status, created_at, services, sealed) VALUES (?, ?, ?, ?, 'connected', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET account = excluded.account, status = 'connected', services = excluded.services, sealed = excluded.sealed",
      connectionId,
      provider.id,
      account,
      subject,
      this.dependencies.now(),
      JSON.stringify(services),
      sealed,
    );
    return json({ connected: true, connection_id: connectionId });
  }

  private async credentials(
    id: string,
    identity: string,
    provider: ServiceProvider,
  ): Promise<Credentials> {
    const row = this.sql
      .exec("SELECT * FROM connector_connections WHERE id = ?", id)
      .toArray()[0];
    if (!row) throw new ConnectorError(404, "Connection not found");
    if (row.status !== "connected")
      throw new ConnectorError(409, "Connector reauthorization required");
    const value = await this.open(
      String(row.sealed),
      identity,
      id,
      provider.id,
    );
    if (
      typeof value.account !== "string" ||
      !value.account ||
      typeof value.subject !== "string" ||
      !value.subject ||
      typeof value.access_token !== "string" ||
      typeof value.refresh_token !== "string" ||
      typeof value.expires_at !== "number" ||
      !Array.isArray(value.scopes) ||
      !value.scopes.every((item) => typeof item === "string") ||
      !Array.isArray(value.services) ||
      !value.services.every((item) => typeof item === "string")
    )
      throw new Error("Invalid credentials");
    let credentials: Credentials = {
      account: value.account,
      subject: value.subject,
      access_token: value.access_token,
      refresh_token: value.refresh_token,
      expires_at: value.expires_at,
      scopes: value.scopes as string[],
      services: value.services as string[],
    };
    if (credentials.expires_at <= this.dependencies.now() + 60_000) {
      try {
        credentials = await this.token(
          provider,
          credentials.scopes,
          credentials.services,
          new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: credentials.refresh_token,
          }),
          credentials,
        );
      } catch (error) {
        if (error instanceof ConnectorError && error.status === 409)
          this.sql.exec(
            "UPDATE connector_connections SET status = 'reauth_required' WHERE id = ?",
            id,
          );
        throw error;
      }
      this.sql.exec(
        "UPDATE connector_connections SET sealed = ? WHERE id = ?",
        await this.seal(credentials, identity, id, provider.id),
        id,
      );
    }
    return credentials;
  }

  private async execute(
    input: Record<string, unknown>,
    identity: string,
  ): Promise<Response> {
    fields(input, [
      "connection_id",
      "operation",
      "arguments",
      "invocation_id",
      "issued_at",
    ]);
    const id = textValue(input.connection_id, 128);
    const row = this.sql
      .exec(
        "SELECT provider, account FROM connector_connections WHERE id = ?",
        id,
      )
      .toArray()[0];
    if (!row) throw new ConnectorError(404, "Connection not found");
    const provider = this.provider(row.provider);
    this.configured(provider);
    const execution = provider.validateOperation(
      input.operation,
      input.arguments,
    );
    const credentials = await this.credentials(id, identity, provider);
    provider.authorizeExecution?.(execution, credentials.services);
    const invocation = provider.requiresConfirmation(execution)
      ? await this.reserve(input, identity)
      : undefined;
    if (invocation instanceof Response) return invocation;
    try {
      const accessToken = provider.executionToken
        ? await provider.executionToken(
            execution,
            this.config,
            credentials.account,
            credentials.subject,
            credentials.access_token,
            (request) =>
              boundedJsonRequest(this.dependencies.fetch, request, MAX_BODY),
            this.dependencies.now(),
          )
        : credentials.access_token;
      const prepared = provider.prepareExecution(
        execution,
        accessToken,
        credentials.account,
        this.config,
      );
      let upstream: { response: Response; body: unknown };
      try {
        const address = new URL(prepared.request.url);
        if (
          prepared.transport === "http" &&
          (address.protocol !== "https:" ||
            !provider.apiOrigins.includes(address.origin) ||
            address.username ||
            address.password ||
            address.hash)
        )
          throw new Error("Unapproved provider endpoint");
        upstream = await boundedJsonRequest(
          prepared.transport === "native"
            ? this.dependencies.native
            : this.dependencies.fetch,
          prepared.request,
          input.operation === "gog_execute" ? 8 * 1024 * 1024 : MAX_RESULT,
          45_000,
        );
      } catch {
        if (invocation)
          this.sql.exec(
            "UPDATE connector_invocations SET status = 'unknown' WHERE id = ?",
            invocation,
          );
        throw new ConnectorError(
          502,
          "Connector request outcome unavailable; never retry an uncertain action automatically",
        );
      }
      // An email deleted between the bounded list and metadata read must not
      // permanently block a heartbeat page. This exception is read-only and
      // returns no provider error content; other failures still fail closed.
      if (
        execution.operation === "gmail_get_event" &&
        upstream.response.status === 404
      )
        return json({ result: { missing: true } });
      if (!upstream.response.ok) {
        if (invocation)
          this.sql.exec(
            "UPDATE connector_invocations SET status = 'unknown' WHERE id = ?",
            invocation,
          );
        const cleanup = cleanupWarnings(
          upstream.body && typeof upstream.body === "object"
            ? (upstream.body as Record<string, unknown>).cleanup_required
            : undefined,
        );
        if (
          invocation &&
          cleanup &&
          ![
            credentials.access_token,
            accessToken,
            credentials.refresh_token,
            provider.oauth(this.config).clientSecret,
            this.config.CONNECTOR_CREDENTIALS_SECRET,
            this.config.GOOGLE_MAPS_API_KEY,
          ].some((secret) => secret && JSON.stringify(cleanup).includes(secret))
        )
          this.storeCleanup(invocation, cleanup);
        throw new ConnectorError(
          502,
          "Connector request failed; do not repeat an uncertain action",
        );
      }
      const output =
        prepared.result === "json"
          ? { result: upstream.body }
          : record(upstream.body);
      if (!Object.hasOwn(output, "result") || Object.keys(output).length !== 1)
        throw new ConnectorError(502, "Connector returned an invalid result");
      const serialized = JSON.stringify(output);
      if (
        [
          credentials.access_token,
          accessToken,
          credentials.refresh_token,
          provider.oauth(this.config).clientSecret,
          this.config.CONNECTOR_CREDENTIALS_SECRET,
          this.config.GOOGLE_MAPS_API_KEY,
        ].some((secret) => secret && serialized.includes(secret))
      )
        throw new ConnectorError(502, "Connector returned an invalid result");
      if (invocation) {
        const size = encoder.encode(serialized).byteLength;
        const total = Number(
          this.sql
            .exec(
              "SELECT COALESCE(SUM(length(CAST(result AS BLOB))),0) AS bytes FROM connector_invocations",
            )
            .toArray()[0].bytes,
        );
        this.sql.exec(
          "UPDATE connector_invocations SET status = 'completed', result = ? WHERE id = ?",
          size <= 512 * 1024 && total + size <= 32 * 1024 * 1024
            ? serialized
            : null,
          invocation,
        );
      }
      return json(output);
    } catch (error) {
      if (error instanceof ConnectorError && error.status === 409)
        this.sql.exec(
          "UPDATE connector_connections SET status = 'reauth_required' WHERE id = ?",
          id,
        );
      if (invocation)
        this.sql.exec(
          "UPDATE connector_invocations SET status = 'unknown' WHERE id = ? AND status = 'running'",
          invocation,
        );
      throw error;
    }
  }

  private storeCleanup(invocation: string, cleanup: CleanupWarning[]): void {
    const serialized = JSON.stringify({
      result: { cleanup_required: cleanup },
    });
    const size = encoder.encode(serialized).byteLength;
    let total = Number(
      this.sql
        .exec(
          "SELECT COALESCE(SUM(length(CAST(result AS BLOB))),0) AS bytes FROM connector_invocations",
        )
        .toArray()[0].bytes,
    );
    // Cleanup records are <= ~2.2 KiB * 10,000 tombstones, below the 32 MiB
    // receipt budget. Evict only ordinary completed results to preserve them.
    while (total + size > 32 * 1024 * 1024) {
      const oldest = this.sql
        .exec(
          "SELECT id,length(CAST(result AS BLOB)) AS bytes FROM connector_invocations WHERE status = 'completed' AND result IS NOT NULL ORDER BY created_at LIMIT 1",
        )
        .toArray()[0];
      if (!oldest)
        throw new ConnectorError(502, "Cleanup receipt storage unavailable");
      this.sql.exec(
        "UPDATE connector_invocations SET result = NULL WHERE id = ?",
        String(oldest.id),
      );
      total -= Number(oldest.bytes);
    }
    this.sql.exec(
      "UPDATE connector_invocations SET result = ? WHERE id = ? AND status = 'unknown'",
      serialized,
      invocation,
    );
  }

  private async reserve(
    input: Record<string, unknown>,
    identity: string,
  ): Promise<string | Response> {
    const id = textValue(input.invocation_id, 128);
    if (
      !/^[a-f0-9-]{36}$/i.test(id) ||
      typeof input.issued_at !== "number" ||
      !Number.isSafeInteger(input.issued_at)
    )
      throw new ConnectorError(400, "Confirmed invocation required");
    const stable = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(stable)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => [key, stable(item)]),
            )
          : value;
    const digest = await hash(
      JSON.stringify(
        stable([
          identity,
          input.connection_id,
          input.operation,
          input.arguments,
          input.issued_at,
        ]),
      ),
    );
    const existing = this.sql
      .exec("SELECT * FROM connector_invocations WHERE id = ?", id)
      .toArray()[0];
    if (existing) {
      if (existing.digest !== digest)
        throw new ConnectorError(
          409,
          "Invocation was already used for different arguments",
        );
      if (
        existing.status === "completed" &&
        typeof existing.result === "string"
      )
        return json(JSON.parse(existing.result));
      throw new ConnectorError(
        409,
        existing.status === "completed"
          ? "Action already completed; saved result unavailable. Do not repeat it."
          : "Action outcome is unknown; do not retry it automatically.",
      );
    }
    const age = this.dependencies.now() - input.issued_at;
    if (age > 5 * 60_000 || age < -30_000)
      throw new ConnectorError(
        400,
        "Confirmation expired; approve a fresh request",
      );
    if (
      Number(
        this.sql
          .exec("SELECT COUNT(*) AS count FROM connector_invocations")
          .toArray()[0].count,
      ) >= 10_000
    )
      throw new ConnectorError(
        409,
        "Connector invocation history limit reached",
      );
    this.sql.exec(
      "INSERT INTO connector_invocations (id,connection_id,digest,issued_at,status,result,created_at) VALUES (?,?,?,?,'running',NULL,?)",
      id,
      String(input.connection_id),
      digest,
      input.issued_at,
      this.dependencies.now(),
    );
    return id;
  }

  private async catalog(
    input: Record<string, unknown>,
    identity: string,
  ): Promise<Response> {
    fields(input, ["service", "command", "cursor", "limit"]);
    if (
      input.service !== undefined &&
      !/^[a-z][a-z0-9-]{0,40}$/.test(textValue(input.service, 41))
    )
      throw new ConnectorError(400, "Invalid catalog service");
    if (
      input.command !== undefined &&
      !/^[a-z][a-z0-9.-]{0,199}$/.test(textValue(input.command, 200))
    )
      throw new ConnectorError(400, "Invalid catalog command");
    if (
      input.cursor !== undefined &&
      !/^[0-9]{1,10}$/.test(textValue(input.cursor, 10))
    )
      throw new ConnectorError(400, "Invalid catalog cursor");
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) ||
        Number(input.limit) < 1 ||
        Number(input.limit) > 20)
    )
      throw new ConnectorError(400, "Invalid catalog limit");
    try {
      const upstream = await boundedJsonRequest(
        this.dependencies.native,
        new Request("http://connector/catalog", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
        MAX_RESULT,
        45_000,
      );
      if (!upstream.response.ok) throw new Error("Catalog unavailable");
      const output = record(upstream.body);
      if (!Array.isArray(output.commands)) throw new Error("Invalid catalog");
      return json(output);
    } catch {
      throw new ConnectorError(502, "Connector catalog unavailable");
    }
  }

  private async disconnect(id: string, identity: string): Promise<Response> {
    const row = this.sql
      .exec(
        "DELETE FROM connector_connections WHERE id = ? RETURNING sealed, provider",
        id,
      )
      .toArray()[0];
    if (!row) throw new ConnectorError(404, "Connection not found");
    // Delete durably before best-effort remote revocation. A failed/slow provider can never retain local access.
    let revoked = false;
    try {
      const provider = this.provider(row.provider);
      const credentials = await this.open(
        String(row.sealed),
        identity,
        id,
        provider.id,
      );
      if (typeof credentials.refresh_token !== "string")
        throw new Error("Invalid credentials");
      const { response } = await boundedJsonRequest(
        this.dependencies.fetch,
        new Request(provider.revokeEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: credentials.refresh_token }),
        }),
        MAX_BODY,
        12_000,
        false,
      );
      revoked = response.ok;
    } catch {
      /* Local deletion is authoritative; the UI reports whether Google confirmed revocation. */
    }
    return json({ disconnected: true, revoked });
  }
}

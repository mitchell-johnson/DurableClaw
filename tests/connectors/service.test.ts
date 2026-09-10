import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteStorage } from "../helpers/sqlite";
import { createInternalAuthHeaders } from "../../src/utils/internalAuth";
import {
  ConnectorService,
  connectorObjectName,
  type ConnectorConfig,
} from "../../services/connectors/src/core";
import {
  gmailProvider,
  type ServiceProvider,
} from "../../services/connectors/src/providers";
import { ConnectorError } from "../../services/connectors/src/validation";
afterEach(() => {
  vi.useRealTimers();
});

const principal = {
  userId: "owner",
  organizationId: "default",
  tenantBinding: "default",
  role: "owner",
};
const config: ConnectorConfig = {
  CONNECTOR_AUTH_SECRET: "internal-secret-with-at-least-32-bytes",
  CONNECTOR_CREDENTIALS_SECRET: "credential-secret-with-at-least-32-bytes",
  GOOGLE_CLIENT_ID: "client.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_REDIRECT_URI: "https://app.example/api/connectors/google/callback",
};
function harness(providers?: ReadonlyMap<string, ServiceProvider>) {
  const sql = createSqliteStorage();
  let now = Date.now();
  const fetcher = vi.fn(async (request: Request) => {
    if (request.url === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      });
    if (
      request.url === "https://gmail.googleapis.com/gmail/v1/users/me/profile"
    )
      return Response.json({ emailAddress: "owner@example.com" });
    if (request.url === "https://oauth2.googleapis.com/revoke")
      return new Response(null, { status: 200 });
    throw new Error("unexpected fetch");
  });
  const native = vi.fn(async (request: Request) =>
    Response.json({ result: { messages: [{ id: "abc" }] } }),
  );
  const service = new ConnectorService(sql, config, {
    providers,
    fetch: fetcher,
    native,
    now: () => now,
  });
  async function call(
    path: string,
    body?: unknown,
    method = body ? "POST" : "GET",
    who = principal,
  ) {
    return service.fetch(
      new Request(`https://connector.internal${path}`, {
        method,
        headers: await createInternalAuthHeaders(
          who,
          config.CONNECTOR_AUTH_SECRET,
        ),
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  }
  async function start() {
    const response = await call("/v1/oauth/start", { provider: "gmail" });
    const data = (await response.json()) as {
      authorization_url: string;
      expires_at: number;
    };
    return {
      response,
      ...data,
      state: new URL(data.authorization_url).searchParams.get("state")!,
    };
  }
  async function connect() {
    const oauth = await start();
    const response = await call("/v1/oauth/callback", {
      state: oauth.state,
      code: "google-code",
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { connection_id: string }).connection_id;
  }
  return {
    sql,
    service,
    fetcher,
    native,
    call,
    start,
    connect,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("private connector service", () => {
  it("executes authenticated heartbeat reads with fixed GETs, no native command, and safe deleted-message handling", async () => {
    const h = harness();
    const connectionId = await h.connect();
    h.fetcher.mockImplementation(async (request) => {
      const url = new URL(request.url);
      expect(url.origin).toBe("https://gmail.googleapis.com");
      expect(request.method).toBe("GET");
      expect(request.headers.get("Authorization")).toBe("Bearer access-secret");
      if (url.pathname.endsWith("/messages"))
        return Response.json({
          messages: [{ id: "abc" }],
          nextPageToken: "next",
        });
      return Response.json(
        { error: "private provider error" },
        { status: 404 },
      );
    });
    const call = (operation: string, args: unknown) =>
      h.call("/v1/execute", {
        connection_id: connectionId,
        operation,
        arguments: args,
      });
    const listed = await call("gmail_list_events", {
      after: 1_800_000_000,
      before: 1_800_003_600,
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      result: { messages: [{ id: "abc" }], nextPageToken: "next" },
    });
    const missing = await call("gmail_get_event", { message_id: "abc" });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ result: { missing: true } });
    expect(h.native).not.toHaveBeenCalled();
    expect(h.sql.exec("SELECT * FROM connector_invocations").toArray()).toEqual(
      [],
    );
    h.fetcher.mockResolvedValue(
      Response.json({ error: "private details" }, { status: 403 }),
    );
    const denied = await call("gmail_get_event", { message_id: "abc" });
    expect(denied.status).toBe(502);
    expect(await denied.text()).not.toContain("private details");
  });
  it("rejects missing authentication and non-owner calls", async () => {
    const h = harness();
    expect(
      (
        await h.service.fetch(
          new Request("https://connector.internal/v1/connections"),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await h.call("/v1/connections", undefined, "GET", {
          ...principal,
          role: "reader",
        })
      ).status,
    ).toBe(403);
  });
  it("pins a credential object to its authenticated owner and workspace", async () => {
    const h = harness();
    expect((await h.call("/v1/connections")).status).toBe(200);
    expect(
      (
        await h.call("/v1/connections", undefined, "GET", {
          ...principal,
          userId: "other",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.call("/v1/connections", undefined, "GET", {
          ...principal,
          tenantBinding: "other",
        })
      ).status,
    ).toBe(403);
  });
  it("creates bounded, expiring PKCE authorization with readonly Gmail only", async () => {
    const h = harness();
    const start = await h.start();
    const url = new URL(start.authorization_url);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.readonly",
    );
    expect(url.searchParams.get("redirect_uri")).toBe(
      config.GOOGLE_REDIRECT_URI,
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(
      /^[a-zA-Z0-9_-]{43}$/,
    );
    expect(start.state).toMatch(/^[a-zA-Z0-9_-]{43}$/);
    for (let i = 0; i < 4; i++)
      expect((await h.start()).response.status).toBe(200);
    expect(
      (await h.call("/v1/oauth/start", { provider: "gmail" })).status,
    ).toBe(429);
    h.advance(10 * 60_000 + 1);
    expect(
      (await h.call("/v1/oauth/callback", { state: start.state, code: "code" }))
        .status,
    ).toBe(400);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("consumes OAuth state exactly once including denied callbacks", async () => {
    const h = harness();
    const { state } = await h.start();
    expect(
      (
        await h.call("/v1/oauth/callback", {
          state: "x".repeat(43),
          code: "code",
        })
      ).status,
    ).toBe(400);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(
      (await h.call("/v1/oauth/callback", { state, error: "access_denied" }))
        .status,
    ).toBe(400);
    expect(
      (await h.call("/v1/oauth/callback", { state, code: "code" })).status,
    ).toBe(400);
    expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("encrypts stored credentials and never returns tokens to the application", async () => {
    const h = harness();
    const id = await h.connect();
    const rows = h.sql.exec("SELECT * FROM connector_connections").toArray();
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain("access-secret");
    expect(stored).not.toContain("refresh-secret");
    const listed = await h.call("/v1/connections");
    expect(await listed.json()).toEqual({
      connections: [
        expect.objectContaining({
          id,
          provider: "gmail",
          account: "owner@example.com",
          status: "connected",
        }),
      ],
    });
    const result = await h.call("/v1/execute", {
      connection_id: id,
      operation: "gmail_search",
      arguments: { query: "is:unread", max: 5 },
    });
    expect(result.status).toBe(200);
    expect(await result.text()).not.toContain("secret");
    const request = h.native.mock.calls[0][0];
    expect(await request.json()).toEqual({
      operation: "gmail_search",
      arguments: { query: "is:unread", max: 5, include_body: false },
      access_token: "access-secret",
    });
  });
  it("fails closed when encrypted credentials are moved to another connection ID", async () => {
    const h = harness();
    const id = await h.connect();
    h.sql.exec(
      "UPDATE connector_connections SET id = ? WHERE id = ?",
      "other-connection",
      id,
    );
    const response = await h.call("/v1/execute", {
      connection_id: "other-connection",
      operation: "gmail_search",
      arguments: { query: "x" },
    });
    expect(response.status).toBe(503);
    expect(h.native).not.toHaveBeenCalled();
    expect(await response.text()).toBe('{"error":"Connector unavailable"}');
  });
  it("serializes refreshes and revocation so disconnected credentials cannot run again", async () => {
    const h = harness();
    const id = await h.connect();
    h.advance(3600_000);
    const execution = {
      connection_id: id,
      operation: "gmail_search",
      arguments: { query: "in:inbox" },
    };
    const results = await Promise.all([
      h.call("/v1/execute", execution),
      h.call("/v1/execute", execution),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(
      h.fetcher.mock.calls.filter(([r]) => r.url.endsWith("/token")),
    ).toHaveLength(2);
    expect(
      (await h.call(`/v1/connections/${id}`, undefined, "DELETE")).status,
    ).toBe(200);
    expect((await h.call("/v1/execute", execution)).status).toBe(404);
    expect(h.sql.exec("SELECT * FROM connector_connections").toArray()).toEqual(
      [],
    );
  });
  it("marks invalid refresh grants for reauthorization without leaking upstream errors", async () => {
    const h = harness();
    const id = await h.connect();
    h.advance(3600_000);
    h.fetcher.mockImplementation(async () =>
      Response.json(
        { error: "invalid_grant", error_description: "refresh-secret" },
        { status: 400 },
      ),
    );
    const response = await h.call("/v1/execute", {
      connection_id: id,
      operation: "gmail_search",
      arguments: { query: "x" },
    });
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("secret");
    expect(
      (
        (await (await h.call("/v1/connections")).json()) as {
          connections: { status: string }[];
        }
      ).connections[0].status,
    ).toBe("reauth_required");
    expect(h.native).not.toHaveBeenCalled();
  });
  it("rejects write operations, unsafe arguments and token-bearing native output", async () => {
    const h = harness();
    const id = await h.connect();
    for (const execution of [
      { operation: "gmail_send", arguments: {} },
      { operation: "gmail_search", arguments: { query: "x", max: 51 } },
      {
        operation: "gmail_search",
        arguments: { query: "x", include_body: true },
      },
      {
        operation: "gmail_get_message",
        arguments: { message_id: "abc", sanitize_content: false },
      },
      {
        operation: "gmail_get_thread",
        arguments: { thread_id: "abc", full: true },
      },
      {
        operation: "gmail_get_thread",
        arguments: { thread_id: "https://evil.example" },
      },
    ]) {
      expect(
        (await h.call("/v1/execute", { connection_id: id, ...execution }))
          .status,
      ).toBe(400);
    }
    expect(h.native).not.toHaveBeenCalled();
    h.native.mockImplementation(async () =>
      Response.json({ result: { unexpected: "access-secret" } }),
    );
    const response = await h.call("/v1/execute", {
      connection_id: id,
      operation: "gmail_search",
      arguments: { query: "x" },
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("access-secret");
  });
  it("rejects extra or missing scopes before persisting an account", async () => {
    const h = harness();
    const { state } = await h.start();
    h.fetcher.mockImplementation(async () =>
      Response.json({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "https://mail.google.com/",
      }),
    );
    expect(
      (await h.call("/v1/oauth/callback", { state, code: "code" })).status,
    ).toBe(502);
    expect(h.sql.exec("SELECT * FROM connector_connections").toArray()).toEqual(
      [],
    );
  });
  it("derives separate stable namespaces for every signed owner coordinate", async () => {
    const context = { ...principal, ts: Date.now() };
    const original = await connectorObjectName(context);
    expect(await connectorObjectName(context)).toBe(original);
    for (const coordinate of ["userId", "organizationId", "tenantBinding"]) {
      expect(
        await connectorObjectName({ ...context, [coordinate]: "different" }),
      ).not.toBe(original);
    }
  });

  it("rejects forged and stale assertions before accessing storage", async () => {
    const h = harness();
    const headers = await createInternalAuthHeaders(
      principal,
      config.CONNECTOR_AUTH_SECRET,
    );
    headers["X-Internal-Auth"] = headers["X-Internal-Auth"].replace(
      '"owner"',
      '"other"',
    );
    expect(
      (
        await h.service.fetch(
          new Request("https://connector.internal/v1/connections", { headers }),
        )
      ).status,
    ).toBe(401);
    vi.useFakeTimers();
    const oldHeaders = await createInternalAuthHeaders(
      principal,
      config.CONNECTOR_AUTH_SECRET,
    );
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(
      (
        await h.service.fetch(
          new Request("https://connector.internal/v1/connections", {
            headers: oldHeaders,
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      h.sql.exec("SELECT * FROM connector_identity").toArray(),
    ).toHaveLength(0);
  });

  it("preserves encrypted credentials across eviction and binds the PKCE exchange", async () => {
    const h = harness();
    const oauth = await h.start();
    const response = await h.call("/v1/oauth/callback", {
      state: oauth.state,
      code: "google-code",
    });
    const { connection_id } = (await response.json()) as {
      connection_id: string;
    };
    const tokenRequest = h.fetcher.mock.calls[0][0];
    const form = new URLSearchParams(await tokenRequest.text());
    const digest = Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(form.get("code_verifier")!),
      ),
    ).toString("base64url");
    expect(digest).toBe(
      new URL(oauth.authorization_url).searchParams.get("code_challenge"),
    );
    expect(form.get("redirect_uri")).toBe(config.GOOGLE_REDIRECT_URI);
    expect(tokenRequest.redirect).toBe("manual");
    expect(
      (
        await h.call("/v1/oauth/callback", {
          state: oauth.state,
          code: "google-code",
        })
      ).status,
    ).toBe(400);
    const restored = new ConnectorService(h.sql, config, {
      fetch: h.fetcher,
      native: h.native,
      now: Date.now,
    });
    const execution = await restored.fetch(
      new Request("https://connector.internal/v1/execute", {
        method: "POST",
        headers: await createInternalAuthHeaders(
          principal,
          config.CONNECTOR_AUTH_SECRET,
        ),
        body: JSON.stringify({
          connection_id,
          operation: "gmail_get_message",
          arguments: { message_id: "abcd" },
        }),
      }),
    );
    expect(execution.status).toBe(200);
  });

  it("deletes locally when provider revocation fails without exposing its exception", async () => {
    const h = harness();
    const id = await h.connect();
    h.fetcher.mockImplementation(async () => {
      throw new Error("refresh-secret");
    });
    const result = await h.call(`/v1/connections/${id}`, undefined, "DELETE");
    expect(await result.json()).toEqual({ disconnected: true, revoked: false });
    expect(h.sql.exec("SELECT * FROM connector_connections").toArray()).toEqual(
      [],
    );
  });

  it("rejects redirects and oversized container responses without exposing contents", async () => {
    const h = harness();
    const { state } = await h.start();
    h.fetcher.mockImplementation(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.example/refresh-secret" },
        }),
    );
    const redirect = await h.call("/v1/oauth/callback", {
      state,
      code: "google-code",
    });
    expect(redirect.status).toBe(502);
    expect(await redirect.text()).not.toContain("secret");
    const other = harness();
    const id = await other.connect();
    other.native.mockImplementation(async () =>
      Response.json({ result: "x".repeat(257 * 1024) }),
    );
    const oversized = await other.call("/v1/execute", {
      connection_id: id,
      operation: "gmail_search",
      arguments: { query: "in:inbox" },
    });
    expect(oversized.status).toBe(502);
    expect((await oversized.text()).length).toBeLessThan(100);
  });

  it("bounds incoming bodies and rejects unknown fields before any provider call", async () => {
    const h = harness();
    expect(
      (await h.call("/v1/oauth/start", { provider: "gmail", unexpected: "x" }))
        .status,
    ).toBe(400);
    expect(
      (
        await h.call("/v1/oauth/start", {
          provider: "gmail",
          unexpected: "x".repeat(33 * 1024),
        })
      ).status,
    ).toBe(413);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.native).not.toHaveBeenCalled();
  });

  it("supports a second trusted native HTTP provider with separate credentials and operations", async () => {
    const example: ServiceProvider = {
      ...gmailProvider,
      id: "example",
      scopes: ["profile.read"],
      authorizationEndpoint: "https://example.test/authorize",
      tokenEndpoint: "https://example.test/token",
      revokeEndpoint: "https://example.test/revoke",
      profileEndpoint: "https://example.test/profile",
      apiOrigins: ["https://example.test"],
      validateOperation(operation, args) {
        if (operation !== "example_read" || JSON.stringify(args) !== "{}")
          throw new ConnectorError(400, "Unsupported example operation");
        return { operation, arguments: {} };
      },
      prepareExecution() {
        return {
          transport: "http",
          result: "json",
          request: new Request("https://example.test/records"),
        };
      },
    };
    const h = harness(
      new Map([
        ["gmail", gmailProvider],
        ["example", example],
      ]),
    );
    const gmailId = await h.connect();
    h.fetcher.mockImplementation(async (request) => {
      if (request.url === example.tokenEndpoint)
        return Response.json({
          access_token: "example-access",
          refresh_token: "example-refresh",
          scope: "profile.read",
          token_type: "Bearer",
          expires_in: 3600,
        });
      if (request.url === example.profileEndpoint)
        return Response.json({ emailAddress: "owner@example.com" });
      if (request.url === "https://example.test/records")
        return Response.json({ records: [1, 2] });
      throw new Error("Unexpected provider endpoint");
    });
    const start = await h.call("/v1/oauth/start", { provider: "example" });
    const { authorization_url } = (await start.json()) as {
      authorization_url: string;
    };
    const connected = await h.call("/v1/oauth/callback", {
      state: new URL(authorization_url).searchParams.get("state"),
      code: "code",
    });
    const { connection_id } = (await connected.json()) as {
      connection_id: string;
    };
    expect(connection_id).not.toBe(gmailId);
    const execution = await h.call("/v1/execute", {
      connection_id,
      operation: "example_read",
      arguments: {},
    });
    expect(await execution.json()).toEqual({ result: { records: [1, 2] } });
    expect(
      (
        await h.call("/v1/execute", {
          connection_id: gmailId,
          operation: "example_read",
          arguments: {},
        })
      ).status,
    ).toBe(400);
    h.sql.exec(
      "UPDATE connector_connections SET provider = 'gmail' WHERE id = ?",
      connection_id,
    );
    expect(
      (
        await h.call("/v1/execute", {
          connection_id,
          operation: "gmail_search",
          arguments: { query: "x" },
        })
      ).status,
    ).toBe(503);
  });
  it("releases its queue after a stalled provider revocation and never retains credentials", async () => {
    const h = harness();
    const id = await h.connect();
    vi.useFakeTimers();
    let entered!: () => void;
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.fetcher.mockImplementation(() => {
      entered();
      return new Promise<Response>(() => {});
    });
    const disconnect = h.call(`/v1/connections/${id}`, undefined, "DELETE");
    await called;
    await vi.advanceTimersByTimeAsync(12_001);
    expect(await (await disconnect).json()).toEqual({
      disconnected: true,
      revoked: false,
    });
    expect((await h.call("/v1/connections")).status).toBe(200);
    expect(h.sql.exec("SELECT * FROM connector_connections").toArray()).toEqual(
      [],
    );
  });

  it("fails closed if authentication or encryption secrets are absent or weak", async () => {
    const sql = createSqliteStorage();
    const unavailable = new ConnectorService(
      sql,
      { ...config, CONNECTOR_AUTH_SECRET: "" },
      { fetch: vi.fn(), native: vi.fn(), now: Date.now },
    );
    expect(
      (
        await unavailable.fetch(
          new Request("https://connector.internal/v1/connections"),
        )
      ).status,
    ).toBe(503);
    const weak = new ConnectorService(
      sql,
      { ...config, CONNECTOR_CREDENTIALS_SECRET: "short" },
      { fetch: vi.fn(), native: vi.fn(), now: Date.now },
    );
    const start = new Request("https://connector.internal/v1/oauth/start", {
      method: "POST",
      headers: await createInternalAuthHeaders(
        principal,
        config.CONNECTOR_AUTH_SECRET,
      ),
      body: JSON.stringify({ provider: "gmail" }),
    });
    expect((await weak.fetch(start)).status).toBe(503);
    expect(sql.exec("SELECT * FROM connector_pending").toArray()).toEqual([]);
  });
});

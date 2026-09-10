import { describe, expect, it, vi } from "vitest";
import { createSqliteStorage } from "../helpers/sqlite";
import { createInternalAuthHeaders } from "../../src/utils/internalAuth";
import {
  ConnectorService,
  type ConnectorConfig,
} from "../../services/connectors/src/core";
import { googleGrant } from "../../services/connectors/src/google";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { KEEP_SCOPE } from "../../services/connectors/src/delegation";

const principal = {
  userId: "google-owner",
  organizationId: "org",
  tenantBinding: "workspace",
  role: "owner",
};
const config: ConnectorConfig = {
  CONNECTOR_AUTH_SECRET: "connector-auth-with-at-least-32-bytes",
  CONNECTOR_CREDENTIALS_SECRET: "credential-encryption-with-32-bytes",
  GOOGLE_CLIENT_ID: "google-client",
  GOOGLE_CLIENT_SECRET: "google-client-secret",
  GOOGLE_REDIRECT_URI: "https://app.example/api/connectors/google/callback",
};
function fixture(
  services = ["gmail", "drive"],
  overrides: Partial<ConnectorConfig> = {},
) {
  const effectiveConfig = { ...config, ...overrides };
  const sql = createSqliteStorage();
  let now = Date.now();
  const grant = googleGrant({ provider: "google", services });
  const profile = {
    sub: "google-stable-subject",
    email: "owner@example.com",
    email_verified: true,
  };
  const fetcher = vi.fn(async (request: Request) => {
    if (request.url === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "google-access-token",
        refresh_token: "google-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope: grant.scopes.join(" "),
      });
    if (request.url === "https://openidconnect.googleapis.com/v1/userinfo")
      return Response.json(profile);
    throw new Error("Unexpected external request");
  });
  const native = vi.fn(async (request: Request) =>
    request.url.endsWith("/catalog")
      ? Response.json({
          commands: [{ command: "gmail.send", requires_confirmation: true }],
        })
      : Response.json({ result: { output: { sent: true }, files: [] } }),
  );
  const service = new ConnectorService(sql, effectiveConfig, {
    fetch: fetcher,
    native,
    now: () => now,
  });
  async function call(path: string, body?: unknown) {
    return service.fetch(
      new Request(`https://connector.internal${path}`, {
        method: body ? "POST" : "GET",
        headers: await createInternalAuthHeaders(
          principal,
          config.CONNECTOR_AUTH_SECRET,
        ),
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  }
  async function connect() {
    const start = await call("/v1/oauth/start", {
      provider: "google",
      services,
    });
    const { authorization_url } = (await start.json()) as {
      authorization_url: string;
    };
    const connected = await call("/v1/oauth/callback", {
      state: new URL(authorization_url).searchParams.get("state"),
      code: "oauth-code",
    });
    expect(connected.status).toBe(200);
    return ((await connected.json()) as { connection_id: string })
      .connection_id;
  }
  const execution = (connection_id: string) => ({
    connection_id,
    operation: "gog_execute",
    arguments: {
      command: "gmail.send",
      flags: {
        to: "recipient@example.com",
        subject: "Approved test",
        body: "Fixture only",
      },
    },
    invocation_id: crypto.randomUUID(),
    issued_at: now,
  });
  return {
    sql,
    service,
    call,
    connect,
    execution,
    fetcher,
    native,
    profile,
    grant,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Google service authorization and durable command receipts", () => {
  it("preserves bounded cleanup diagnostics on unknown receipts across restart and result pressure", async () => {
    const h = fixture();
    const id = await h.connect();
    const execution = h.execution(id);
    const cleanup = [
      { file_id: "uploaded-image", public_read_permission_may_remain: true },
    ];
    h.native.mockImplementation(async () =>
      Response.json(
        { error: "provider-private-error", cleanup_required: cleanup },
        { status: 502 },
      ),
    );
    h.sql.exec(
      "INSERT INTO connector_invocations (id,connection_id,digest,issued_at,status,result,created_at) VALUES (?,?,?,?,'completed',?,?)",
      crypto.randomUUID(),
      id,
      "old",
      Date.now(),
      "x".repeat(32 * 1024 * 1024),
      0,
    );
    expect((await h.call("/v1/execute", execution)).status).toBe(502);
    const restarted = new ConnectorService(h.sql, config, {
      fetch: h.fetcher,
      native: h.native,
      now: Date.now,
    });
    const read = async (who = principal) =>
      restarted.fetch(
        new Request(
          `https://connector.internal/v1/invocations/${execution.invocation_id}`,
          {
            headers: await createInternalAuthHeaders(
              who,
              config.CONNECTOR_AUTH_SECRET,
            ),
          },
        ),
      );
    const response = await read();
    const body = await response.json();
    expect(body).toMatchObject({
      invocation: { status: "unknown", result: { cleanup_required: cleanup } },
    });
    expect(JSON.stringify(body)).not.toContain("provider-private-error");
    expect((await read({ ...principal, userId: "other-owner" })).status).toBe(
      403,
    );
    expect((await h.call("/v1/execute", execution)).status).toBe(409);
    expect(h.native).toHaveBeenCalledTimes(1);
    expect(
      Number(
        h.sql
          .exec(
            "SELECT SUM(length(CAST(result AS BLOB))) AS bytes FROM connector_invocations",
          )
          .toArray()[0].bytes,
      ),
    ).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
  it("never stores malformed or credential-bearing cleanup metadata", async () => {
    for (const cleanup of [
      [{ file_id: "../other", public_read_permission_may_remain: true }],
      [{ file_id: "file", public_read_permission_may_remain: "true" }],
      [
        {
          file_id: "file",
          public_read_permission_may_remain: true,
          provider_error: "private",
        },
      ],
      [
        {
          file_id: "google-refresh-token",
          public_read_permission_may_remain: true,
        },
      ],
      Array.from({ length: 9 }, () => ({
        file_id: "file",
        public_read_permission_may_remain: true,
      })),
    ]) {
      const h = fixture();
      const id = await h.connect();
      const execution = h.execution(id);
      h.native.mockImplementation(async () =>
        Response.json({ cleanup_required: cleanup }, { status: 502 }),
      );
      expect((await h.call("/v1/execute", execution)).status).toBe(502);
      expect(
        h.sql
          .exec(
            "SELECT result FROM connector_invocations WHERE id = ?",
            execution.invocation_id,
          )
          .toArray()[0].result,
      ).toBeNull();
    }
  });
  it("requires explicit directory and group grants for commands that cross service boundaries", async () => {
    for (const [services, args, requiredService] of [
      [["calendar"], { command: "calendar.users" }, "contacts"],
      [
        ["calendar"],
        { command: "calendar.team", positionals: ["team@example.com"] },
        "groups",
      ],
      [
        ["people"],
        { command: "people.search", positionals: ["name"] },
        "contacts",
      ],
      [
        ["gmail"],
        {
          command: "gmail.search",
          positionals: ["subject:test"],
          flags: { "from-contact": "Name" },
        },
        "contacts",
      ],
    ] as const) {
      const h = fixture([...services]);
      const id = await h.connect();
      expect(
        (await h.call("/v1/execute", { ...h.execution(id), arguments: args }))
          .status,
      ).toBe(403);
      expect(h.native).not.toHaveBeenCalled();
      const allowed = fixture([...services, requiredService]);
      const linked = await allowed.connect();
      expect(
        (
          await allowed.call("/v1/execute", {
            ...allowed.execution(linked),
            arguments: args,
          })
        ).status,
      ).toBe(200);
    }
  });
  it("enforces selected services for generic Discovery calls despite broad token scopes", async () => {
    const h = fixture(["sheets"]);
    const id = await h.connect();
    for (const api of ["gmail", "drive", "admin", "unknown"]) {
      const response = await h.call("/v1/execute", {
        ...h.execution(id),
        arguments: {
          command: "api.call",
          positionals: [api, "v1", "files.list"],
        },
      });
      expect(response.status).toBe(403);
    }
    expect(h.native).not.toHaveBeenCalled();
    for (const api of ["sheets", "bigquery"]) {
      const response = await h.call("/v1/execute", {
        ...h.execution(id),
        arguments: {
          command: "api.call",
          positionals: [api, "v1", "resources.list"],
        },
      });
      expect(response.status).toBe(200);
    }
  });
  it("requests selected service scopes plus verified identity and full Gmail deletion scope", async () => {
    const h = fixture();
    const start = await h.call("/v1/oauth/start", {
      provider: "google",
      services: ["gmail", "drive"],
    });
    const { authorization_url } = (await start.json()) as {
      authorization_url: string;
    };
    const scopes = new URL(authorization_url).searchParams
      .get("scope")!
      .split(" ");
    expect(scopes).toContain("https://mail.google.com/");
    expect(scopes).toContain("https://www.googleapis.com/auth/drive");
    expect(scopes).toContain("openid");
    expect(scopes).not.toContain("https://www.googleapis.com/auth/calendar");
    expect(
      (
        await h.call("/v1/oauth/start", {
          provider: "google",
          services: ["invented-service"],
        })
      ).status,
    ).toBe(400);
  });

  it("uses BigQuery scope only for selected Sheets and excludes DWD-only sharing from user OAuth", () => {
    const sheets = googleGrant({ provider: "google", services: ["sheets"] });
    expect(sheets.scopes).toContain(
      "https://www.googleapis.com/auth/bigquery.readonly",
    );
    const gmail = googleGrant({ provider: "google", services: ["gmail"] });
    expect(gmail.scopes).not.toContain(
      "https://www.googleapis.com/auth/bigquery.readonly",
    );
    expect(gmail.scopes).not.toContain(
      "https://www.googleapis.com/auth/gmail.settings.sharing",
    );
    expect(gmail.scopes).toContain(
      "https://www.googleapis.com/auth/gmail.settings.basic",
    );
  });

  it("delegates only Gmail sharing settings to the verified owner with exact scopes", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const credentials = JSON.stringify({
      type: "service_account",
      client_email: "connector@project.iam.gserviceaccount.com",
      private_key: await exportPKCS8(privateKey),
    });
    const h = fixture(["gmail"], {
      GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON: credentials,
      GOOGLE_WORKSPACE_DOMAIN: "example.com",
    });
    const id = await h.connect();
    let assertions = 0;
    h.fetcher.mockImplementation(async (request) => {
      if (request.url === "https://openidconnect.googleapis.com/v1/userinfo") {
        expect(request.headers.get("Authorization")).toBe(
          "Bearer google-access-token",
        );
        return Response.json(h.profile);
      }
      expect(request.url).toBe("https://oauth2.googleapis.com/token");
      const form = new URLSearchParams(await request.text());
      const { payload } = await jwtVerify(form.get("assertion")!, publicKey, {
        algorithms: ["RS256"],
        issuer: "connector@project.iam.gserviceaccount.com",
        audience: "https://oauth2.googleapis.com/token",
      });
      expect(payload.sub).toBe("owner@example.com");
      expect(payload.scope).toBe(
        "https://www.googleapis.com/auth/gmail.settings.basic https://www.googleapis.com/auth/gmail.settings.sharing",
      );
      assertions++;
      return Response.json({
        access_token: "gmail-delegated-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: payload.scope,
      });
    });
    for (const args of [
      { command: "gmail.settings.delegates.list" },
      {
        command: "gmail.settings.forwarding.create",
        positionals: ["forward@example.com"],
      },
      {
        command: "gmail.settings.sendas.update",
        positionals: ["alias@example.com"],
      },
      ...[
        "users.settings.delegates.list",
        "users.settings.sendAs.update",
        "users.settings.sendAs.patch",
      ].flatMap((method) =>
        ["", "gmail."].map((prefix) => ({
          command: "api.call",
          positionals: ["gmail", "v1", prefix + method],
          flags: {
            params: '{"userId":"me","sendAsEmail":"alias@example.com"}',
          },
        })),
      ),
    ]) {
      expect(
        (await h.call("/v1/execute", { ...h.execution(id), arguments: args }))
          .status,
      ).toBe(200);
    }
    expect(assertions).toBe(9);
    expect(
      h.fetcher.mock.calls.filter(
        ([request]) =>
          request.url === "https://openidconnect.googleapis.com/v1/userinfo",
      ),
    ).toHaveLength(10);
    for (const call of h.native.mock.calls) {
      const wire = await call[0].text();
      expect(wire).toContain("gmail-delegated-token");
      expect(wire).not.toContain("PRIVATE KEY");
      expect(wire).not.toContain("google-refresh-token");
    }
    expect((await h.call("/v1/execute", h.execution(id))).status).toBe(200);
    expect(
      (
        await h.call("/v1/execute", {
          ...h.execution(id),
          arguments: {
            command: "gmail.settings.sendas.update",
            positionals: ["owner@example.com"],
          },
        })
      ).status,
    ).toBe(200);
    for (const method of [
      "users.settings.sendAs.update",
      "users.settings.sendAs.patch",
    ])
      for (const prefix of ["", "gmail."])
        expect(
          (
            await h.call("/v1/execute", {
              ...h.execution(id),
              arguments: {
                command: "api.call",
                positionals: ["gmail", "v1", prefix + method],
                flags: {
                  params: '{"userId":"me","sendAsEmail":"owner@example.com"}',
                },
              },
            })
          ).status,
        ).toBe(200);
    expect(assertions).toBe(9);
    for (const call of h.native.mock.calls.slice(9))
      expect(
        ((await call[0].json()) as Record<string, unknown>).access_token,
      ).toBe("google-access-token");
  });

  it("rejects abbreviated and full delegated API methods without configuration or when account identity changes", async () => {
    for (const method of [
      "users.settings.delegates.list",
      "users.settings.sendAs.update",
      "users.settings.sendAs.patch",
    ]) {
      for (const prefix of ["", "gmail."]) {
        for (const changed of [false, true]) {
          const h = fixture(
            ["gmail"],
            changed
              ? {
                  GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON: "configured",
                  GOOGLE_WORKSPACE_DOMAIN: "example.com",
                }
              : {},
          );
          const id = await h.connect();
          if (changed) h.profile.sub = "reassigned-account";
          const response = await h.call("/v1/execute", {
            ...h.execution(id),
            arguments: {
              command: "api.call",
              positionals: ["gmail", "v1", prefix + method],
              flags: {
                params: '{"userId":"me","sendAsEmail":"alias@example.com"}',
              },
            },
          });
          expect(response.status).toBe(changed ? 409 : 503);
          expect(h.native).not.toHaveBeenCalled();
          expect(
            h.fetcher.mock.calls.filter(
              ([request]) =>
                request.url === "https://oauth2.googleapis.com/token",
            ),
          ).toHaveLength(1);
        }
      }
    }
  });

  it("rejects delegated Gmail settings without configuration, domain consent, or the Gmail grant", async () => {
    for (const [services, overrides, command, expected] of [
      [["gmail"], {}, "gmail.settings.delegates.list", 503],
      [
        ["gmail"],
        {
          GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON: "configured",
          GOOGLE_WORKSPACE_DOMAIN: "other.example",
        },
        "gmail.settings.forwarding.create",
        403,
      ],
      [
        ["drive"],
        {
          GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON: "configured",
          GOOGLE_WORKSPACE_DOMAIN: "example.com",
        },
        "api.call",
        403,
      ],
    ] as const) {
      const h = fixture([...services], overrides);
      const id = await h.connect();
      const request = {
        ...h.execution(id),
        arguments: {
          command,
          positionals:
            command === "api.call"
              ? ["gmail", "v1", "gmail.users.settings.delegates.list"]
              : ["forward@example.com"],
        },
      };
      expect((await h.call("/v1/execute", request)).status).toBe(expected);
      expect(h.native).not.toHaveBeenCalled();
      expect(
        h.fetcher.mock.calls.filter(
          ([request]) => request.url === "https://oauth2.googleapis.com/token",
        ),
      ).toHaveLength(1);
    }
  });

  it("revalidates immutable identity before delegation to prevent renamed or reassigned Workspace users", async () => {
    for (const changed of [
      { email: "renamed@example.com" },
      { sub: "replacement-account-subject" },
      { email_verified: false },
    ]) {
      const h = fixture(["keep"], {
        GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON: "configured",
        GOOGLE_WORKSPACE_DOMAIN: "example.com",
      });
      const id = await h.connect();
      Object.assign(h.profile, changed);
      // Public metadata must not become an authority for a delegated subject.
      h.sql.exec(
        "UPDATE connector_connections SET account = ?, subject = ? WHERE id = ?",
        h.profile.email,
        h.profile.sub,
        id,
      );
      const response = await h.call("/v1/execute", {
        ...h.execution(id),
        arguments: { command: "keep.notes.list" },
      });
      expect(response.status).toBe(409);
      expect(h.native).not.toHaveBeenCalled();
      expect(
        h.fetcher.mock.calls.filter(
          ([request]) => request.url === "https://oauth2.googleapis.com/token",
        ),
      ).toHaveLength(1);
      expect(
        h.sql
          .exec("SELECT status FROM connector_connections WHERE id = ?", id)
          .toArray()[0].status,
      ).toBe("reauth_required");
    }
  });

  it("requires confirmation for generic commands and never dispatches a replay twice", async () => {
    const h = fixture();
    const id = await h.connect();
    const request = h.execution(id);
    expect(
      (
        await h.call("/v1/execute", {
          connection_id: id,
          operation: "gog_execute",
          arguments: request.arguments,
        })
      ).status,
    ).toBe(400);
    const first = await h.call("/v1/execute", request);
    const second = await h.call("/v1/execute", request);
    expect(first.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(h.native).toHaveBeenCalledTimes(1);
    expect(await h.native.mock.calls[0][0].json()).toEqual({
      operation: "gog_execute",
      arguments: request.arguments,
      access_token: "google-access-token",
      account_email: "owner@example.com",
      confirmed: true,
    });
    const receipt = await h.call(`/v1/invocations/${request.invocation_id}`);
    expect(await receipt.json()).toEqual({
      invocation: expect.objectContaining({
        id: request.invocation_id,
        status: "completed",
        result: { output: { sent: true }, files: [] },
      }),
    });
  });

  it("rejects changed arguments, expired approvals, and ungranted services", async () => {
    const h = fixture();
    const id = await h.connect();
    const request = h.execution(id);
    expect((await h.call("/v1/execute", request)).status).toBe(200);
    expect(
      (
        await h.call("/v1/execute", {
          ...request,
          arguments: {
            command: "gmail.send",
            flags: { to: "other@example.com" },
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await h.call("/v1/execute", {
          ...h.execution(id),
          issued_at: Date.now() - 6 * 60_000,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await h.call("/v1/execute", {
          ...h.execution(id),
          arguments: { command: "calendar.events.insert" },
        })
      ).status,
    ).toBe(403);
    expect(h.native).toHaveBeenCalledTimes(1);
  });

  it("records ambiguous command outcomes durably and never automatically reruns them", async () => {
    const h = fixture();
    const id = await h.connect();
    const request = h.execution(id);
    h.native.mockImplementation(async () => {
      throw new Error("google-access-token");
    });
    const first = await h.call("/v1/execute", request);
    expect(first.status).toBe(502);
    expect(await first.text()).not.toContain("google-access-token");
    expect((await h.call("/v1/execute", request)).status).toBe(409);
    expect(h.native).toHaveBeenCalledTimes(1);
    expect(
      await (await h.call(`/v1/invocations/${request.invocation_id}`)).json(),
    ).toEqual({ invocation: expect.objectContaining({ status: "unknown" }) });
    h.sql.exec(
      "UPDATE connector_invocations SET status = 'running' WHERE id = ?",
      request.invocation_id,
    );
    new ConnectorService(h.sql, config, {
      fetch: h.fetcher,
      native: h.native,
      now: Date.now,
    });
    expect(
      h.sql
        .exec(
          "SELECT status FROM connector_invocations WHERE id = ?",
          request.invocation_id,
        )
        .toArray()[0].status,
    ).toBe("unknown");
  });

  it("retains completion tombstones when outputs exceed the receipt row budget", async () => {
    const h = fixture();
    const id = await h.connect();
    const request = h.execution(id);
    h.native.mockImplementation(async () =>
      Response.json({ result: { output: "x".repeat(600 * 1024), files: [] } }),
    );
    expect((await h.call("/v1/execute", request)).status).toBe(200);
    expect((await h.call("/v1/execute", request)).status).toBe(409);
    expect(h.native).toHaveBeenCalledTimes(1);
    expect(
      h.sql
        .exec(
          "SELECT status,result FROM connector_invocations WHERE id = ?",
          request.invocation_id,
        )
        .toArray()[0],
    ).toEqual({ status: "completed", result: null });
  });

  it("keeps quick Gmail reads available only when Gmail was authorized", async () => {
    const h = fixture();
    const id = await h.connect();
    expect(
      (
        await h.call("/v1/execute", {
          connection_id: id,
          operation: "gmail_search",
          arguments: { query: "is:unread" },
        })
      ).status,
    ).toBe(200);
    const other = fixture(["drive"]);
    const drive = await other.connect();
    expect(
      (
        await other.call("/v1/execute", {
          connection_id: drive,
          operation: "gmail_search",
          arguments: { query: "is:unread" },
        })
      ).status,
    ).toBe(403);
    expect(other.native).not.toHaveBeenCalled();
  });

  it("never sends credentials to catalog discovery", async () => {
    const h = fixture();
    await h.connect();
    const response = await h.call("/v1/catalog", {
      service: "gmail",
      limit: 10,
    });
    expect(response.status).toBe(200);
    expect(await h.native.mock.calls[0][0].json()).toEqual({
      service: "gmail",
      limit: 10,
    });
    expect(
      (await h.call("/v1/catalog", { service: "gmail", limit: 21 })).status,
    ).toBe(400);
  });

  it("binds reconnection to Google's immutable subject rather than a recycled email", async () => {
    const h = fixture();
    const first = await h.connect();
    h.profile.email = "renamed@example.com";
    expect(await h.connect()).toBe(first);
    h.profile.sub = "different-google-subject";
    expect(await h.connect()).not.toBe(first);
    const { connections } = (await (
      await h.call("/v1/connections")
    ).json()) as { connections: { services: string[]; provider: string }[] };
    expect(connections).toHaveLength(2);
    expect(connections[0].services).toEqual(["drive", "gmail"]);
    expect(connections[0].provider).toBe("google");
  });

  it("rejects accounts without verified email before persisting credentials", async () => {
    const h = fixture();
    h.profile.email_verified = false;
    const start = await h.call("/v1/oauth/start", {
      provider: "google",
      services: ["gmail", "drive"],
    });
    const { authorization_url } = (await start.json()) as {
      authorization_url: string;
    };
    const response = await h.call("/v1/oauth/callback", {
      state: new URL(authorization_url).searchParams.get("state"),
      code: "code",
    });
    expect(response.status).toBe(502);
    expect(h.sql.exec("SELECT * FROM connector_connections").toArray()).toEqual(
      [],
    );
  });
  it("accepts a complete 4 MiB input file with linear validation and rejects path escapes", async () => {
    const h = fixture();
    const id = await h.connect();
    const request = {
      ...h.execution(id),
      arguments: {
        command: "drive.upload",
        positionals: ["input:folder/data.bin"],
        files: [
          {
            name: "folder/data.bin",
            content_base64: Buffer.alloc(4 * 1024 * 1024, 65).toString(
              "base64",
            ),
          },
        ],
        output_files: ["folder/output.json"],
      },
    };
    expect((await h.call("/v1/execute", request)).status).toBe(200);
    expect(
      (
        await h.call("/v1/execute", {
          ...h.execution(id),
          arguments: {
            command: "drive.upload",
            files: [{ name: "../escape", content_base64: "YQ==" }],
          },
        })
      ).status,
    ).toBe(400);
    expect(h.native).toHaveBeenCalledTimes(1);
  });

  it("requires configured delegation before starting Keep authorization", async () => {
    const h = fixture(["keep"]);
    const start = await h.call("/v1/oauth/start", {
      provider: "google",
      services: ["keep"],
    });
    expect(start.status).toBe(503);
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(await (await h.call("/v1/capabilities")).json()).toEqual({
      google_workspace_delegation: false,
      google_maps: false,
    });
  });

  it("mints a Keep-only delegated token for the verified owner using a real RSA signature", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const pem = await exportPKCS8(privateKey);
    const credentials = JSON.stringify({
      type: "service_account",
      client_email: "connector@project.iam.gserviceaccount.com",
      private_key: pem,
      token_uri: "https://ignored.example",
    });
    const h = fixture(["keep"], {
      GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON: credentials,
      GOOGLE_WORKSPACE_DOMAIN: "example.com",
    });
    expect(h.grant.scopes).not.toContain(KEEP_SCOPE);
    const id = await h.connect();
    h.fetcher.mockImplementation(async (request) => {
      if (request.url === "https://openidconnect.googleapis.com/v1/userinfo")
        return Response.json(h.profile);
      expect(request.url).toBe("https://oauth2.googleapis.com/token");
      expect(request.redirect).toBe("manual");
      const form = new URLSearchParams(await request.text());
      expect(form.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      );
      const { payload } = await jwtVerify(form.get("assertion")!, publicKey, {
        algorithms: ["RS256"],
        issuer: "connector@project.iam.gserviceaccount.com",
        audience: "https://oauth2.googleapis.com/token",
      });
      expect(payload.sub).toBe("owner@example.com");
      expect(payload.scope).toBe(KEEP_SCOPE);
      expect(payload.exp! - payload.iat!).toBe(3600);
      return Response.json({
        access_token: "keep-delegated-access",
        token_type: "Bearer",
        expires_in: 3600,
        scope: KEEP_SCOPE,
      });
    });
    const execution = {
      ...h.execution(id),
      arguments: { command: "keep.notes.list" },
    };
    expect(
      (
        await h.call("/v1/execute", {
          connection_id: id,
          operation: "gog_execute",
          arguments: execution.arguments,
        })
      ).status,
    ).toBe(400);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    expect((await h.call("/v1/execute", execution)).status).toBe(200);
    const wire = await h.native.mock.calls[0][0].text();
    expect(wire).toContain("keep-delegated-access");
    expect(wire).not.toContain("PRIVATE KEY");
    expect(wire).not.toContain("google-refresh-token");
    expect(
      h.sql
        .exec("SELECT * FROM connector_connections")
        .toArray()
        .map((row) => JSON.stringify(row))
        .join(""),
    ).not.toContain("PRIVATE KEY");
  });

  it("rejects a verified Google account outside the configured delegation domain", async () => {
    const h = fixture(["keep"], {
      GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON: "configured",
      GOOGLE_WORKSPACE_DOMAIN: "other.example",
    });
    const start = await h.call("/v1/oauth/start", {
      provider: "google",
      services: ["keep"],
    });
    const { authorization_url } = (await start.json()) as {
      authorization_url: string;
    };
    const response = await h.call("/v1/oauth/callback", {
      state: new URL(authorization_url).searchParams.get("state"),
      code: "code",
    });
    expect(response.status).toBe(403);
    expect(h.sql.exec("SELECT * FROM connector_connections").toArray()).toEqual(
      [],
    );
  });

  it("does not grant delegated Keep access through raw API calls without Keep consent", async () => {
    const h = fixture(["drive"], {
      GOOGLE_WORKSPACE_SERVICE_ACCOUNT_JSON: "configured",
      GOOGLE_WORKSPACE_DOMAIN: "example.com",
    });
    const id = await h.connect();
    const result = await h.call("/v1/execute", {
      ...h.execution(id),
      arguments: {
        command: "api.call",
        positionals: ["keep", "v1", "keep.notes.list"],
      },
    });
    expect(result.status).toBe(403);
    expect(h.native).not.toHaveBeenCalled();
    expect(h.fetcher).toHaveBeenCalledTimes(2);
  });
  it("routes nested commands to their separately selected Google service grants", async () => {
    for (const [service, command] of [
      ["driveactivity", "drive.activity.list"],
      ["drivelabels", "drive.labels.list"],
      ["photospicker", "photos.picker.create"],
      ["drive", "drive.labels.file.list"],
    ]) {
      const h = fixture([service]);
      const id = await h.connect();
      expect(
        (
          await h.call("/v1/execute", {
            ...h.execution(id),
            arguments: { command },
          })
        ).status,
      ).toBe(200);
      expect(h.native).toHaveBeenCalledTimes(1);
    }
    const h = fixture(["drive"]);
    const id = await h.connect();
    expect(
      (
        await h.call("/v1/execute", {
          ...h.execution(id),
          arguments: {
            command: "drive.labels.get",
            positionals: ["labels/123"],
          },
        })
      ).status,
    ).toBe(403);
    expect(h.native).not.toHaveBeenCalled();
    expect(
      googleGrant({ provider: "google", services: ["admin"] }).scopes,
    ).toContain("https://www.googleapis.com/auth/admin.directory.orgunit");
  });

  it("requires a private Maps key and never adds fictitious Maps OAuth scopes", async () => {
    const missing = fixture(["maps"]);
    expect(
      (
        await missing.call("/v1/oauth/start", {
          provider: "google",
          services: ["maps"],
        })
      ).status,
    ).toBe(503);
    const h = fixture(["maps"], { GOOGLE_MAPS_API_KEY: "private-maps-key" });
    expect(
      h.grant.scopes.every(
        (scope) => scope === "openid" || scope.includes("userinfo."),
      ),
    ).toBe(true);
    const id = await h.connect();
    const command = {
      ...h.execution(id),
      arguments: { command: "maps.search", positionals: ["coffee"] },
    };
    expect((await h.call("/v1/execute", command)).status).toBe(200);
    expect(await h.native.mock.calls[0][0].json()).toEqual(
      expect.objectContaining({
        maps_api_key: "private-maps-key",
        account_email: "owner@example.com",
      }),
    );
    expect(await (await h.call("/v1/capabilities")).json()).toEqual({
      google_workspace_delegation: false,
      google_maps: true,
    });
    h.native.mockImplementation(async () =>
      Response.json({ result: { output: "private-maps-key", files: [] } }),
    );
    const leak = await h.call("/v1/execute", {
      ...command,
      invocation_id: crypto.randomUUID(),
    });
    expect(leak.status).toBe(502);
    expect(await leak.text()).not.toContain("private-maps-key");
  });

  it("requires Calendar and Maps grants for lookups and sends no key on ordinary Calendar requests", async () => {
    const h = fixture(["calendar", "maps"], {
      GOOGLE_MAPS_API_KEY: "private-maps-key",
    });
    const id = await h.connect();
    expect(
      (
        await h.call("/v1/execute", {
          ...h.execution(id),
          arguments: {
            command: "calendar.create",
            flags: { summary: "Fixture" },
          },
        })
      ).status,
    ).toBe(200);
    expect(await h.native.mock.calls[0][0].json()).not.toHaveProperty(
      "maps_api_key",
    );
    expect(
      (
        await h.call("/v1/execute", {
          ...h.execution(id),
          arguments: {
            command: "calendar.create",
            flags: { "place-id": "example-place" },
          },
        })
      ).status,
    ).toBe(200);
    expect(await h.native.mock.calls[1][0].json()).toHaveProperty(
      "maps_api_key",
      "private-maps-key",
    );
    const other = fixture(["calendar"], {
      GOOGLE_MAPS_API_KEY: "private-maps-key",
    });
    const otherId = await other.connect();
    expect(
      (
        await other.call("/v1/execute", {
          ...other.execution(otherId),
          arguments: {
            command: "calendar.update",
            flags: { "location-search": "coffee" },
          },
        })
      ).status,
    ).toBe(403);
    expect(other.native).not.toHaveBeenCalled();
  });
});

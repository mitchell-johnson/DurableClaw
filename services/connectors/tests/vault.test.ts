import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import { createInternalAuthHeaders } from "../../../src/utils/internalAuth";
import { ConnectorService, connectorObjectName } from "../src/core";
import { googleGrant } from "../src/google";
import { executeNative, handlers } from "../vendor/gogcli";

const runtime = env as ConnectorEnv & { PRIVATE_CONNECTORS: Fetcher };
const principal = {
  userId: "native-owner",
  organizationId: "default",
  tenantBinding: "default",
  role: "owner",
};
const secret = "test-only-connector-auth-with-at-least-32-bytes";
const request = async (path: string, body?: unknown, who = principal) =>
  new Request(`https://connector.internal${path}`, {
    method: body ? "POST" : "GET",
    headers: await createInternalAuthHeaders(who, secret),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network request");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("private connector Worker on native Durable Object storage", () => {
  it.each([false, true])(
    "retains native Docs cleanup receipts across reconstruction without replay (ambiguous sharing: %s)",
    async (ambiguousSharing) => {
      const owner = { ...principal, userId: crypto.randomUUID() };
      const stub = runtime.CONNECTOR_VAULT.getByName(
        await connectorObjectName({ ...owner, ts: Date.now() }),
      );
      await runInDurableObject(stub, async (_vault, state) => {
        const access = "cleanup-access-secret";
        const refresh = "cleanup-refresh-secret";
        const providerError = "provider-private-error-with-sensitive-content";
        const grant = googleGrant({ provider: "google", services: ["docs"] });
        const google = vi.fn(async (outbound: Request) => {
          const path = new URL(outbound.url).pathname;
          if (outbound.url === "https://oauth2.googleapis.com/token")
            return Response.json({
              access_token: access,
              refresh_token: refresh,
              token_type: "Bearer",
              expires_in: 3600,
              scope: grant.scopes.join(" "),
            });
          expect(outbound.headers.get("Authorization")).toBe(
            `Bearer ${access}`,
          );
          if (
            outbound.url === "https://openidconnect.googleapis.com/v1/userinfo"
          )
            return Response.json({
              sub: "cleanup-subject",
              email: "cleanup@example.com",
              email_verified: true,
            });
          if (path === "/v1/documents/doc" && outbound.method === "GET")
            return Response.json({
              documentId: "doc",
              revisionId: "r1",
              body: {
                content: [
                  {
                    startIndex: 1,
                    endIndex: 2,
                    paragraph: {
                      elements: [
                        {
                          startIndex: 1,
                          endIndex: 2,
                          textRun: { content: "\n" },
                        },
                      ],
                    },
                  },
                ],
              },
            });
          if (path === "/upload/drive/v3/files" && outbound.method === "POST")
            return Response.json({ id: "uploaded-image" });
          if (
            path === "/drive/v3/files/uploaded-image/permissions" &&
            outbound.method === "POST"
          ) {
            expect(await outbound.json()).toMatchObject({
              type: "anyone",
              role: "reader",
            });
            if (ambiguousSharing) throw new Error(`${providerError} ${access}`);
            return Response.json({ id: "anyoneWithLink" });
          }
          if (
            path === "/v1/documents/doc:batchUpdate" &&
            outbound.method === "POST"
          )
            return new Response(`${providerError} ${access}`, { status: 503 });
          if (
            outbound.method === "DELETE" &&
            [
              "/drive/v3/files/uploaded-image/permissions/anyoneWithLink",
              "/drive/v3/files/uploaded-image",
            ].includes(path)
          )
            return new Response(`${providerError} ${refresh}`, { status: 503 });
          throw new Error(
            `Unexpected Google request: ${outbound.method} ${path}`,
          );
        });
        const native = vi.fn((incoming: Request) =>
          executeNative(incoming, google),
        );
        const dependencies = { fetch: google, native, now: Date.now };
        const service = new ConnectorService(
          state.storage.sql,
          runtime,
          dependencies,
        );
        const start = await service.fetch(
          await request(
            "/v1/oauth/start",
            {
              provider: "google",
              services: ["docs"],
            },
            owner,
          ),
        );
        expect(start.status).toBe(200);
        const { authorization_url } = (await start.json()) as {
          authorization_url: string;
        };
        const callback = await service.fetch(
          await request(
            "/v1/oauth/callback",
            {
              state: new URL(authorization_url).searchParams.get("state"),
              code: "fixture",
            },
            owner,
          ),
        );
        expect(callback.status).toBe(200);
        const { connection_id } = (await callback.json()) as {
          connection_id: string;
        };
        const execution = {
          connection_id,
          operation: "gog_execute",
          invocation_id: crypto.randomUUID(),
          issued_at: Date.now(),
          arguments: {
            command: "docs.insert-image",
            positionals: ["doc"],
            flags: { file: "input:image.png" },
            files: [
              {
                name: "image.png",
                content_base64:
                  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7ssAAAAASUVORK5CYII=",
              },
            ],
          },
        };
        const failure = await service.fetch(
          await request("/v1/execute", execution, owner),
        );
        expect(failure.status).toBe(502);
        const failureText = await failure.text();
        const cleanup = [
          {
            file_id: "uploaded-image",
            public_read_permission_may_remain: true,
          },
        ];
        const persisted = state.storage.sql
          .exec<{ status: string; result: string }>(
            "SELECT status,result FROM connector_invocations WHERE id = ?",
            execution.invocation_id,
          )
          .one();
        expect(persisted.status).toBe("unknown");
        expect(JSON.parse(persisted.result)).toEqual({
          result: { cleanup_required: cleanup },
        });
        const dispatched = google.mock.calls.map(([outbound]) => outbound);
        const deletions = dispatched
          .filter((outbound) => outbound.method === "DELETE")
          .map((outbound) => new URL(outbound.url).pathname);
        expect(deletions).toEqual(
          ambiguousSharing
            ? ["/drive/v3/files/uploaded-image"]
            : [
                "/drive/v3/files/uploaded-image/permissions/anyoneWithLink",
                "/drive/v3/files/uploaded-image",
              ],
        );
        expect(
          dispatched.filter(
            (outbound) =>
              new URL(outbound.url).pathname ===
              "/v1/documents/doc:batchUpdate",
          ),
        ).toHaveLength(ambiguousSharing ? 0 : 1);

        const restarted = new ConnectorService(
          state.storage.sql,
          runtime,
          dependencies,
        );
        const receiptPath = `/v1/invocations/${execution.invocation_id}`;
        const receipt = await restarted.fetch(
          await request(receiptPath, undefined, owner),
        );
        expect(receipt.status).toBe(200);
        const receiptBody = await receipt.json();
        expect(receiptBody).toMatchObject({
          invocation: {
            id: execution.invocation_id,
            connection_id,
            status: "unknown",
            result: { cleanup_required: cleanup },
          },
        });
        const denied = await restarted.fetch(
          await request(receiptPath, undefined, {
            ...owner,
            userId: "other-owner",
          }),
        );
        expect(denied.status).toBe(403);
        const deniedText = await denied.text();
        expect(deniedText).not.toContain("uploaded-image");
        const replay = await restarted.fetch(
          await request("/v1/execute", execution, owner),
        );
        expect(replay.status).toBe(409);
        const replayText = await replay.text();
        expect(native).toHaveBeenCalledTimes(1);
        expect(google).toHaveBeenCalledTimes(dispatched.length);
        const stored = JSON.stringify(
          state.storage.sql
            .exec("SELECT * FROM connector_connections")
            .toArray(),
        );
        const exposed = [
          failureText,
          JSON.stringify(receiptBody),
          deniedText,
          replayText,
          persisted.result,
          stored,
        ].join("\n");
        for (const secretValue of [
          access,
          refresh,
          providerError,
          runtime.GOOGLE_CLIENT_SECRET,
          runtime.CONNECTOR_CREDENTIALS_SECRET,
        ])
          expect(exposed).not.toContain(secretValue);
      });
    },
  );

  it("executes the port inside a real DO and dispatches an approved Google write only once", async () => {
    expect(Object.keys(handlers)).toHaveLength(542);
    const owner = { ...principal, userId: crypto.randomUUID() };
    const stub = runtime.CONNECTOR_VAULT.getByName(
      await connectorObjectName({ ...owner, ts: Date.now() }),
    );
    await runInDurableObject(stub, async (_vault, state) => {
      const google = vi.fn(async (outbound: Request) => {
        if (outbound.url === "https://oauth2.googleapis.com/token")
          return Response.json({
            access_token: "native-access",
            refresh_token: "native-refresh",
            expires_in: 3600,
            token_type: "Bearer",
            scope: googleGrant({
              provider: "google",
              services: ["gmail"],
            }).scopes.join(" "),
          });
        if (outbound.url === "https://openidconnect.googleapis.com/v1/userinfo")
          return Response.json({
            sub: "fixed-subject",
            email: "native@example.com",
            email_verified: true,
          });
        expect(outbound.url).toBe(
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        );
        expect(outbound.method).toBe("POST");
        expect(outbound.headers.get("Authorization")).toBe(
          "Bearer native-access",
        );
        const payload = (await outbound.json()) as { raw: string };
        expect(
          atob(payload.raw.replaceAll("-", "+").replaceAll("_", "/")),
        ).toContain("To: recipient@example.com");
        return Response.json({ id: "sent-id", threadId: "thread-id" });
      });
      const service = new ConnectorService(state.storage.sql, runtime, {
        fetch: google,
        native: (incoming) => executeNative(incoming, google),
        now: Date.now,
      });
      const call = async (path: string, body: unknown) =>
        service.fetch(await request(path, body, owner));
      const start = (await (
        await call("/v1/oauth/start", {
          provider: "google",
          services: ["gmail"],
        })
      ).json()) as { authorization_url: string };
      const linked = (await (
        await call("/v1/oauth/callback", {
          state: new URL(start.authorization_url).searchParams.get("state"),
          code: "fixture",
        })
      ).json()) as { connection_id: string };
      const execution = {
        connection_id: linked.connection_id,
        operation: "gog_execute",
        arguments: {
          command: "gmail.send",
          flags: {
            to: "recipient@example.com",
            subject: "Test only",
            body: "Native DO fixture",
          },
        },
        invocation_id: crypto.randomUUID(),
        issued_at: Date.now(),
      };
      const denied = await call("/v1/execute", {
        ...execution,
        invocation_id: undefined,
      });
      expect(denied.status).toBe(400);
      expect(google).toHaveBeenCalledTimes(2);
      const first = await call("/v1/execute", execution);
      expect(first.status).toBe(200);
      const result = await first.json();
      expect(JSON.stringify(result)).toContain("sent-id");
      expect(JSON.stringify(result)).not.toContain("native-access");
      expect(await (await call("/v1/execute", execution)).json()).toEqual(
        result,
      );
      expect(google).toHaveBeenCalledTimes(3);
      const row = state.storage.sql
        .exec<{ status: string }>(
          "SELECT status FROM connector_invocations WHERE id = ?",
          execution.invocation_id,
        )
        .one();
      expect(row.status).toBe("completed");
    });
  });
  it("keeps the default HTTP entrypoint closed and rejects unauthenticated named service calls", async () => {
    expect(
      (await SELF.fetch("https://connector.internal/v1/connections")).status,
    ).toBe(404);
    expect(
      (
        await runtime.PRIVATE_CONNECTORS.fetch(
          "https://connector.internal/v1/connections",
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await runtime.PRIVATE_CONNECTORS.fetch(
          await request("/v1/connections", undefined, {
            ...principal,
            role: "reader",
          }),
        )
      ).status,
    ).toBe(403);
  });

  it("routes owners separately and preserves the pinned identity on real SQLite", async () => {
    const owner = { ...principal, userId: crypto.randomUUID() };
    expect(
      (
        await runtime.PRIVATE_CONNECTORS.fetch(
          await request("/v1/connections", undefined, owner),
        )
      ).status,
    ).toBe(200);
    const name = await connectorObjectName({ ...owner, ts: Date.now() });
    const stub = runtime.CONNECTOR_VAULT.getByName(name);
    expect(
      (
        await stub.fetch(
          await request("/v1/connections", undefined, {
            ...owner,
            tenantBinding: "wrong",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await stub.fetch(await request("/v1/connections", undefined, owner)))
        .status,
    ).toBe(200);
    await runInDurableObject(stub, async (_vault, state) => {
      const row = state.storage.sql
        .exec<{ identity: string }>(
          "SELECT identity FROM connector_identity WHERE id = 1",
        )
        .one();
      expect(JSON.parse(row.identity)).toEqual([
        owner.organizationId,
        owner.tenantBinding,
        owner.userId,
      ]);
    });
  });

  it("performs PKCE exchange exactly once and stores only encrypted tokens on native storage", async () => {
    const owner = { ...principal, userId: crypto.randomUUID() };
    const stub = runtime.CONNECTOR_VAULT.getByName(
      await connectorObjectName({ ...owner, ts: Date.now() }),
    );
    await runInDurableObject(stub, async (_vault, state) => {
      const fetcher = vi.fn(async (request: Request) => {
        if (request.url === "https://oauth2.googleapis.com/token")
          return Response.json({
            access_token: "native-access-token",
            refresh_token: "native-refresh-token",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/gmail.readonly",
            token_type: "Bearer",
          });
        if (
          request.url ===
            "https://gmail.googleapis.com/gmail/v1/users/me/profile" &&
          request.headers.get("Authorization") === "Bearer native-access-token"
        )
          return Response.json({ emailAddress: "native@example.com" });
        throw new Error("Unexpected network request");
      });
      const service = new ConnectorService(state.storage.sql, runtime, {
        fetch: fetcher,
        native: vi.fn(),
        now: Date.now,
      });

      const start = await service.fetch(
        await request("/v1/oauth/start", { provider: "gmail" }, owner),
      );
      const { authorization_url } = (await start.json()) as {
        authorization_url: string;
      };
      const oauthState = new URL(authorization_url).searchParams.get("state");
      const connected = await service.fetch(
        await request(
          "/v1/oauth/callback",
          { state: oauthState, code: "native-code" },
          owner,
        ),
      );
      expect(connected.status, await connected.clone().text()).toBe(200);
      expect(
        (
          await service.fetch(
            await request(
              "/v1/oauth/callback",
              { state: oauthState, code: "native-code" },
              owner,
            ),
          )
        ).status,
      ).toBe(400);
      const rows = state.storage.sql
        .exec("SELECT * FROM connector_connections")
        .toArray();
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain("native-access-token");
      expect(JSON.stringify(rows)).not.toContain("native-refresh-token");
      expect(
        state.storage.sql.exec("SELECT * FROM connector_pending").toArray(),
      ).toEqual([]);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });
  });

  it("persists command tombstones and bounded results on real SQLite without re-executing", async () => {
    const owner = { ...principal, userId: crypto.randomUUID() };
    const stub = runtime.CONNECTOR_VAULT.getByName(
      await connectorObjectName({ ...owner, ts: Date.now() }),
    );
    await runInDurableObject(stub, async (_vault, state) => {
      const grant = googleGrant({ provider: "google", services: ["gmail"] });
      const fetcher = vi.fn(async (req: Request) =>
        req.url.endsWith("/token")
          ? Response.json({
              access_token: "native-google-access",
              refresh_token: "native-google-refresh",
              token_type: "Bearer",
              expires_in: 3600,
              scope: grant.scopes.join(" "),
            })
          : Response.json({
              sub: "native-google-subject",
              email: "native@example.com",
              email_verified: true,
            }),
      );
      const native = vi.fn(async () =>
        Response.json({
          result: { output: "x".repeat(450 * 1024), files: [] },
        }),
      );
      const service = new ConnectorService(state.storage.sql, runtime, {
        fetch: fetcher,
        native,
        now: Date.now,
      });
      const start = await service.fetch(
        await request(
          "/v1/oauth/start",
          { provider: "google", services: ["gmail"] },
          owner,
        ),
      );
      const { authorization_url } = (await start.json()) as {
        authorization_url: string;
      };
      const callback = await service.fetch(
        await request(
          "/v1/oauth/callback",
          {
            state: new URL(authorization_url).searchParams.get("state"),
            code: "code",
          },
          owner,
        ),
      );
      const { connection_id } = (await callback.json()) as {
        connection_id: string;
      };
      const invocation_id = crypto.randomUUID();
      const command = {
        connection_id,
        operation: "gog_execute",
        arguments: {
          command: "gmail.send",
          flags: {
            to: "fixture@example.com",
            subject: "test",
            body: "only a fixture",
          },
        },
        invocation_id,
        issued_at: Date.now(),
      };
      expect(
        (await service.fetch(await request("/v1/execute", command, owner)))
          .status,
      ).toBe(200);
      expect(
        (await service.fetch(await request("/v1/execute", command, owner)))
          .status,
      ).toBe(200);
      expect(native).toHaveBeenCalledTimes(1);
      const row = state.storage.sql
        .exec<{ status: string; size: number }>(
          "SELECT status,length(CAST(result AS BLOB)) AS size FROM connector_invocations WHERE id = ?",
          invocation_id,
        )
        .one();
      expect(row.status).toBe("completed");
      expect(row.size).toBeGreaterThan(450 * 1024);
      expect(row.size).toBeLessThan(512 * 1024);
    });
  });
});

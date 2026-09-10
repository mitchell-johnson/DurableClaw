import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { authenticator } from "./authenticator";

const origin = "https://identity.example.test";
const password = "correct horse violet river 927!";
const owner = { userId: "owner", workspaceId: "default", role: "owner" };

function client(stub: any) {
  const cookies = new Map<string, string>();
  const cookie = () =>
    [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  const remember = (response: Response) => {
    for (const header of response.headers.getSetCookie()) {
      const [name, ...value] = header.split(";")[0].split("=");
      cookies.set(name, value.join("="));
    }
    return response;
  };
  const request = (
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    new Request(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "cf-connecting-ip": "192.0.2.15",
        cookie: cookie(),
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    cookie,
    request,
    api: async (path: string, body?: unknown, extra?: Record<string, string>) =>
      remember(await stub.fetch(request("/api/auth" + path, body, extra))),
    bootstrap: async (
      evidence: {
        issuedAt?: number;
        expiresAt?: number;
        authenticatedAt?: number | null;
      } = {},
    ) =>
      remember(
        await stub.bootstrapAccess(request("/api/auth/access"), {
          issuedAt: Date.now(),
          expiresAt: Date.now() + 86_400_000,
          authenticatedAt: null,
          ...evidence,
        }),
      ),
    session: () => stub.session(request("/api/session")),
  };
}

function setup() {
  const runtime = env as any;
  const stub = runtime.IDENTITY.get(
    runtime.IDENTITY.idFromName(crypto.randomUUID()),
  );
  return { stub, browser: client(stub) };
}

async function configured() {
  const { stub, browser } = setup();
  expect((await browser.bootstrap()).status).toBe(303);
  const response = await browser.api("/set-password", {
    newPassword: password,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return { stub, browser };
}

describe("native identity in Durable Object SQLite", () => {
  it("cannot claim the owner or reach private bootstrap over HTTP", async () => {
    const { browser } = setup();
    for (const path of [
      "/sign-up/email",
      "/access",
      "/bootstrap",
      "/change-email",
      "/reset-password",
    ])
      expect(
        (
          await browser.api(path, {
            email: "owner@example.test",
            password,
            name: "Attacker",
          })
        ).status,
      ).toBe(404);
    expect(await browser.session()).toBeNull();
    expect(
      (await browser.api("/set-password", { newPassword: password })).status,
    ).toBe(401);
  });

  it("bootstraps a verified immutable owner, hashes passwords and uses secure cookies", async () => {
    const { stub, browser } = setup();
    const bootstrap = await browser.bootstrap();
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get("location")).toBe("/");
    const cookies = bootstrap.headers.getSetCookie().join("\n");
    expect(
      bootstrap.headers
        .getSetCookie()
        .some((cookie) =>
          cookie.startsWith("__Host-durableclaw.session_token="),
        ),
    ).toBe(true);
    expect(cookies).not.toContain("__Secure-__Host-");
    expect(cookies).not.toMatch(/;\s*Domain=/i);
    expect(cookies).toMatch(/HttpOnly/i);
    expect(cookies).toMatch(/Secure/i);
    expect(cookies).toMatch(/SameSite=(?:Lax|Strict)/i);
    expect(await browser.session()).toEqual(owner);
    expect(
      (await browser.api("/set-password", { newPassword: "too short" })).status,
    ).toBe(400);
    expect(
      (await browser.api("/set-password", { newPassword: password })).status,
    ).toBe(200);
    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql
        .exec(
          "SELECT password FROM identity_account WHERE provider_id='credential'",
        )
        .toArray();
      expect(rows).toHaveLength(1);
      expect(String(rows[0].password)).not.toContain(password);
      expect(String(rows[0].password).length).toBeGreaterThan(64);
    });
    expect(
      (await browser.api("/set-password", { newPassword: password })).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it("supports password login and revokes the cookie on logout", async () => {
    const { stub } = await configured();
    const browser = client(stub);
    const invalid = await browser.api("/sign-in/email", {
      email: "owner@example.test",
      password: "incorrect long password!",
    });
    expect(invalid.status).toBe(401);
    expect(
      (
        await browser.api("/sign-in/email", {
          email: "owner@example.test",
          password,
        })
      ).status,
    ).toBe(200);
    expect(await browser.session()).toEqual(owner);
    const oldRequest = browser.request("/api/session");
    expect((await browser.api("/sign-out", {})).status).toBe(200);
    expect(await stub.session(oldRequest)).toBeNull();
  });

  it("rejects cross-origin and non-JSON credential changes before mutation", async () => {
    const { browser } = await configured();
    expect(
      (
        await browser.api(
          "/recover-password",
          { newPassword: password },
          { origin: "https://attacker.test" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await browser.api(
          "/recover-password",
          { newPassword: password },
          { "content-type": "text/plain" },
        )
      ).status,
    ).toBe(415);
    expect(
      (
        await browser.api(
          "/recover-password",
          { newPassword: password },
          { origin: "" },
        )
      ).status,
    ).toBe(403);
  });

  it("password recovery requires verified upstream authentication time and invalidates other sessions", async () => {
    const { stub, browser } = await configured();
    await browser.bootstrap({ authenticatedAt: Date.now() });
    const second = client(stub);
    expect(
      (
        await second.api("/sign-in/email", {
          email: "owner@example.test",
          password,
        })
      ).status,
    ).toBe(200);
    expect(
      (await second.api("/recover-password", { newPassword: password + "new" }))
        .status,
    ).toBe(403);
    const previous = second.request("/api/session");
    expect(
      (
        await browser.api("/recover-password", {
          newPassword: password + "new",
        })
      ).status,
    ).toBe(200);
    expect(await stub.session(previous)).toBeNull();
    expect(
      (
        await second.api("/sign-in/email", {
          email: "owner@example.test",
          password,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await second.api("/sign-in/email", {
          email: "owner@example.test",
          password: password + "new",
        })
      ).status,
    ).toBe(200);
  });

  it("requires recent authentication for credential enrollment", async () => {
    const { stub, browser } = await configured();
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE identity_session SET created_at=?",
        Date.now() - 10 * 60_000,
      );
    });
    expect(
      (
        await browser.api("/recover-password", {
          newPassword: password + "new",
        })
      ).status,
    ).toBe(403);
    expect(
      (await browser.api("/passkey/generate-register-options")).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it("registers and authenticates a cryptographically verified passkey and rejects replay", async () => {
    const { stub, browser } = await configured();
    const key = await authenticator();
    const generated = await browser.api("/passkey/generate-register-options");
    expect(generated.status, await generated.clone().text()).toBe(200);
    const options = (await generated.json()) as any;
    expect(options.authenticatorSelection.userVerification).toBe("required");
    expect(options.authenticatorSelection.residentKey).toBe("required");
    const registration = await key.register(
      options.challenge,
      origin,
      new URL(origin).hostname,
    );
    const created = await browser.api("/passkey/verify-registration", {
      response: registration,
      name: "Test authenticator",
    });
    expect(created.status, await created.clone().text()).toBe(200);
    expect(
      (
        await browser.api("/passkey/verify-registration", {
          response: registration,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    const signin = client(stub);
    const challenge = (await (
      await signin.api("/passkey/generate-authenticate-options")
    ).json()) as any;
    expect(challenge.userVerification).toBe("required");
    const assertion = await key.sign(
      challenge.challenge,
      origin,
      new URL(origin).hostname,
    );
    const signed = await signin.api("/passkey/verify-authentication", {
      response: assertion,
    });
    expect(signed.status, await signed.clone().text()).toBe(200);
    expect(await signin.session()).toEqual(owner);
    const replay = await signin.api("/passkey/verify-authentication", {
      response: assertion,
    });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    expect(
      (
        await signin.api("/recover-password", {
          newPassword: password + "recovered",
        })
      ).status,
    ).toBe(200);
    const recoveryLogin = client(stub);
    expect(
      (
        await recoveryLogin.api("/sign-in/email", {
          email: "owner@example.test",
          password: password + "recovered",
        })
      ).status,
    ).toBe(200);
  });

  it.each(["no user verification", "wrong origin", "wrong RP"])(
    "rejects passkey registration with %s",
    async (kind) => {
      const { browser } = await configured();
      const key = await authenticator();
      const options = (await (
        await browser.api("/passkey/generate-register-options")
      ).json()) as any;
      const response = await key.register(
        options.challenge,
        kind === "wrong origin" ? "https://attacker.test" : origin,
        kind === "wrong RP" ? "attacker.test" : new URL(origin).hostname,
        kind !== "no user verification",
      );
      expect(
        (await browser.api("/passkey/verify-registration", { response }))
          .status,
      ).toBeGreaterThanOrEqual(400);
      const security = (await (await browser.api("/security")).json()) as any;
      expect(security.passkeys).toEqual([]);
    },
  );

  it("rejects signed authentication without user verification and serializes concurrent replay", async () => {
    const { stub, browser } = await configured();
    const key = await authenticator();
    const register = (await (
      await browser.api("/passkey/generate-register-options")
    ).json()) as any;
    const response = await key.register(
      register.challenge,
      origin,
      new URL(origin).hostname,
    );
    expect(
      (await browser.api("/passkey/verify-registration", { response })).status,
    ).toBe(200);
    const signin = client(stub);
    const first = (await (
      await signin.api("/passkey/generate-authenticate-options")
    ).json()) as any;
    const unverified = await key.sign(
      first.challenge,
      origin,
      new URL(origin).hostname,
      { uv: false },
    );
    expect(
      (
        await signin.api("/passkey/verify-authentication", {
          response: unverified,
        })
      ).status,
    ).toBe(403);
    expect(await signin.session()).toBeNull();
    const second = (await (
      await signin.api("/passkey/generate-authenticate-options")
    ).json()) as any;
    const valid = await key.sign(
      second.challenge,
      origin,
      new URL(origin).hostname,
    );
    const concurrent = await Promise.all([
      signin.api("/passkey/verify-authentication", { response: valid }),
      signin.api("/passkey/verify-authentication", { response: valid }),
    ]);
    expect(concurrent.filter((result) => result.status === 200)).toHaveLength(
      1,
    );
    expect(concurrent.filter((result) => result.status >= 400)).toHaveLength(1);
  });

  it("caps password guesses durably across source addresses", async () => {
    const { stub } = await configured();
    const signin = client(stub);
    for (let index = 0; index < 10; index++)
      expect(
        (
          await signin.api(
            "/sign-in/email",
            { email: "owner@example.test", password: "wrong password 12345!" },
            { "cf-connecting-ip": `192.0.2.${index}` },
          )
        ).status,
      ).toBe(401);
    expect(
      (
        await signin.api(
          "/sign-in/email",
          { email: "owner@example.test", password },
          { "cf-connecting-ip": "198.51.100.25" },
        )
      ).status,
    ).toBe(429);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE identity_rate_limit SET reset_at=?",
        Date.now() - 1,
      );
    });
    expect(
      (
        await signin.api("/sign-in/email", {
          email: "owner@example.test",
          password,
        })
      ).status,
    ).toBe(200);
  });

  it("rejects oversized password requests and expired sessions", async () => {
    const { stub, browser } = await configured();
    expect(
      (
        await browser.api("/sign-in/email", {
          email: "owner@example.test",
          password: "x".repeat(40_000),
        })
      ).status,
    ).toBe(413);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE identity_session SET expires_at=?",
        Date.now() - 1,
      );
    });
    expect(await browser.session()).toBeNull();
    expect((await browser.api("/security")).status).toBe(401);
  });

  it("cannot renew initial enrollment authority by replaying an older Access assertion", async () => {
    const { browser } = setup();
    const evidence = { issuedAt: Date.now() - 10 * 60_000 };
    for (let index = 0; index < 2; index++) {
      await browser.bootstrap(evidence);
      const security = (await (await browser.api("/security")).json()) as any;
      expect(security.fresh).toBe(false);
      expect(
        (await browser.api("/set-password", { newPassword: password })).status,
      ).toBe(403);
    }
  });

  it("permanently closes initial Access enrollment after a credential succeeds", async () => {
    const { stub, browser } = await configured();
    // A renewed application JWT is not evidence of a fresh upstream login.
    await browser.bootstrap({ issuedAt: Date.now() });
    const security = (await (await browser.api("/security")).json()) as any;
    expect(security.fresh).toBe(false);
    expect(security.canRecover).toBe(false);
    expect(
      (
        await browser.api("/recover-password", {
          newPassword: password + "attacker",
        })
      ).status,
    ).toBe(403);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM identity_account");
      state.storage.sql.exec("DELETE FROM identity_passkey");
    });
    await browser.bootstrap({ issuedAt: Date.now() });
    expect(
      (await browser.api("/set-password", { newPassword: password })).status,
    ).toBe(403);
  });

  it("serializes the one-time enrollment transition across competing sessions", async () => {
    const { stub, browser } = setup();
    const second = client(stub);
    await browser.bootstrap();
    await second.bootstrap();
    const results = await Promise.all([
      browser.api("/set-password", { newPassword: password }),
      second.api("/set-password", { newPassword: password + "other" }),
    ]);
    expect(results.filter((response) => response.status === 200)).toHaveLength(
      1,
    );
    expect(results.filter((response) => response.status >= 400)).toHaveLength(
      1,
    );
  });
});

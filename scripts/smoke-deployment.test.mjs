import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { optionsFromEnvironment, runSmoke } from "./smoke-deployment.mjs";

const credential = "private-smoke-owner-credential";
const origin = "https://smoke.example";
const accessTeamDomain = "smoke-team.cloudflareaccess.com";
function fixture({
  failTurn = false,
  failCreate = false,
  cleanupFails = false,
  replayStatus = 401,
  unexpectedTool = false,
  omitTool = false,
  failedTool = false,
  accessGate = false,
  nativeSession = false,
  loginLocation,
  redirectAuthenticated = false,
  sessionAuthMode,
} = {}) {
  const records = [];
  const requests = [];
  let created = false;
  let conversation;
  let prompt;
  let marker;
  let deleted = false;
  let disposed = false;
  let socketHeaders;
  const expectedCookie = nativeSession
    ? `__Host-durableclaw.session_token=${credential}${accessGate ? `; CF_Authorization=${credential}` : ""}`
    : `CF_Authorization=${credential}`;
  const reply = (data, status = 200, headers = {}) =>
    Response.json(data, { status, headers });
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({ path, ...options });
    if (
      accessGate &&
      (options.headers.Cookie !== expectedCookie || redirectAuthenticated)
    ) {
      return new Response(null, {
        status: 302,
        headers: {
          location:
            loginLocation ||
            `https://${accessTeamDomain}/cdn-cgi/access/login/smoke.example?redirect_url=${encodeURIComponent(path)}`,
        },
      });
    }
    if (path === "/api/health")
      return reply({ status: "ok", service: "durable-claw" }, 200, {
        "cache-control": "no-store",
      });
    if (path === "/")
      return new Response("<!doctype html><html lang='en'></html>", {
        headers: {
          "content-security-policy":
            "script-src 'self'; frame-ancestors 'none'",
          "x-content-type-options": "nosniff",
        },
      });
    if (path === "/api/session")
      return options.headers.Authorization === `Bearer ${credential}` ||
        options.headers.Cookie === `CF_Authorization=${credential}` ||
        (nativeSession && options.headers.Cookie === expectedCookie)
        ? reply({
            authenticated: true,
            auth_mode:
              sessionAuthMode ||
              (nativeSession ? "native" : accessGate ? "access" : "token"),
            principal: { role: "owner", userId: "private-owner-identifier" },
          })
        : reply({ error: "unauthorized" }, 401);
    if (options.headers.Origin === "https://smoke-invalid.example")
      return reply({}, 403);
    if (path === "/api/devices")
      return reply({ devices: [{ name: "private-device-name" }] });
    if (path === "/api/messaging/links")
      return reply({ links: [{ senderId: "private-messaging-id" }] });
    if (path === "/api/messaging/plugins")
      return reply({ plugins: [{ id: "telegram" }] });
    if (path === "/api/connectors")
      return reply({
        configured: true,
        connections: [{ email: "private-email@example.com" }],
        services: [{ id: "gmail" }],
      });
    if (path === "/api/agent/init") {
      created = true;
      conversation = JSON.parse(options.body).conversation_id;
      if (failCreate) throw new Error(`private transport error ${credential}`);
      return reply({ conversation_id: conversation });
    }
    if (path === "/api/socket-ticket")
      return reply({ ticket: "private-ticket-for-generated-conversation" });
    if (path.endsWith("/messages"))
      return reply({
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: marker },
        ],
      });
    if (path.startsWith("/api/agent/conversations/")) {
      if (options.method === "DELETE") {
        assert.equal(path, `/api/agent/conversations/${conversation}`);
        if (cleanupFails) return reply({}, 500);
        deleted = true;
        return new Response(null, { status: 204 });
      }
      return reply({}, !created || deleted ? 404 : 200);
    }
    throw new Error("unexpected route");
  };
  const socket = async (url, headers) => {
    socketHeaders = headers;
    assert.equal(url.protocol, "wss:");
    assert.equal(url.searchParams.get("conversation_id"), conversation);
    const ws = new EventTarget();
    ws.readyState = 1;
    const dispatch = (value) =>
      ws.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify(value) }),
      );
    ws.send = (raw) => {
      const value = JSON.parse(raw);
      if (value.type === "cancel") return;
      assert.equal(value.type, "message");
      prompt = value.content;
      marker = prompt.match(/DURABLECLAW_SMOKE_[a-z0-9]+/)[0];
      setImmediate(() => {
        if (failTurn)
          return dispatch({
            type: "error",
            error: `provider error ${credential}`,
          });
        dispatch({ type: "assistant_start", request_id: value.request_id });
        if (!omitTool) {
          dispatch({
            type: "tool_call",
            request_id: value.request_id,
            toolName: unexpectedTool
              ? "run_device_bash"
              : "list_service_connections",
            toolCallId: "private-tool-call-id",
          });
          dispatch({
            type: "tool_result",
            request_id: value.request_id,
            toolName: "list_service_connections",
            toolCallId: "private-tool-call-id",
            rawJson: JSON.stringify(
              failedTool
                ? { error: "private-provider-error" }
                : {
                    configured: true,
                    connections: [{ email: "private-tool-email@example.com" }],
                  },
            ),
          });
        }
        dispatch({
          type: "assistant_delta",
          request_id: value.request_id,
          content: marker,
        });
        dispatch({ type: "assistant_end", request_id: value.request_id });
      });
    };
    ws.close = () => {
      ws.readyState = 3;
    };
    setImmediate(() => dispatch({ type: "ready", initialized: true }));
    return {
      socket: ws,
      dispose: async () => {
        assert.equal(
          deleted || cleanupFails,
          true,
          "dispose must follow conversation cleanup",
        );
        disposed = true;
      },
    };
  };
  return {
    dependencies: {
      fetch,
      socket,
      upgrade: async (_url, headers) => {
        if (accessGate) assert.equal(headers.Cookie, expectedCookie);
        return replayStatus;
      },
      emit: (record) => records.push(record),
    },
    records,
    requests,
    state: () => ({ created, deleted, disposed, socketHeaders }),
  };
}

test("live protocol contract verifies one completed/persisted marker turn and only deletes its own conversation", async () => {
  const f = fixture();
  const result = await runSmoke(
    { origin, credential, mode: "bearer" },
    f.dependencies,
  );
  assert.equal(result.status, "pass");
  assert.equal(result.passed, 16);
  assert.equal(f.state().deleted, true);
  assert.equal(f.state().disposed, true);
  assert.deepEqual(f.state().socketHeaders, { Origin: origin });
  assert.equal(
    f.requests.filter((request) => request.method === "DELETE").length,
    1,
  );
  assert.equal(
    f.requests.filter((request) => request.path === "/api/agent/init").length,
    1,
  );
  assert.match(JSON.stringify(f.records), /markerMatched/);
  assert.doesNotMatch(JSON.stringify(f.records), /private-|DURABLECLAW_SMOKE_/);
});

test("native cookie authenticates API probes and both socket handshakes", async () => {
  const f = fixture({ nativeSession: true });
  const result = await runSmoke(
    { origin, credential, mode: "native" },
    f.dependencies,
  );
  assert.equal(result.status, "pass");
  assert.equal(result.passed, 16);
  assert.equal(
    f.state().socketHeaders.Cookie,
    `__Host-durableclaw.session_token=${credential}`,
  );
  assert.equal(f.state().deleted, true);
  assert.doesNotMatch(JSON.stringify(f.records), /private-|DURABLECLAW_SMOKE_/);
});

test("staged native smoke keeps both cookies while the existing Access gate is present", async () => {
  const f = fixture({ nativeSession: true, accessGate: true });
  const result = await runSmoke(
    {
      origin,
      credential,
      accessCredential: credential,
      mode: "native",
      accessTeamDomain,
    },
    f.dependencies,
  );
  assert.equal(result.status, "pass", JSON.stringify(f.records));
  assert.equal(result.passed, 16);
  assert.equal(
    f.state().socketHeaders.Cookie,
    `__Host-durableclaw.session_token=${credential}; CF_Authorization=${credential}`,
  );
  assert.doesNotMatch(JSON.stringify(f.records), /private-/);
});

test("Access gate cookie reaches positive probes and ticket handshakes while edge login redirects reject missing/forged auth", async () => {
  const f = fixture({ accessGate: true });
  const result = await runSmoke(
    { origin, credential, mode: "access", accessTeamDomain },
    f.dependencies,
  );
  assert.equal(result.status, "pass");
  assert.equal(
    f.state().socketHeaders.Cookie,
    `CF_Authorization=${credential}`,
  );
  assert.equal(
    f.requests.find((request) => request.path === "/api/health").headers.Cookie,
    `CF_Authorization=${credential}`,
  );
  assert.equal(
    f.requests.find((request) => request.path === "/").headers.Cookie,
    `CF_Authorization=${credential}`,
  );
  assert.equal(
    f.records.find(
      (record) => record.check === "access_edge_missing_auth_rejected",
    ).status,
    "pass",
  );
  assert.equal(
    f.records.find(
      (record) => record.check === "access_edge_forged_auth_rejected",
    ).status,
    "pass",
  );
  assert.doesNotMatch(JSON.stringify(f.records), /private-/);
});

for (const loginLocation of [
  "https://attacker.example/cdn-cgi/access/login/smoke.example",
  `https://user@${accessTeamDomain}/cdn-cgi/access/login/smoke.example`,
  `https://${accessTeamDomain}:443/cdn-cgi/access/login/smoke.example`,
  `https://${accessTeamDomain}/cdn-cgi/access/login/other-app.example`,
  `https://${accessTeamDomain}/cdn-cgi/access/login/smoke.example?redirect_url=https%3A%2F%2Fattacker.example%2Fapi%2Fsession`,
  `https://${accessTeamDomain}/cdn-cgi/access/login/smoke.example?redirect_url=%2Fwrong-path`,
  `https://${accessTeamDomain}/cdn-cgi/access/login/smoke.example?redirect_url=%2Fapi%2Fsession&redirect_url=%2F`,
  "/cdn-cgi/access/login/smoke.example",
]) {
  test(`Access rejection fails closed for an untrusted redirect: ${loginLocation}`, async () => {
    const f = fixture({ accessGate: true, loginLocation });
    const result = await runSmoke(
      { origin, credential, mode: "access", accessTeamDomain },
      f.dependencies,
    );
    assert.equal(result.status, "fail");
    assert.equal(f.state().created, false);
    assert.equal(
      f.records.find((record) => record.status === "fail").code,
      "missing_auth_not_rejected",
    );
  });
}

test("an Access login redirect cannot pass application health", async () => {
  const f = fixture({ accessGate: true, redirectAuthenticated: true });
  const result = await runSmoke(
    { origin, credential, mode: "access", accessTeamDomain },
    f.dependencies,
  );
  assert.equal(result.status, "fail");
  assert.equal(f.records[0].code, "health_unavailable");
  assert.equal(f.state().created, false);
});

test("the authenticated application must report Access auth mode", async () => {
  const f = fixture({ accessGate: true, sessionAuthMode: "token" });
  const result = await runSmoke(
    { origin, credential, mode: "access", accessTeamDomain },
    f.dependencies,
  );
  assert.equal(result.status, "fail");
  assert.equal(
    f.records.find((record) => record.status === "fail").code,
    "owner_session_unavailable",
  );
  assert.equal(f.state().created, false);
});

for (const scenario of [
  { failTurn: true },
  { failCreate: true },
  { replayStatus: 101 },
  { unexpectedTool: true },
  { omitTool: true },
  { failedTool: true },
]) {
  test(`failure cleanup is bounded to the generated conversation: ${JSON.stringify(scenario)}`, async () => {
    const f = fixture(scenario);
    const result = await runSmoke(
      { origin, credential, mode: "bearer" },
      f.dependencies,
    );
    assert.equal(result.status, "fail");
    assert.equal(f.state().deleted, true);
    if (!scenario.failCreate) assert.equal(f.state().disposed, true);
    assert.doesNotMatch(JSON.stringify(f.records), /private-/);
  });
}

test("cleanup failure fails the run and reports only its generated smoke ID", async () => {
  const f = fixture({ cleanupFails: true });
  const result = await runSmoke(
    { origin, credential, mode: "bearer" },
    f.dependencies,
  );
  assert.equal(result.status, "fail");
  assert.equal(f.state().disposed, true);
  const cleanup = f.records.find((record) => record.cleanup_conversation_id);
  assert.match(cleanup.cleanup_conversation_id, /^smoke-[a-z0-9-]+$/);
  assert.doesNotMatch(JSON.stringify(f.records), /private-/);
});

test("credentials require one private source and an explicit HTTPS origin", async () => {
  await assert.rejects(
    optionsFromEnvironment([origin], {
      SMOKE_AUTH_MODE: "access",
      SMOKE_AUTH_TOKEN: "header.payload.signature",
    }),
    /invalid_access_team_domain/,
  );
  await assert.rejects(
    optionsFromEnvironment([origin], {
      SMOKE_AUTH_MODE: "access",
      SMOKE_ACCESS_TEAM_DOMAIN: "evil.example",
      SMOKE_AUTH_TOKEN: "header.payload.signature",
    }),
    /invalid_access_team_domain/,
  );
  assert.equal(
    (
      await optionsFromEnvironment([origin], {
        SMOKE_AUTH_MODE: "access",
        SMOKE_ACCESS_TEAM_DOMAIN: accessTeamDomain,
        SMOKE_AUTH_TOKEN: "header.payload.signature",
      })
    ).accessTeamDomain,
    accessTeamDomain,
  );
  await assert.rejects(
    optionsFromEnvironment(["http://smoke.example"], {
      SMOKE_AUTH_TOKEN: credential,
    }),
    /invalid_https_origin/,
  );
  await assert.rejects(
    optionsFromEnvironment([origin], {
      SMOKE_AUTH_TOKEN: credential,
      SMOKE_AUTH_FILE: "/unused",
    }),
    /exactly_one/,
  );
  const dir = await mkdtemp(join(tmpdir(), "durableclaw-smoke-test-"));
  try {
    const path = join(dir, "token");
    await writeFile(path, credential + "\n", { mode: 0o600 });
    assert.equal(
      (await optionsFromEnvironment([origin], { SMOKE_AUTH_FILE: path }))
        .credential,
      credential,
    );
    const publicPath = join(dir, "public-token");
    await writeFile(publicPath, credential, { mode: 0o644 });
    await assert.rejects(
      optionsFromEnvironment([origin], { SMOKE_AUTH_FILE: publicPath }),
      /private_regular_file/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI flushes its complete report and exits despite a lingering transport handle", async () => {
  // A preloaded active handle reproduces the original post-summary hang without
  // network traffic. The large queued record also detects truncated stdout.
  const preload = `process.stdout.write(JSON.stringify({probe: "x".repeat(262144)}) + "\\n"); setInterval(() => {}, 1000);`;
  const script = fileURLToPath(
    new URL("./smoke-deployment.mjs", import.meta.url),
  );
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        script,
      ],
      { env: {}, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI did not exit after its report"));
    }, 5000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  const records = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].probe.length, 262144);
  assert.deepEqual(records[1], {
    status: "fail",
    code: "usage_expected_https_origin",
  });
});

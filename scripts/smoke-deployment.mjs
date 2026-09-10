#!/usr/bin/env node
/** Bounded live integration probe. Never log response bodies or credentials. */
import { randomUUID, randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { request as httpsRequest } from "node:https";
import { pathToFileURL } from "node:url";

const MAX_BODY = 1024 * 1024;
const MAX_FRAMES = 1000;
const TIMEOUT_MS = 120_000;
const WORK_MS = 100_000;
class SmokeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
function ensure(condition, code) {
  if (!condition) throw new SmokeError(code);
}
function originFrom(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new SmokeError("invalid_https_origin");
  }
  ensure(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "invalid_https_origin",
  );
  return url.origin;
}
function accessTeamFrom(value) {
  ensure(
    typeof value === "string" &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/i.test(
        value,
      ),
    "invalid_access_team_domain",
  );
  return value.toLowerCase();
}
/** Accept only an Access denial, never an arbitrary redirect or a login page. */
function accessRejected(response, origin, teamDomain, requestPath) {
  if ([401, 403].includes(response.status)) return true;
  if (response.status !== 302) return false;
  try {
    const location = response.headers.get("location");
    if (!location || /[\x00-\x20\x7f\\]/.test(location)) return false;
    if (!location.startsWith(`https://${teamDomain}/cdn-cgi/access/login/`))
      return false;
    const redirect = new URL(location);
    const target = new URL(origin);
    if (
      redirect.protocol !== "https:" ||
      redirect.host !== teamDomain ||
      redirect.username ||
      redirect.password ||
      redirect.hash ||
      redirect.pathname !== `/cdn-cgi/access/login/${target.host}`
    )
      return false;
    const returnPaths = redirect.searchParams.getAll("redirect_url");
    if (returnPaths.length > 1) return false;
    if (returnPaths.length === 1) {
      const value = returnPaths[0];
      if (/[\x00-\x20\x7f\\]/.test(value)) return false;
      const returned = new URL(value, origin);
      if (
        returned.origin !== origin ||
        returned.pathname !== requestPath ||
        returned.username ||
        returned.password ||
        returned.hash
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
async function readPrivateFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    ensure(
      stat.isFile() && stat.size <= 16_384 && (stat.mode & 0o077) === 0,
      "credential_file_must_be_private_regular_file",
    );
    return (await file.readFile("utf8")).trim();
  } finally {
    await file.close();
  }
}
export async function optionsFromEnvironment(argv, env = process.env) {
  ensure(argv.length === 1, "usage_expected_https_origin");
  const origin = originFrom(argv[0]);
  const mode = env.SMOKE_AUTH_MODE || "bearer";
  ensure(["bearer", "access", "native"].includes(mode), "invalid_auth_mode");
  const accessTeamDomain =
    mode === "access" || (mode === "native" && env.SMOKE_ACCESS_FILE)
      ? accessTeamFrom(env.SMOKE_ACCESS_TEAM_DOMAIN)
      : undefined;
  ensure(
    Boolean(env.SMOKE_AUTH_TOKEN) !== Boolean(env.SMOKE_AUTH_FILE),
    "provide_exactly_one_credential_source",
  );
  const credential = env.SMOKE_AUTH_FILE
    ? await readPrivateFile(env.SMOKE_AUTH_FILE)
    : env.SMOKE_AUTH_TOKEN;
  ensure(
    typeof credential === "string" &&
      credential.length >= 16 &&
      credential.length <= 16_384 &&
      !/[\s\x00-\x1f\x7f]/.test(credential),
    "invalid_auth_credential",
  );
  if (mode === "access")
    ensure(
      /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(credential),
      "invalid_access_application_token",
    );
  if (mode === "native")
    ensure(
      /^[a-zA-Z0-9_%.-]+$/.test(credential),
      "invalid_native_session_cookie",
    );
  const accessCredential =
    mode === "native" && env.SMOKE_ACCESS_FILE
      ? await readPrivateFile(env.SMOKE_ACCESS_FILE)
      : undefined;
  if (accessCredential)
    ensure(
      /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(accessCredential),
      "invalid_access_application_token",
    );
  return {
    origin,
    mode,
    credential,
    ...(accessCredential ? { accessCredential } : {}),
    ...(accessTeamDomain ? { accessTeamDomain } : {}),
  };
}
async function boundedBody(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      ensure(length <= MAX_BODY, "response_body_limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}
function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new SmokeError("invalid_json_response");
  }
}

/** Inspect the real upgrade response so a network error cannot pass replay rejection. */
export function rejectedUpgrade(url, headers, signal) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        signal,
        headers: {
          ...headers,
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        },
      },
      (response) => {
        const status = response.statusCode;
        response.destroy();
        resolve(status);
      },
    );
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    request.once("error", () =>
      reject(new SmokeError("upgrade_request_failed")),
    );
    request.end();
  });
}

async function defaultSocket(url, headers) {
  // Wrangler already supplies undici. Its explicit headers support Access cookies;
  // browser-compatible Node WebSocket alone cannot supply those headers.
  const { Agent, WebSocket } = await import("undici");
  const dispatcher = new Agent({ connect: { timeout: 10_000 } });
  try {
    return {
      socket: new WebSocket(url, { headers, dispatcher }),
      // A peer can leave the WebSocket close handshake incomplete. Destroy only
      // this probe's transport, after the HTTP conversation cleanup has finished.
      dispose: () => dispatcher.destroy(),
    };
  } catch (error) {
    await dispatcher.destroy();
    throw error;
  }
}

function markerTurn(socket, { requestId, prompt, marker, signal }) {
  return new Promise((resolve, reject) => {
    let sent = false;
    let started = false;
    let text = "";
    let count = 0;
    let bytes = 0;
    let ended = false;
    let toolCallId;
    let toolCompleted = false;
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      socket.removeEventListener("message", message);
      socket.removeEventListener("error", error);
      socket.removeEventListener("close", close);
    };
    const fail = (code) => {
      if (ended) return;
      ended = true;
      cleanup();
      reject(new SmokeError(code));
    };
    const abort = () => fail("model_turn_timeout");
    const error = () => fail("websocket_failed");
    const close = () => fail("websocket_closed_before_completion");
    const message = (event) => {
      try {
        ensure(typeof event.data === "string", "unexpected_binary_frame");
        count++;
        bytes += Buffer.byteLength(event.data);
        ensure(
          count <= MAX_FRAMES && bytes <= MAX_BODY,
          "websocket_frame_limit",
        );
        const frame = json(event.data);
        if (frame.type === "ready") {
          ensure(frame.initialized === true && !sent, "unexpected_ready_frame");
          sent = true;
          socket.send(
            JSON.stringify({
              type: "message",
              request_id: requestId,
              content: prompt,
            }),
          );
          return;
        }
        if (frame.type === "error") return fail("agent_reported_error");
        if (frame.type === "tool_call") {
          ensure(
            sent &&
              frame.request_id === requestId &&
              frame.toolName === "list_service_connections" &&
              typeof frame.toolCallId === "string" &&
              !toolCallId,
            "unexpected_tool_call",
          );
          toolCallId = frame.toolCallId;
          return;
        }
        if (frame.type === "tool_result") {
          ensure(
            frame.request_id === requestId &&
              frame.toolName === "list_service_connections" &&
              toolCallId &&
              frame.toolCallId === toolCallId &&
              !toolCompleted &&
              typeof frame.rawJson === "string",
            "unexpected_tool_result",
          );
          const output = json(frame.rawJson);
          ensure(
            output.configured === true &&
              Array.isArray(output.connections) &&
              !output.error,
            "connector_tool_failed",
          );
          toolCompleted = true;
          return;
        }
        if (!frame.type?.startsWith("assistant_")) return;
        ensure(
          sent && frame.request_id === requestId,
          "unexpected_turn_identity",
        );
        if (frame.type === "assistant_start") started = true;
        if (frame.type === "assistant_delta") {
          ensure(
            started && typeof frame.content === "string",
            "invalid_assistant_delta",
          );
          text += frame.content;
        }
        if (frame.type === "assistant_message") {
          ensure(
            typeof frame.content === "string",
            "invalid_assistant_message",
          );
          text = frame.content;
        }
        if (frame.type === "assistant_end") {
          ensure(started && frame.stopped !== true, "incomplete_model_turn");
          ensure(text.trim() === marker, "model_marker_mismatch");
          ensure(toolCompleted, "model_tool_roundtrip_missing");
          ended = true;
          cleanup();
          resolve({
            markerMatched: true,
            completed: true,
            toolRoundTrip: true,
          });
        }
      } catch (err) {
        fail(err instanceof SmokeError ? err.code : "invalid_websocket_frame");
      }
    };
    socket.addEventListener("message", message);
    socket.addEventListener("error", error);
    socket.addEventListener("close", close);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Inject transports only for deterministic harness tests; the CLI always uses HTTPS. */
export async function runSmoke(options, dependencies = {}) {
  const origin = originFrom(options.origin);
  const access = options.mode === "access";
  const native = options.mode === "native";
  const accessGate = access || (native && Boolean(options.accessCredential));
  const accessTeamDomain = accessGate
    ? accessTeamFrom(options.accessTeamDomain)
    : undefined;
  const fetcher = dependencies.fetch || fetch;
  const socketFactory = dependencies.socket || defaultSocket;
  const upgrade = dependencies.upgrade || rejectedUpgrade;
  const emit =
    dependencies.emit ||
    ((record) => process.stdout.write(JSON.stringify(record) + "\n"));
  const start = Date.now();
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const work = AbortSignal.timeout(WORK_MS);
  const auth = access
    ? { Cookie: `CF_Authorization=${options.credential}` }
    : native
      ? {
          Cookie: `__Host-durableclaw.session_token=${options.credential}${options.accessCredential ? `; CF_Authorization=${options.accessCredential}` : ""}`,
        }
      : { Authorization: `Bearer ${options.credential}` };
  const websocketAuth = access || native ? auth : {};
  const headers = { ...auth, Origin: origin };
  const conversation = `smoke-${randomUUID()}`;
  const requestId = randomUUID();
  const marker = `DURABLECLAW_SMOKE_${randomUUID().replaceAll("-", "")}`;
  const prompt = `Deployment smoke test. First call list_service_connections exactly once with empty arguments {}. After its result, reply with exactly ${marker} and no other text. Do not print account details. Do not call any other tools, access files or connected service content, create memories, or schedule work. The required tool only lists locally stored connection metadata.`;
  let created = false;
  let socket;
  let socketTransport;
  let failure;
  let check = "initialization";
  let passed = 0;
  async function checked(name, fn) {
    check = name;
    const details = await fn();
    emit({ check: name, status: "pass", ...details });
    passed++;
  }
  async function call(
    path,
    {
      method = "GET",
      body,
      extraHeaders,
      anonymous = false,
      cleanup = false,
    } = {},
  ) {
    const response = await fetcher(new URL(path, origin), {
      method,
      redirect: "manual",
      headers: {
        ...(anonymous ? {} : headers),
        ...(method !== "GET" ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([
        cleanup ? deadline : work,
        AbortSignal.timeout(10_000),
      ]),
    });
    const text = await boundedBody(response);
    return { response, text, data: () => json(text) };
  }
  async function listing(path, property) {
    const result = await call(path);
    ensure(
      result.response.status === 200 && Array.isArray(result.data()[property]),
      "listing_unavailable",
    );
  }
  try {
    await checked(
      accessGate ? "access_authenticated_health" : "public_health",
      async () => {
        const result = await call("/api/health", { anonymous: !accessGate });
        ensure(
          result.response.status === 200 &&
            result.data().status === "ok" &&
            result.data().service === "durable-claw",
          "health_unavailable",
        );
        ensure(
          result.response.headers.get("cache-control") === "no-store",
          "api_cache_header_missing",
        );
      },
    );
    await checked("static_app_security_headers", async () => {
      const result = await call("/", { anonymous: !accessGate });
      const csp = result.response.headers.get("content-security-policy") || "";
      ensure(
        result.response.status === 200 && /<html[\s>]/i.test(result.text),
        "static_app_unavailable",
      );
      ensure(
        csp.includes("script-src 'self'") &&
          csp.includes("frame-ancestors 'none'") &&
          !csp.includes("'unsafe-eval'"),
        "static_csp_missing",
      );
      ensure(
        result.response.headers.get("x-content-type-options") === "nosniff",
        "nosniff_missing",
      );
    });
    await checked(
      accessGate
        ? "access_edge_missing_auth_rejected"
        : "missing_auth_rejected",
      async () => {
        const result = await call("/api/session", { anonymous: true });
        ensure(
          accessGate
            ? accessRejected(
                result.response,
                origin,
                accessTeamDomain,
                "/api/session",
              )
            : result.response.status === 401,
          "missing_auth_not_rejected",
        );
      },
    );
    await checked(
      accessGate ? "access_edge_forged_auth_rejected" : "forged_auth_rejected",
      async () => {
        const forged = access
          ? { Cookie: "CF_Authorization=invalid.invalid.invalid" }
          : native
            ? { Cookie: "__Host-durableclaw.session_token=invalid.invalid" }
            : { Authorization: `Bearer forged-${randomUUID()}` };
        const result = await call("/api/session", {
          anonymous: true,
          extraHeaders: forged,
        });
        ensure(
          accessGate
            ? accessRejected(
                result.response,
                origin,
                accessTeamDomain,
                "/api/session",
              )
            : result.response.status === 401,
          "forged_auth_not_rejected",
        );
      },
    );
    await checked("cross_origin_rejected", async () => {
      const result = await call("/api/socket-ticket", {
        method: "POST",
        body: {},
        extraHeaders: {
          Origin: "https://smoke-invalid.example",
          "Sec-Fetch-Site": "cross-site",
        },
      });
      ensure(result.response.status === 403, "cross_origin_not_rejected");
    });
    await checked("authenticated_session", async () => {
      const result = await call("/api/session");
      ensure(
        result.response.status === 200 &&
          result.data().authenticated === true &&
          result.data().principal?.role === "owner" &&
          (!access || result.data().auth_mode === "access") &&
          (!native || result.data().auth_mode === "native"),
        "owner_session_unavailable",
      );
    });
    await checked("device_registry_d1", () =>
      listing("/api/devices", "devices"),
    );
    await checked("messaging_registry_d1", () =>
      listing("/api/messaging/links", "links"),
    );
    await checked("messaging_plugins", () =>
      listing("/api/messaging/plugins", "plugins"),
    );
    await checked("private_connector_binding", async () => {
      const result = await call("/api/connectors");
      const data = result.data();
      ensure(
        result.response.status === 200 &&
          data.configured === true &&
          Array.isArray(data.connections) &&
          Array.isArray(data.services) &&
          data.services.some((item) => item.id === "gmail"),
        "connector_binding_unavailable",
      );
    });
    await checked("isolated_conversation_created", async () => {
      const existing = await call(`/api/agent/conversations/${conversation}`);
      ensure(
        existing.response.status === 404,
        "smoke_conversation_already_exists",
      );
      // The ID was absent, is generated here, and is retained for cleanup even
      // if the response is lost after /init commits the new conversation.
      created = true;
      const result = await call("/api/agent/init", {
        method: "POST",
        body: { conversation_id: conversation },
      });
      ensure(
        result.response.status === 200 &&
          result.data().conversation_id === conversation,
        "conversation_creation_failed",
      );
    });
    let ticketUrl;
    await checked("socket_ticket_issued", async () => {
      const result = await call("/api/socket-ticket", {
        method: "POST",
        body: { conversation_id: conversation },
      });
      const ticket = result.data().ticket;
      ensure(
        result.response.status === 200 &&
          typeof ticket === "string" &&
          /^[a-zA-Z0-9_-]{16,128}$/.test(ticket),
        "socket_ticket_unavailable",
      );
      ticketUrl = new URL("/api/agent/connect", origin);
      ticketUrl.searchParams.set("conversation_id", conversation);
      ticketUrl.searchParams.set("ticket", ticket);
    });
    await checked("live_model_completion", async () => {
      const url = new URL(ticketUrl);
      url.protocol = "wss:";
      socketTransport = await socketFactory(url, {
        ...websocketAuth,
        Origin: origin,
      });
      socket = socketTransport.socket;
      return markerTurn(socket, { requestId, prompt, marker, signal: work });
    });
    await checked("socket_ticket_replay_rejected", async () => {
      const status = await upgrade(
        ticketUrl,
        { ...websocketAuth, Origin: origin },
        AbortSignal.any([work, AbortSignal.timeout(10_000)]),
      );
      ensure(status === 401, "socket_ticket_replay_not_rejected");
    });
    await checked("conversation_messages_persisted_in_do", async () => {
      const result = await call(
        `/api/agent/conversations/${conversation}/messages?limit=20`,
      );
      const messages = result.data().messages;
      ensure(
        result.response.status === 200 && Array.isArray(messages),
        "persisted_messages_unavailable",
      );
      ensure(
        messages.some(
          (item) => item.role === "user" && item.content === prompt,
        ) &&
          messages.some(
            (item) =>
              item.role === "assistant" && item.content?.trim() === marker,
          ),
        "model_turn_not_persisted",
      );
    });
  } catch (error) {
    failure = error instanceof SmokeError ? error.code : "request_failed";
    emit({ check, status: "fail", code: failure });
  } finally {
    if (socket) {
      try {
        if (failure && socket.readyState === 1)
          socket.send(
            JSON.stringify({ type: "cancel", request_id: requestId }),
          );
        socket.close();
      } catch {}
    }
    if (created) {
      try {
        await checked("isolated_conversation_deleted", async () => {
          const result = await call(
            `/api/agent/conversations/${conversation}`,
            { method: "DELETE", cleanup: true },
          );
          ensure(
            [200, 204, 404].includes(result.response.status),
            "conversation_cleanup_failed",
          );
          const absent = await call(
            `/api/agent/conversations/${conversation}`,
            { cleanup: true },
          );
          ensure(
            absent.response.status === 404,
            "conversation_cleanup_not_verified",
          );
        });
      } catch {
        failure ||= "conversation_cleanup_failed";
        emit({
          check: "isolated_conversation_deleted",
          status: "fail",
          code: "conversation_cleanup_failed",
          cleanup_conversation_id: conversation,
        });
      }
    }
    if (socketTransport) {
      let timeout;
      try {
        await Promise.race([
          socketTransport.dispose(),
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new SmokeError("socket_cleanup_timeout")),
              Math.max(1, Math.min(2_000, start + TIMEOUT_MS - Date.now())),
            );
          }),
        ]);
      } catch {
        failure ||= "socket_cleanup_failed";
        emit({
          check: "socket_transport_closed",
          status: "fail",
          code: "socket_cleanup_failed",
        });
      } finally {
        clearTimeout(timeout);
      }
    }
  }
  const summary = {
    status: failure ? "fail" : "pass",
    passed,
    elapsed_ms: Date.now() - start,
  };
  emit({ summary });
  return summary;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let exitCode;
  try {
    const result = await runSmoke(
      await optionsFromEnvironment(process.argv.slice(2)),
    );
    exitCode = result.status === "pass" ? 0 : 1;
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        status: "fail",
        code: error instanceof SmokeError ? error.code : "smoke_setup_failed",
      }) + "\n",
    );
    exitCode = 1;
  }
  // runSmoke has already awaited remote cleanup and transport disposal. Flush
  // every JSONL record before exiting: third-party keepalive handles must not
  // extend this bounded CLI beyond its finished report. Imports never exit.
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit(exitCode);
}

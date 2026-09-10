import type { AgentPrincipal, Env } from "../types";
import {
  byteLength,
  CLOCK_SKEW_MS,
  deviceSigningText,
  DeviceError,
  encodeBase64,
  MAX_REQUEST_BYTES,
  MAX_RESULT_BYTES,
  objectBody,
  readBoundedBody,
  requireSecureTransport,
  sha256,
  uuid,
  verifySignature,
} from "./protocol";
import {
  currentDeviceOwner,
  type DeviceJob,
  type DeviceRow,
  getDeviceJob,
  listDevices,
  sweepDeviceJobs,
} from "./store";

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DeviceError)
      return json({ error: error.message }, error.status);
    // Credentials, commands and outputs must never reach logs/error responses.
    return json({ error: "Device service unavailable" }, 503);
  }
}
function method(request: Request, expected: string): void {
  if (request.method !== expected)
    throw new DeviceError("Method not allowed", 405);
}
interface Enrollment {
  code_hash: string;
  user_id: string;
  workspace_id: string;
  name: string;
  expires_at: number;
  consumed_at: number | null;
}
async function enroll(request: Request, env: Env): Promise<Response> {
  const body = objectBody(await readBoundedBody(request, 4096));
  if (
    typeof body.code !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(body.code) ||
    typeof body.public_key !== "string" ||
    body.public_key.length > 128 ||
    typeof body.proof !== "string" ||
    body.proof.length > 128
  )
    throw new DeviceError("Invalid enrollment", 401);
  const hash = await sha256(body.code);
  const pending = await env.CONTROL_DB.prepare(
    "SELECT * FROM device_enrollments WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?",
  )
    .bind(hash, Date.now())
    .first<Enrollment>();
  if (
    !pending ||
    !(await verifySignature(
      body.public_key,
      body.proof,
      `durableclaw-enroll-v1\n${body.code}\n${body.public_key}`,
    ))
  )
    throw new DeviceError("Invalid enrollment", 401);
  await currentDeviceOwner(env, pending.user_id, pending.workspace_id);
  const now = Date.now();
  const deviceId = crypto.randomUUID();
  const rows = await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      `INSERT INTO devices (device_id,user_id,workspace_id,name,public_key,created_at)
      SELECT ?,user_id,workspace_id,name,?,? FROM device_enrollments WHERE code_hash=? AND consumed_at IS NULL AND expires_at>?
      AND (SELECT COUNT(*) FROM devices WHERE user_id=? AND workspace_id=?)<100
      ON CONFLICT(user_id,workspace_id,public_key) DO NOTHING`,
    ).bind(
      deviceId,
      body.public_key,
      now,
      hash,
      now,
      pending.user_id,
      pending.workspace_id,
    ),
    env.CONTROL_DB.prepare(
      "UPDATE device_enrollments SET consumed_at=? WHERE code_hash=? AND EXISTS(SELECT 1 FROM devices WHERE device_id=?)",
    ).bind(now, hash, deviceId),
  ]);
  if (rows[0].meta.changes !== 1)
    throw new DeviceError("Invalid enrollment or device limit reached", 401);
  return json({ device_id: deviceId }, 201);
}
async function authenticateDevice(
  request: Request,
  env: Env,
  raw: string,
): Promise<DeviceRow> {
  const id = request.headers.get("X-Device-Id");
  const timestamp = request.headers.get("X-Device-Timestamp") || "";
  const nonce = request.headers.get("X-Device-Nonce");
  const signature = request.headers.get("X-Device-Signature") || "";
  const now = Date.now();
  if (
    !uuid(id) ||
    !uuid(nonce) ||
    !/^\d{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > CLOCK_SKEW_MS ||
    signature.length > 128
  )
    throw new DeviceError("Invalid device authentication", 401);
  const device = await env.CONTROL_DB.prepare(
    "SELECT * FROM devices WHERE device_id=? AND revoked_at IS NULL",
  )
    .bind(id)
    .first<DeviceRow>();
  if (
    !device ||
    !(await verifySignature(
      device.public_key,
      signature,
      await deviceSigningText(request, raw),
    ))
  )
    throw new DeviceError("Invalid device authentication", 401);
  await currentDeviceOwner(env, device.user_id, device.workspace_id);
  await env.CONTROL_DB.prepare("DELETE FROM device_nonces WHERE expires_at<?")
    .bind(now)
    .run();
  // Keep the nonce through the entire acceptance window of future-dated signatures.
  const inserted = await env.CONTROL_DB.prepare(
    `INSERT INTO device_nonces(device_id,nonce,expires_at)
    SELECT device_id,?,? FROM devices WHERE device_id=? AND revoked_at IS NULL
    AND (SELECT COUNT(*) FROM device_nonces WHERE device_id=?)<500
    ON CONFLICT(device_id,nonce) DO NOTHING RETURNING nonce`,
  )
    .bind(nonce, Number(timestamp) + CLOCK_SKEW_MS + 1, id, id)
    .first();
  if (!inserted)
    throw new DeviceError(
      "Replayed, revoked or rate-limited device request",
      401,
    );
  await env.CONTROL_DB.prepare(
    "UPDATE devices SET last_seen_at=? WHERE device_id=? AND revoked_at IS NULL",
  )
    .bind(now, id)
    .run();
  return device;
}
export type DeviceCommandPolicy = (
  principal: AgentPrincipal,
) => Promise<boolean>;
async function poll(
  env: Env,
  device: DeviceRow,
  policy?: DeviceCommandPolicy,
): Promise<Response> {
  const owner: AgentPrincipal = {
    userId: device.user_id,
    workspaceId: device.workspace_id,
    role: "owner",
  };
  await sweepDeviceJobs(env, owner);
  const pending = await env.CONTROL_DB.prepare(
    "SELECT job_id FROM device_jobs WHERE device_id=? AND status='queued' LIMIT 1",
  )
    .bind(device.device_id)
    .first();
  if (!pending) return json({ job: null });
  // A missing/failed policy never dispatches local execution.
  if (!policy || !(await policy(owner))) {
    await env.CONTROL_DB.prepare(
      "UPDATE device_jobs SET status='cancelled',completed_at=? WHERE device_id=? AND status='queued'",
    )
      .bind(Date.now(), device.device_id)
      .run();
    throw new DeviceError("Device command tool is disabled", 403);
  }
  await currentDeviceOwner(env, device.user_id, device.workspace_id);
  const now = Date.now();
  const job = await env.CONTROL_DB.prepare(
    `UPDATE device_jobs SET status='claimed',claim_id=?,claimed_at=?,claim_expires_at=?+timeout_ms+60000
    WHERE job_id=(SELECT job_id FROM device_jobs WHERE device_id=? AND status='queued' AND expires_at>? ORDER BY created_at,job_id LIMIT 1)
    AND status='queued' AND EXISTS(SELECT 1 FROM devices WHERE device_id=? AND revoked_at IS NULL) RETURNING *`,
  )
    .bind(
      crypto.randomUUID(),
      now,
      now,
      device.device_id,
      now,
      device.device_id,
    )
    .first<DeviceJob>();
  return json({
    job: job
      ? {
          job_id: job.job_id,
          claim_id: job.claim_id,
          device_id: job.device_id,
          command: job.command,
          cwd: job.cwd,
          timeout_ms: job.timeout_ms,
          expires_at: job.expires_at,
        }
      : null,
  });
}
function validateResult(
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (
    !uuid(input.job_id) ||
    !uuid(input.claim_id) ||
    typeof input.stdout !== "string" ||
    typeof input.stderr !== "string" ||
    byteLength(input.stdout) + byteLength(input.stderr) > MAX_RESULT_BYTES ||
    !(
      input.exit_code === null ||
      (Number.isInteger(input.exit_code) &&
        (input.exit_code as number) >= 0 &&
        (input.exit_code as number) <= 255)
    ) ||
    !(
      input.signal === null ||
      (typeof input.signal === "string" &&
        /^SIG[A-Z0-9]{1,20}$/.test(input.signal))
    ) ||
    typeof input.timed_out !== "boolean" ||
    typeof input.truncated !== "boolean" ||
    !(
      input.error === undefined ||
      (typeof input.error === "string" && byteLength(input.error) <= 4096)
    )
  )
    throw new DeviceError("Invalid command result");
  return {
    job_id: input.job_id,
    claim_id: input.claim_id,
    stdout: input.stdout,
    stderr: input.stderr,
    exit_code: input.exit_code,
    signal: input.signal,
    timed_out: input.timed_out,
    truncated: input.truncated,
    ...(input.error === undefined ? {} : { error: input.error }),
  };
}
async function saveResult(
  env: Env,
  device: DeviceRow,
  body: Record<string, unknown>,
): Promise<Response> {
  const normalized = validateResult(body);
  const serialized = JSON.stringify(normalized);
  const now = Date.now();
  const updated = await env.CONTROL_DB.prepare(
    `UPDATE device_jobs SET status='completed',result_json=?,completed_at=? WHERE job_id=? AND device_id=? AND claim_id=? AND status='claimed' AND claim_expires_at>?
    AND EXISTS(SELECT 1 FROM devices WHERE device_id=? AND revoked_at IS NULL) RETURNING job_id`,
  )
    .bind(
      serialized,
      now,
      normalized.job_id,
      device.device_id,
      normalized.claim_id,
      now,
      device.device_id,
    )
    .first();
  if (updated) return json({ ok: true });
  const saved = await env.CONTROL_DB.prepare(
    "SELECT status,result_json FROM device_jobs WHERE job_id=? AND device_id=? AND claim_id=?",
  )
    .bind(normalized.job_id, device.device_id, normalized.claim_id)
    .first<DeviceJob>();
  if (saved?.status === "completed" && saved.result_json === serialized)
    return json({ ok: true, duplicate: true });
  throw new DeviceError(
    "Unknown, mismatched or expired command claim; command must not be replayed",
    409,
  );
}
/** Narrow public endpoints; device proofs never act as owner credentials. */
export async function routeDevicePublic(
  request: Request,
  env: Env,
  policy?: DeviceCommandPolicy,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (
    ![
      "/api/devices/enroll",
      "/api/devices/poll",
      "/api/devices/result",
    ].includes(path)
  )
    return null;
  return guarded(async () => {
    method(request, "POST");
    requireSecureTransport(request, env.LOCAL_DEV);
    if (path === "/api/devices/enroll") return enroll(request, env);
    const raw = await readBoundedBody(
      request,
      path.endsWith("/poll") ? 1024 : MAX_REQUEST_BYTES,
    );
    const device = await authenticateDevice(request, env, raw);
    const body = objectBody(raw);
    if (path.endsWith("/poll")) {
      if (Object.keys(body).length)
        throw new DeviceError("Poll body must be {}");
      return poll(env, device, policy);
    }
    return saveResult(env, device, body);
  });
}
/** Invoked only after session/owner authentication by the main router. */
export async function routeDeviceOwner(
  request: Request,
  env: Env,
  principal: AgentPrincipal,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/devices" && !path.startsWith("/api/devices/")) return null;
  return guarded(async () => {
    requireSecureTransport(request, env.LOCAL_DEV);
    if (principal.role !== "owner")
      throw new DeviceError("Owner permission required", 403);
    const db = env.CONTROL_DB;
    const now = Date.now();
    if (path === "/api/devices/enrollment") {
      method(request, "POST");
      const body = objectBody(await readBoundedBody(request, 2048));
      if (
        typeof body.name !== "string" ||
        !body.name.trim() ||
        byteLength(body.name.trim()) > 128 ||
        /[\x00-\x1f\x7f]/.test(body.name)
      )
        throw new DeviceError(
          "Device name must be 1–128 bytes without control characters",
        );
      await db
        .prepare(
          "DELETE FROM device_enrollments WHERE expires_at<=? OR consumed_at IS NOT NULL",
        )
        .bind(now)
        .run();
      const code = encodeBase64(crypto.getRandomValues(new Uint8Array(32)))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      const expires = now + 10 * 60000;
      const row = await db
        .prepare(
          `INSERT INTO device_enrollments(code_hash,user_id,workspace_id,name,created_at,expires_at)
        SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM device_enrollments WHERE user_id=? AND workspace_id=?)<10
        AND (SELECT COUNT(*) FROM devices WHERE user_id=? AND workspace_id=?)<100 RETURNING code_hash`,
        )
        .bind(
          await sha256(code),
          principal.userId,
          principal.workspaceId,
          body.name.trim(),
          now,
          expires,
          principal.userId,
          principal.workspaceId,
          principal.userId,
          principal.workspaceId,
        )
        .first();
      if (!row)
        throw new DeviceError("Enrollment or device limit reached", 429);
      return json({ code, expires_at: expires }, 201);
    }
    if (path === "/api/devices") {
      method(request, "GET");
      return json({ devices: await listDevices(env, principal) });
    }
    if (path === "/api/devices/jobs") {
      method(request, "GET");
      await sweepDeviceJobs(env, principal);
      const rows = await db
        .prepare(
          `SELECT job_id,device_id,conversation_id,command,cwd,timeout_ms,status,created_at,expires_at,claimed_at,claim_expires_at,completed_at,
            CASE WHEN result_json IS NULL THEN NULL ELSE json_object(
              'exit_code',json_extract(result_json,'$.exit_code'),
              'signal',json_extract(result_json,'$.signal'),
              'timed_out',json_extract(result_json,'$.timed_out'),
              'truncated',json_extract(result_json,'$.truncated'),
              'error',json_extract(result_json,'$.error')) END AS result_summary
            FROM device_jobs WHERE user_id=? AND workspace_id=? ORDER BY created_at DESC LIMIT 200`,
        )
        .bind(principal.userId, principal.workspaceId)
        .all<Record<string, unknown> & { result_summary: string | null }>();
      return json({
        jobs: rows.results.map(({ result_summary, ...job }) => ({
          ...job,
          result_summary: result_summary ? JSON.parse(result_summary) : null,
        })),
      });
    }
    if (path.startsWith("/api/devices/jobs/")) {
      const id = path.slice("/api/devices/jobs/".length);
      if (!uuid(id)) throw new DeviceError("Job not found", 404);
      if (request.method === "GET") {
        const job = await getDeviceJob(env, principal, id);
        if (!job) throw new DeviceError("Job not found", 404);
        return json({ job });
      }
      method(request, "DELETE");
      const updated = await db
        .prepare(
          "UPDATE device_jobs SET status='cancelled',completed_at=? WHERE job_id=? AND user_id=? AND workspace_id=? AND status='queued' RETURNING job_id",
        )
        .bind(now, id, principal.userId, principal.workspaceId)
        .first();
      if (updated) return json({ ok: true });
      const existing = await db
        .prepare(
          "SELECT status FROM device_jobs WHERE job_id=? AND user_id=? AND workspace_id=?",
        )
        .bind(id, principal.userId, principal.workspaceId)
        .first<DeviceJob>();
      if (!existing) throw new DeviceError("Job not found", 404);
      if (existing.status === "cancelled") return json({ ok: true });
      throw new DeviceError("Only unclaimed jobs can be cancelled", 409);
    }
    const id = path.slice("/api/devices/".length);
    if (!uuid(id)) throw new DeviceError("Device route not found", 404);
    method(request, "DELETE");
    const rows = await db.batch([
      db
        .prepare(
          "UPDATE devices SET revoked_at=COALESCE(revoked_at,?) WHERE device_id=? AND user_id=? AND workspace_id=? RETURNING device_id",
        )
        .bind(now, id, principal.userId, principal.workspaceId),
      db
        .prepare(
          "UPDATE device_jobs SET status='cancelled',completed_at=? WHERE device_id=? AND user_id=? AND workspace_id=? AND status='queued'",
        )
        .bind(now, id, principal.userId, principal.workspaceId),
      db
        .prepare(
          "DELETE FROM device_nonces WHERE device_id=? AND EXISTS(SELECT 1 FROM devices WHERE device_id=? AND user_id=? AND workspace_id=? AND revoked_at IS NOT NULL)",
        )
        .bind(id, id, principal.userId, principal.workspaceId),
    ]);
    if (!rows[0].results.length) throw new DeviceError("Device not found", 404);
    return json({ ok: true });
  });
}

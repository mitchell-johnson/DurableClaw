import type { AgentPrincipal, Env } from "../types";
import { authorizePrincipal } from "../auth";
import {
  byteLength,
  DeviceError,
  MAX_COMMAND_BYTES,
  MAX_TIMEOUT_MS,
  uuid,
} from "./protocol";

export interface DeviceRow {
  device_id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  public_key: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}
export interface DeviceJob {
  job_id: string;
  device_id: string;
  user_id: string;
  workspace_id: string;
  conversation_id: string;
  confirmation_id: string;
  command: string;
  cwd: string;
  timeout_ms: number;
  status:
    "queued" | "claimed" | "completed" | "cancelled" | "expired" | "unknown";
  created_at: number;
  expires_at: number;
  claim_id: string | null;
  claimed_at: number | null;
  claim_expires_at: number | null;
  completed_at: number | null;
  result_json: string | null;
}
export interface DeviceCommand extends Record<string, unknown> {
  device_id: string;
  command: string;
  cwd: string;
  timeout_ms: number;
}
export function validateCommand(input: Record<string, unknown>): DeviceCommand {
  if (
    !uuid(input.device_id) ||
    typeof input.command !== "string" ||
    !input.command.trim() ||
    input.command.includes("\0") ||
    byteLength(input.command) > MAX_COMMAND_BYTES ||
    typeof input.cwd !== "string" ||
    !input.cwd.startsWith("/") ||
    input.cwd.includes("\0") ||
    byteLength(input.cwd) > 4096 ||
    !Number.isInteger(input.timeout_ms) ||
    (input.timeout_ms as number) < 1 ||
    (input.timeout_ms as number) > MAX_TIMEOUT_MS
  )
    throw new DeviceError(
      "Invalid device command: require device UUID, command ≤16000 bytes, absolute cwd, timeout 1–120000 ms",
    );
  return {
    device_id: input.device_id,
    command: input.command,
    cwd: input.cwd,
    timeout_ms: input.timeout_ms as number,
  };
}
export async function currentDeviceOwner(
  env: Env,
  userId: string,
  workspaceId: string,
): Promise<AgentPrincipal> {
  let principal: AgentPrincipal;
  try {
    principal = await authorizePrincipal(env, userId, workspaceId);
  } catch {
    throw new DeviceError("Current owner authority unavailable", 403);
  }
  if (principal.role !== "owner")
    throw new DeviceError("Owner permission required", 403);
  return principal;
}
export async function listDevices(env: Env, owner: AgentPrincipal) {
  return (
    await env.CONTROL_DB.prepare(
      "SELECT device_id,name,created_at,last_seen_at,revoked_at FROM devices WHERE user_id=? AND workspace_id=? ORDER BY created_at DESC LIMIT 100",
    )
      .bind(owner.userId, owner.workspaceId)
      .all()
  ).results;
}
export async function sweepDeviceJobs(
  env: Env,
  owner: AgentPrincipal,
): Promise<void> {
  const now = Date.now();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "UPDATE device_jobs SET status='expired',completed_at=? WHERE user_id=? AND workspace_id=? AND status='queued' AND expires_at<=?",
    ).bind(now, owner.userId, owner.workspaceId, now),
    env.CONTROL_DB.prepare(
      "UPDATE device_jobs SET status='unknown',completed_at=? WHERE user_id=? AND workspace_id=? AND status='claimed' AND claim_expires_at<=?",
    ).bind(now, owner.userId, owner.workspaceId, now),
    env.CONTROL_DB.prepare(
      "DELETE FROM device_jobs WHERE user_id=? AND workspace_id=? AND status NOT IN ('queued','claimed') AND (completed_at<? OR job_id NOT IN (SELECT job_id FROM device_jobs WHERE user_id=? AND workspace_id=? AND status NOT IN ('queued','claimed') ORDER BY completed_at DESC LIMIT 200))",
    ).bind(
      owner.userId,
      owner.workspaceId,
      now - 7 * 86400000,
      owner.userId,
      owner.workspaceId,
    ),
  ]);
}
export function jobView(job: DeviceJob): Record<string, unknown> {
  const {
    user_id: _user,
    workspace_id: _workspace,
    confirmation_id: _confirmation,
    result_json,
    ...view
  } = job;
  return { ...view, result: result_json ? JSON.parse(result_json) : null };
}
export async function getDeviceJob(
  env: Env,
  owner: AgentPrincipal,
  jobId: string,
): Promise<Record<string, unknown> | null> {
  await sweepDeviceJobs(env, owner);
  const job = await env.CONTROL_DB.prepare(
    "SELECT * FROM device_jobs WHERE job_id=? AND user_id=? AND workspace_id=?",
  )
    .bind(jobId, owner.userId, owner.workspaceId)
    .first<DeviceJob>();
  return job ? jobView(job) : null;
}
/** Only the server-approved tool path calls this; never expose an enqueue HTTP route. */
export async function enqueueDeviceJob(
  env: Env,
  owner: AgentPrincipal,
  input: DeviceCommand & { confirmation_id: string; conversation_id: string },
): Promise<DeviceJob> {
  const command = validateCommand(input);
  if (!input.confirmation_id || !input.conversation_id)
    throw new DeviceError("Missing server approval", 403);
  await currentDeviceOwner(env, owner.userId, owner.workspaceId);
  await sweepDeviceJobs(env, owner);
  const now = Date.now();
  const jobId = crypto.randomUUID();
  // One statement bounds the queue and rechecks revocation during insertion.
  await env.CONTROL_DB.prepare(
    `INSERT INTO device_jobs (job_id,device_id,user_id,workspace_id,conversation_id,confirmation_id,command,cwd,timeout_ms,status,created_at,expires_at)
    SELECT ?,device_id,user_id,workspace_id,?,?,?,?,?,'queued',?,? FROM devices
    WHERE device_id=? AND user_id=? AND workspace_id=? AND revoked_at IS NULL
    AND (SELECT COUNT(*) FROM device_jobs WHERE device_id=? AND status IN ('queued','claimed'))<30
    ON CONFLICT(user_id,workspace_id,confirmation_id) DO NOTHING`,
  )
    .bind(
      jobId,
      input.conversation_id,
      input.confirmation_id,
      command.command,
      command.cwd,
      command.timeout_ms,
      now,
      now + 5 * 60000,
      command.device_id,
      owner.userId,
      owner.workspaceId,
      command.device_id,
    )
    .run();
  const saved = await env.CONTROL_DB.prepare(
    "SELECT * FROM device_jobs WHERE user_id=? AND workspace_id=? AND confirmation_id=?",
  )
    .bind(owner.userId, owner.workspaceId, input.confirmation_id)
    .first<DeviceJob>();
  if (!saved)
    throw new DeviceError("Device unavailable or command queue full", 409);
  if (
    saved.device_id !== command.device_id ||
    saved.command !== command.command ||
    saved.cwd !== command.cwd ||
    saved.timeout_ms !== command.timeout_ms ||
    saved.conversation_id !== input.conversation_id
  )
    throw new DeviceError("Approval already used for different arguments", 409);
  return saved;
}

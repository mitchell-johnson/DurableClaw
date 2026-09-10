import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import type { AgentPrincipal, Env } from "../../src/types";
import {
  routeDeviceOwner,
  routeDevicePublic as routeDevicePublicImpl,
} from "../../src/devices/routes";
import { enqueueDeviceJob } from "../../src/devices/store";
import { createDeviceTools } from "../../src/devices/tools";
import { createSqliteStorage } from "../helpers/sqlite";
import {
  decideToolConfirmation,
  ensureToolConfirmationsSchema,
} from "../../src/durable-objects/assistant/toolConfirmations";

const owner: AgentPrincipal = {
  userId: "owner",
  workspaceId: "default",
  role: "owner",
};
const routeDevicePublic = (request: Request, env: Env) =>
  routeDevicePublicImpl(request, env, async () => true);
const origin = "https://agent.example";
let db: Database.Database;
let env: Env;
function statement(query: string, values: unknown[] = []): D1PreparedStatement {
  const prepared = db.prepare(query);
  const rows = () =>
    prepared.reader ? prepared.all(...values) : (prepared.run(...values), []);
  return {
    bind: (...bindings: unknown[]) => statement(query, bindings),
    first: async (column?: string) => {
      const row = rows()[0] as Record<string, unknown> | undefined;
      return column ? (row?.[column] ?? null) : (row ?? null);
    },
    all: async () => ({
      results: rows(),
      success: true,
      meta: { changes: db.prepare("SELECT changes() AS n").get().n },
    }),
    run: async () => ({
      results: rows(),
      success: true,
      meta: { changes: db.prepare("SELECT changes() AS n").get().n },
    }),
  } as D1PreparedStatement;
}
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(
    readFileSync(
      new URL("../../migrations/0003_devices.sql", import.meta.url),
      "utf8",
    ),
  );
  env = {
    AGENT_TOKEN: "test-owner-token",
    CONTROL_DB: {
      prepare: statement,
      batch: async (statements: D1PreparedStatement[]) => {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const s of statements) results.push(await s.all());
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
  } as unknown as Env;
});
afterEach(() => db.close());
function request(path: string, body: unknown = {}, method = "POST") {
  return new Request(origin + path, {
    method,
    ...(method === "GET"
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
  });
}
async function enroll(name = "Test Mac") {
  const response = await routeDeviceOwner(
    request("/api/devices/enrollment", { name }),
    env,
    owner,
  );
  expect(response?.status).toBe(201);
  const { code } = (await response!.json()) as { code: string };
  const keys = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const public_key = Buffer.from(
    await crypto.subtle.exportKey("spki", keys.publicKey),
  ).toString("base64");
  const proof = Buffer.from(
    await crypto.subtle.sign(
      "Ed25519",
      keys.privateKey,
      new TextEncoder().encode(`durableclaw-enroll-v1\n${code}\n${public_key}`),
    ),
  ).toString("base64");
  const payload = { code, public_key, proof };
  const result = await routeDevicePublic(
    request("/api/devices/enroll", payload),
    env,
  );
  expect(result?.status).toBe(201);
  return {
    ...((await result!.json()) as { device_id: string }),
    keys,
    payload,
  };
}
async function signed(
  device: Awaited<ReturnType<typeof enroll>>,
  path = "/api/devices/poll",
  body: unknown = {},
  timestamp = String(Date.now()),
  nonce = crypto.randomUUID(),
) {
  const raw = JSON.stringify(body);
  const hash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
  ).toString("hex");
  const signature = Buffer.from(
    await crypto.subtle.sign(
      "Ed25519",
      device.keys.privateKey,
      new TextEncoder().encode(
        `durableclaw-device-v1\n${device.device_id}\nPOST\n${origin}${path}\n${timestamp}\n${nonce}\n${hash}`,
      ),
    ),
  ).toString("base64");
  return new Request(origin + path, {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "X-Device-Id": device.device_id,
      "X-Device-Timestamp": timestamp,
      "X-Device-Nonce": nonce,
      "X-Device-Signature": signature,
    },
  });
}
const command = { command: "printf hello", cwd: "/tmp", timeout_ms: 10000 };
async function enqueue(
  device_id: string,
  confirmation_id = crypto.randomUUID(),
) {
  return enqueueDeviceJob(env, owner, {
    ...command,
    device_id,
    confirmation_id,
    conversation_id: "conversation",
  });
}
async function poll(device: Awaited<ReturnType<typeof enroll>>) {
  return (await (await routeDevicePublic(
    await signed(device),
    env,
  ))!.json()) as { job: { job_id: string; claim_id: string } | null };
}
function result(job: { job_id: string; claim_id: string }) {
  return {
    ...job,
    stdout: "hello",
    stderr: "",
    exit_code: 0,
    signal: null,
    timed_out: false,
    truncated: false,
  };
}

describe("device enrollment and authentication", () => {
  it("stores a hashed one-time enrollment code and verifies proof of private-key possession", async () => {
    const device = await enroll();
    expect(
      JSON.stringify(db.prepare("SELECT * FROM device_enrollments").all()),
    ).not.toContain(device.payload.code);
    expect(
      (
        await routeDevicePublic(
          request("/api/devices/enroll", device.payload),
          env,
        )
      )?.status,
    ).toBe(401);
    const record = db.prepare("SELECT * FROM devices").get() as Record<
      string,
      unknown
    >;
    expect(record.public_key).toBe(device.payload.public_key);
    expect(record).not.toHaveProperty("private_key");
  });
  it("rejects forged enrollment proof without consuming the legitimate code", async () => {
    const device = await enroll();
    const pending = (await (await routeDeviceOwner(
      request("/api/devices/enrollment", { name: "Other" }),
      env,
      owner,
    ))!.json()) as { code: string };
    expect(
      (
        await routeDevicePublic(
          request("/api/devices/enroll", {
            ...device.payload,
            code: pending.code,
          }),
          env,
        )
      )?.status,
    ).toBe(401);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM device_enrollments WHERE consumed_at IS NULL",
        )
        .get(),
    ).toEqual({ n: 1 });
  });
  it("rejects expired enrollment and non-owner administration", async () => {
    const pending = (await (await routeDeviceOwner(
      request("/api/devices/enrollment", { name: "Old" }),
      env,
      owner,
    ))!.json()) as { code: string };
    db.prepare("UPDATE device_enrollments SET expires_at = 1").run();
    expect(
      (
        await routeDevicePublic(
          request("/api/devices/enroll", {
            code: pending.code,
            public_key: "x",
            proof: "x",
          }),
          env,
        )
      )?.status,
    ).toBe(401);
    expect(
      (
        await routeDeviceOwner(
          request("/api/devices/enrollment", { name: "Denied" }),
          env,
          { ...owner, role: "reader" },
        )
      )?.status,
    ).toBe(403);
  });
  it("authenticates exact requests and rejects replay, stale signatures, body and URL tampering", async () => {
    const device = await enroll();
    const req = await signed(device);
    expect((await routeDevicePublic(req.clone(), env))?.status).toBe(200);
    expect((await routeDevicePublic(req, env))?.status).toBe(401);
    expect(
      (
        await routeDevicePublic(
          await signed(
            device,
            "/api/devices/poll",
            {},
            String(Date.now() - 61000),
          ),
          env,
        )
      )?.status,
    ).toBe(401);
    const altered = await signed(device);
    expect(
      (
        await routeDevicePublic(
          new Request(altered.url, {
            method: "POST",
            headers: altered.headers,
            body: '{"x":1}',
          }),
          env,
        )
      )?.status,
    ).toBe(401);
    const moved = await signed(device);
    expect(
      (
        await routeDevicePublic(
          new Request(origin + "/api/devices/result", moved),
          env,
        )
      )?.status,
    ).toBe(401);
  });
  it("rejects revoked devices and a removed owner's live authority", async () => {
    const device = await enroll();
    env.AUTH = {
      fetch: async () => Response.json({ ...owner, role: "reader" }),
    } as unknown as Fetcher;
    expect((await routeDevicePublic(await signed(device), env))?.status).toBe(
      403,
    );
    delete env.AUTH;
    expect(
      (
        await routeDeviceOwner(
          request(`/api/devices/${device.device_id}`, {}, "DELETE"),
          env,
          owner,
        )
      )?.status,
    ).toBe(200);
    expect((await routeDevicePublic(await signed(device), env))?.status).toBe(
      401,
    );
  });
  it("requires HTTPS and never accepts device credentials for owner routes", async () => {
    const device = await enroll();
    const req = await signed(device);
    expect(
      (
        await routeDevicePublic(
          new Request(req.url.replace("https:", "http:"), req),
          env,
        )
      )?.status,
    ).toBe(400);
    expect(
      await routeDevicePublic(
        await signed(device, "/api/devices/enrollment"),
        env,
      ),
    ).toBeNull();
  });
});

describe("device command lifecycle", () => {
  it("claims a command exactly once across racing polls and never redelivers it", async () => {
    const device = await enroll();
    const job = await enqueue(device.device_id);
    const replies = await Promise.all([poll(device), poll(device)]);
    expect(replies.filter((r) => r.job)).toHaveLength(1);
    expect(replies.find((r) => r.job)?.job?.job_id).toBe(job.job_id);
    expect((await poll(device)).job).toBeNull();
  });
  it("makes queue insertion idempotent for a consumed approval", async () => {
    const device = await enroll();
    const approval = crypto.randomUUID();
    expect((await enqueue(device.device_id, approval)).job_id).toBe(
      (await enqueue(device.device_id, approval)).job_id,
    );
    expect(db.prepare("SELECT COUNT(*) n FROM device_jobs").get()).toEqual({
      n: 1,
    });
  });
  it("scopes devices and jobs to their owner and target device", async () => {
    const a = await enroll("A");
    const b = await enroll("B");
    const job = await enqueue(a.device_id);
    expect((await poll(b)).job).toBeNull();
    const claimed = (await poll(a)).job!;
    expect(
      (
        await routeDevicePublic(
          await signed(b, "/api/devices/result", result(claimed)),
          env,
        )
      )?.status,
    ).toBe(409);
    const otherOwner = { ...owner, userId: "other" };
    expect(
      await (await routeDeviceOwner(
        request("/api/devices", {}, "GET"),
        env,
        otherOwner,
      ))!.json(),
    ).toEqual({ devices: [] });
    expect(
      (
        await routeDeviceOwner(
          request(`/api/devices/jobs/${job.job_id}`, {}, "DELETE"),
          env,
          otherOwner,
        )
      )?.status,
    ).toBe(404);
  });
  it("accepts duplicate matching results and rejects mismatched/stale results", async () => {
    const device = await enroll();
    await enqueue(device.device_id);
    const job = (await poll(device)).job!;
    const body = result(job);
    expect(
      (
        await routeDevicePublic(
          await signed(device, "/api/devices/result", body),
          env,
        )
      )?.status,
    ).toBe(200);
    const duplicate = await routeDevicePublic(
      await signed(device, "/api/devices/result", body),
      env,
    );
    expect(await duplicate!.json()).toEqual({ ok: true, duplicate: true });
    expect(
      (
        await routeDevicePublic(
          await signed(device, "/api/devices/result", {
            ...body,
            stdout: "different",
          }),
          env,
        )
      )?.status,
    ).toBe(409);
    await enqueue(device.device_id);
    const stale = (await poll(device)).job!;
    db.prepare(
      "UPDATE device_jobs SET claim_expires_at = 1 WHERE job_id = ?",
    ).run(stale.job_id);
    expect(
      (
        await routeDevicePublic(
          await signed(device, "/api/devices/result", result(stale)),
          env,
        )
      )?.status,
    ).toBe(409);
  });
  it("bounds command duration, pending queue and output size", async () => {
    const device = await enroll();
    await expect(
      enqueueDeviceJob(env, owner, {
        ...command,
        device_id: device.device_id,
        timeout_ms: 120001,
        confirmation_id: "x",
        conversation_id: "c",
      }),
    ).rejects.toThrow();
    for (let i = 0; i < 30; i++) await enqueue(device.device_id);
    await expect(enqueue(device.device_id)).rejects.toThrow(/queue/i);
    const job = (await poll(device)).job!;
    expect(
      (
        await routeDevicePublic(
          await signed(device, "/api/devices/result", {
            ...result(job),
            stdout: "é".repeat(32769),
          }),
          env,
        )
      )?.status,
    ).toBe(400);
  });
  it("cancels only unclaimed jobs and revocation cancels the pending queue", async () => {
    const device = await enroll();
    const job = await enqueue(device.device_id);
    expect(
      (
        await routeDeviceOwner(
          request(`/api/devices/jobs/${job.job_id}`, {}, "DELETE"),
          env,
          owner,
        )
      )?.status,
    ).toBe(200);
    expect((await poll(device)).job).toBeNull();
    await enqueue(device.device_id);
    const started = (await poll(device)).job!;
    expect(
      (
        await routeDeviceOwner(
          request(`/api/devices/jobs/${started.job_id}`, {}, "DELETE"),
          env,
          owner,
        )
      )?.status,
    ).toBe(409);
    const queued = await enqueue(device.device_id);
    await routeDeviceOwner(
      request(`/api/devices/${device.device_id}`, {}, "DELETE"),
      env,
      owner,
    );
    expect(
      db
        .prepare("SELECT status FROM device_jobs WHERE job_id = ?")
        .get(queued.job_id),
    ).toEqual({ status: "cancelled" });
  });
  it("fails closed when current command policy is disabled or unavailable", async () => {
    const device = await enroll();
    await enqueue(device.device_id);
    expect(
      (
        await routeDevicePublicImpl(
          await signed(device),
          env,
          async () => false,
        )
      )?.status,
    ).toBe(403);
    expect(db.prepare("SELECT status FROM device_jobs").get()).toEqual({
      status: "cancelled",
    });
    await enqueue(device.device_id);
    expect(
      (await routeDevicePublicImpl(await signed(device), env))?.status,
    ).toBe(403);
    expect((await poll(device)).job).toBeNull();
  });
  it("does not allow a prior approval to enqueue different arguments", async () => {
    const device = await enroll();
    const confirmation_id = crypto.randomUUID();
    await enqueue(device.device_id, confirmation_id);
    await expect(
      enqueueDeviceJob(env, owner, {
        ...command,
        command: "echo changed",
        device_id: device.device_id,
        confirmation_id,
        conversation_id: "conversation",
      }),
    ).rejects.toThrow(/different arguments/);
    expect(db.prepare("SELECT COUNT(*) n FROM device_jobs").get()).toEqual({
      n: 1,
    });
  });
  it("refuses oversized signed request bodies before reading them", async () => {
    const device = await enroll();
    const req = await signed(device, "/api/devices/result");
    req.headers.set("Content-Length", "524289");
    expect((await routeDevicePublic(req, env))?.status).toBe(413);
  });
  it("prunes expired enrollment tokens and caps pending enrollment", async () => {
    for (let i = 0; i < 10; i++)
      expect(
        (
          await routeDeviceOwner(
            request("/api/devices/enrollment", { name: "Pending" }),
            env,
            owner,
          )
        )?.status,
      ).toBe(201);
    expect(
      (
        await routeDeviceOwner(
          request("/api/devices/enrollment", { name: "Overflow" }),
          env,
          owner,
        )
      )?.status,
    ).toBe(429);
    db.prepare("UPDATE device_enrollments SET expires_at=1").run();
    expect(
      (
        await routeDeviceOwner(
          request("/api/devices/enrollment", { name: "Fresh" }),
          env,
          owner,
        )
      )?.status,
    ).toBe(201);
    expect(
      db.prepare("SELECT COUNT(*) n FROM device_enrollments").get(),
    ).toEqual({ n: 1 });
  });
  it("expires ambiguous claims to unknown and bounds terminal history", async () => {
    const device = await enroll();
    const original = await enqueue(device.device_id);
    await poll(device);
    db.prepare("UPDATE device_jobs SET claim_expires_at=1").run();
    const history = await routeDeviceOwner(
      request("/api/devices/jobs", {}, "GET"),
      env,
      owner,
    );
    expect(
      ((await history!.json()) as { jobs: { status: string }[] }).jobs[0]
        .status,
    ).toBe("unknown");
    for (let i = 0; i < 205; i++)
      db.prepare(
        "INSERT INTO device_jobs (job_id,device_id,user_id,workspace_id,conversation_id,confirmation_id,command,cwd,timeout_ms,status,created_at,expires_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,'completed',?,?,?)",
      ).run(
        crypto.randomUUID(),
        device.device_id,
        "owner",
        "default",
        "c",
        crypto.randomUUID(),
        "true",
        "/tmp",
        100,
        Date.now(),
        Date.now(),
        Date.now() + i,
      );
    await routeDeviceOwner(request("/api/devices/jobs", {}, "GET"), env, owner);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM device_jobs WHERE status NOT IN ('queued','claimed')",
        )
        .get(),
    ).toEqual({ n: 200 });
    expect(
      db
        .prepare("SELECT * FROM device_jobs WHERE job_id=?")
        .get(original.job_id),
    ).toBeUndefined();
  });
  it("keeps history bounded by omitting output and provides owner-scoped job details", async () => {
    const device = await enroll();
    await enqueue(device.device_id);
    const job = (await poll(device)).job!;
    await routeDevicePublic(
      await signed(device, "/api/devices/result", result(job)),
      env,
    );
    const list = (await (await routeDeviceOwner(
      request("/api/devices/jobs", {}, "GET"),
      env,
      owner,
    ))!.json()) as { jobs: Record<string, unknown>[] };
    expect(JSON.stringify(list)).not.toContain("stdout");
    expect(list.jobs[0].result_summary).toMatchObject({ exit_code: 0 });
    const detail = await routeDeviceOwner(
      request(`/api/devices/jobs/${job.job_id}`, {}, "GET"),
      env,
      owner,
    );
    expect(detail?.status).toBe(200);
    expect(
      ((await detail!.json()) as { job: { result: { stdout: string } } }).job
        .result.stdout,
    ).toBe("hello");
    expect(
      (
        await routeDeviceOwner(
          request(`/api/devices/jobs/${job.job_id}`, {}, "GET"),
          env,
          { ...owner, userId: "other" },
        )
      )?.status,
    ).toBe(404);
  });
  it("expires queued jobs without running them", async () => {
    const device = await enroll();
    await enqueue(device.device_id);
    db.prepare("UPDATE device_jobs SET expires_at = 1").run();
    expect((await poll(device)).job).toBeNull();
    expect(db.prepare("SELECT status FROM device_jobs").get()).toEqual({
      status: "expired",
    });
  });
});

describe("device tool approval", () => {
  it("requires web approval bound to exact command and target; one approval queues once", async () => {
    const device = await enroll();
    const sql = createSqliteStorage();
    ensureToolConfirmationsSchema(sql);
    const tools = createDeviceTools({
      env,
      sql: sql as unknown as SqlStorage,
      context: {
        user_id: "owner",
        tenant_binding: "default",
        user_role: "owner",
      },
      conversationId: "conversation",
    });
    const execute = tools.run_device_bash.execute! as (
      input: unknown,
    ) => Promise<string>;
    const input = { device_id: device.device_id, ...command };
    const preview = JSON.parse(await execute(input));
    expect(preview.needs_confirmation).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM device_jobs").get()).toEqual({
      n: 0,
    });
    expect(
      JSON.parse(
        await execute({ ...input, confirmation_id: preview.confirmation_id }),
      ).needs_confirmation,
    ).toBe(true);
    expect(
      decideToolConfirmation(
        sql,
        preview.confirmation_id,
        "confirmed",
        Date.now(),
      ),
    ).toBe(true);
    expect(
      JSON.parse(
        await execute({
          ...input,
          command: "rm -rf /tmp/example",
          confirmation_id: preview.confirmation_id,
        }),
      ).needs_confirmation,
    ).toBe(true);
    const queued = JSON.parse(
      await execute({ ...input, confirmation_id: preview.confirmation_id }),
    );
    expect(queued.status).toBe("queued");
    expect(
      JSON.parse(
        await execute({ ...input, confirmation_id: preview.confirmation_id }),
      ).needs_confirmation,
    ).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM device_jobs").get()).toEqual({
      n: 1,
    });
    expect(tools.run_device_bash).not.toHaveProperty("directExecute");
  });
});

describe("device tool cancellation and approval freshness", () => {
  it("rejects expired, cross-conversation and cancelled executions", async () => {
    const device = await enroll();
    const sql = createSqliteStorage();
    ensureToolConfirmationsSchema(sql);
    const base = {
      env,
      sql: sql as unknown as SqlStorage,
      context: {
        user_id: "owner",
        tenant_binding: "default",
        user_role: "owner",
      },
    };
    const execute = createDeviceTools({ ...base, conversationId: "c" })
      .run_device_bash.execute! as (input: unknown) => Promise<string>;
    const input = { device_id: device.device_id, ...command };
    const preview = JSON.parse(await execute(input));
    decideToolConfirmation(
      sql,
      preview.confirmation_id,
      "confirmed",
      Date.now(),
    );
    const otherConversation = createDeviceTools({
      ...base,
      conversationId: "other",
    }).run_device_bash.execute! as (input: unknown) => Promise<string>;
    expect(
      JSON.parse(
        await otherConversation({
          ...input,
          confirmation_id: preview.confirmation_id,
        }),
      ).needs_confirmation,
    ).toBe(true);
    sql.exec(
      "UPDATE tool_confirmations SET expires_at=1 WHERE confirmation_id=?",
      preview.confirmation_id,
    );
    expect(
      JSON.parse(
        await execute({ ...input, confirmation_id: preview.confirmation_id }),
      ).needs_confirmation,
    ).toBe(true);
    const aborted = createDeviceTools({
      ...base,
      conversationId: "c",
      signal: AbortSignal.abort(),
    }).run_device_bash.execute! as (input: unknown) => Promise<string>;
    await expect(aborted(input)).rejects.toThrow();
    expect(db.prepare("SELECT COUNT(*) n FROM device_jobs").get()).toEqual({
      n: 0,
    });
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { executeJob, validateJob } from "../../device-daemon/executor.mjs";
const job = (command, extra = {}) => ({
  job_id: "job-1",
  claim_id: "claim-1",
  device_id: "device-1",
  command,
  cwd: homedir(),
  timeout_ms: 1000,
  expires_at: Date.now() + 10000,
  ...extra,
});
test("executes bash with separate output and no inherited daemon secrets", async () => {
  process.env.DURABLECLAW_TEST_SECRET = "never-inherit";
  const result = await executeJob(
    job(
      'printf "%s" "${DURABLECLAW_TEST_SECRET-unset}"; printf problem >&2; exit 7',
    ),
  );
  assert.equal(result.stdout, "unset");
  assert.equal(result.stderr, "problem");
  assert.equal(result.exit_code, 7);
  delete process.env.DURABLECLAW_TEST_SECRET;
});
test("rejects malformed, expired, wrongly targeted jobs before execution", () => {
  for (const extra of [
    { device_id: "other" },
    { expires_at: 0 },
    { cwd: "relative" },
    { command: "x".repeat(16001) },
    { timeout_ms: 120001 },
    { timeout_ms: 0 },
  ])
    assert.throws(() => validateJob(job("true", extra), "device-1"));
});
test("a missing working directory reports a process-start failure with no exit code", async () => {
  const result = await executeJob(
    job("printf must-not-run", {
      cwd: join(tmpdir(), `durableclaw-missing-${randomUUID()}`),
    }),
  );
  assert.equal(result.exit_code, null);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.match(result.error, /Failed to start bash/);
});
test("bounds combined output by UTF-8 bytes", async () => {
  const result = await executeJob(
    job("yes x | head -c 100000; yes y | head -c 100000 >&2"),
  );
  assert.equal(result.truncated, true);
  assert.ok(
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <=
      65536,
  );
});
test("invalid UTF-8 cannot expand beyond the limit without marking truncation", async () => {
  const result = await executeJob(
    job("LC_ALL=C tr '\\000' '\\377' < /dev/zero | head -c 30000"),
  );
  assert.ok(
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <=
      65536,
  );
  assert.equal(result.truncated, true);
});
test("timeout kills descendants which retain the stdout pipe", async () => {
  const start = Date.now();
  const result = await executeJob(
    job("trap '' TERM; (trap '' TERM; sleep 30) & wait", { timeout_ms: 80 }),
    { killGraceMs: 40 },
  );
  assert.equal(result.timed_out, true);
  assert.ok(Date.now() - start < 2000);
});
test("abort cleans the process group", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const result = await executeJob(job("sleep 30"), {
    signal: controller.signal,
    killGraceMs: 40,
  });
  assert.match(result.error, /shutdown|abort/i);
});

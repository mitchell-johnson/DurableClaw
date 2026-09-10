import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Journal,
  privateWrite,
  ensurePrivateDirectory,
  acquireLock,
} from "../../device-daemon/store.mjs";
import { runCycle, recoverPending } from "../../device-daemon/daemon.mjs";
import { HttpError, AuthError } from "../../device-daemon/protocol.mjs";

const job = () => ({
  job_id: "job-1",
  claim_id: "claim-1",
  device_id: "device-1",
  command: "true",
  cwd: null,
  timeout_ms: 1000,
  expires_at: Date.now() + 10000,
});
const result = (j) => ({
  job_id: j.job_id,
  claim_id: j.claim_id,
  stdout: "ok",
  stderr: "",
  exit_code: 0,
  signal: null,
  timed_out: false,
  truncated: false,
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "durableclaw-test-"));
  const journal = new Journal(directory);
  await journal.init();
  return { directory, journal };
}

test("started job is durable before spawn and result retries never rerun bash", async () => {
  const { journal } = await fixture();
  let runs = 0,
    uploads = 0;
  const j = job();
  const request = async (path) => {
    if (path.endsWith("poll")) return { job: j };
    uploads++;
    if (uploads === 1) throw new Error("offline");
    return { ok: true };
  };
  const execute = async (current) => {
    runs++;
    assert.equal((await journal.read(current.job_id)).state, "started");
    return result(current);
  };
  await assert.rejects(
    runCycle({ journal, deviceId: "device-1", request, execute }),
    /offline/,
  );
  assert.equal((await journal.read(j.job_id)).state, "result");
  await recoverPending({ journal, request });
  await runCycle({ journal, deviceId: "device-1", request, execute });
  assert.equal(runs, 1);
  assert.equal(uploads, 2);
});
test("restart with ambiguous started record reports unknown without running it", async () => {
  const { journal } = await fixture();
  const j = job();
  await journal.start(j);
  let sent;
  await recoverPending({
    journal,
    request: async (_path, body) => {
      sent = body;
      return { ok: true };
    },
  });
  assert.match(sent.error, /unknown.*restart/i);
  assert.equal(sent.exit_code, null);
  assert.equal((await journal.read(j.job_id)).state, "acknowledged");
});
test("wrong device never reaches journal or executor", async () => {
  const { journal } = await fixture();
  let runs = 0;
  await assert.rejects(
    runCycle({
      journal,
      deviceId: "other",
      request: async () => ({ job: job() }),
      execute: async () => {
        runs++;
      },
    }),
    /targeted/,
  );
  assert.equal(runs, 0);
});
test("private files have mode0600 and symlink state directories are rejected", async () => {
  const { directory } = await fixture();
  const path = join(directory, "secret");
  await privateWrite(path, "secret");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(path, "utf8"), "secret");
  const link = join(directory, "link");
  await symlink(directory, link);
  await assert.rejects(ensurePrivateDirectory(link), /symbolic|symlink/i);
});
test("only one daemon process can hold a state lock", async () => {
  const { directory } = await fixture();
  const release = await acquireLock(directory);
  await assert.rejects(acquireLock(directory), /already running/i);
  await release();
  const next = await acquireLock(directory);
  await next();
});
test("terminal stale result response is acknowledged without retrying execution", async () => {
  const { journal } = await fixture();
  const j = job();
  await journal.start(j);
  await journal.result(j, result(j));
  await recoverPending({
    journal,
    request: async () => {
      throw new HttpError(409, "stale");
    },
  });
  assert.equal((await journal.read(j.job_id)).rejected, true);
});
test("revocation preserves pending result without polling for another command", async () => {
  const { journal } = await fixture();
  const j = job();
  await journal.start(j);
  await journal.result(j, result(j));
  let poll = 0;
  await assert.rejects(
    runCycle({
      journal,
      deviceId: "device-1",
      request: async (path) => {
        if (path.endsWith("poll")) poll++;
        throw new AuthError(401, "revoked");
      },
    }),
    AuthError,
  );
  assert.equal(poll, 0);
  assert.equal((await journal.read(j.job_id)).state, "result");
});

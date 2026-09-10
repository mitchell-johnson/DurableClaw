import { createPrivateKey } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { Journal, acquireLock, privateRead } from "./store.mjs";
import {
  deviceRequest,
  AuthError,
  HttpError,
  validateOrigin,
} from "./protocol.mjs";
import { executeJob, validateJob } from "./executor.mjs";

async function upload(journal, entry, request) {
  try {
    await request("/api/devices/result", entry.result);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
    await journal.acknowledge(entry, true);
    return;
  }
  await journal.acknowledge(entry);
}

export async function recoverPending({ journal, request }) {
  for (let entry of await journal.pending()) {
    if (entry.state === "started") {
      const result = {
        job_id: entry.job.job_id,
        claim_id: entry.job.claim_id,
        stdout: "",
        stderr: "",
        exit_code: null,
        signal: null,
        timed_out: false,
        truncated: false,
        error:
          "Execution outcome unknown after daemon restart; command was not replayed",
      };
      await journal.result(entry.job, result);
      entry = { ...entry, state: "result", result };
    }
    await upload(journal, entry, request);
  }
}

export async function runCycle({
  journal,
  deviceId,
  request,
  execute = executeJob,
  signal,
}) {
  await recoverPending({ journal, request });
  if (signal?.aborted) return false;
  const response = await request("/api/devices/poll", {});
  if (!response || !Object.hasOwn(response, "job"))
    throw new Error("Invalid polling response");
  if (response.job === null) return false;
  const job = validateJob(response.job, deviceId);
  const previous = await journal.read(job.job_id);
  if (previous) return false;
  await journal.start(job);
  let result;
  try {
    result = await execute(job, { signal });
  } catch {
    result = {
      job_id: job.job_id,
      claim_id: job.claim_id,
      stdout: "",
      stderr: "",
      exit_code: null,
      signal: null,
      timed_out: false,
      truncated: false,
      error:
        "Execution failed; effects may be unknown. Command was not replayed",
    };
  }
  await journal.result(job, result);
  // Persist the result even when shutdown aborts its upload. Next run only uploads it.
  if (!signal?.aborted) await upload(journal, { job, result }, request);
  return true;
}

export async function runDaemon(
  directory,
  { signal, log = console.error, fetchImpl = fetch } = {},
) {
  if (process.getuid?.() === 0)
    throw new Error("Run the device daemon as a regular user, never root");
  const release = await acquireLock(directory);
  try {
    const config = JSON.parse(
      await privateRead(join(directory, "config.json")),
    );
    validateOrigin(config.origin, config.allowLocalHttp === true);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(config.deviceId))
      throw new Error("Invalid device configuration");
    const privateKey = createPrivateKey({
      key: Buffer.from(await privateRead(join(directory, "private-key.pem"))),
      format: "pem",
      type: "pkcs8",
    });
    if (privateKey.asymmetricKeyType !== "ed25519")
      throw new Error("Device key must be Ed25519");
    const journal = new Journal(directory);
    await journal.init();
    const request = (path, body) =>
      deviceRequest(config, privateKey, path, body, { signal, fetchImpl });
    let failures = 0;
    while (!signal?.aborted) {
      let wait = 3000;
      try {
        const worked = await runCycle({
          journal,
          deviceId: config.deviceId,
          request,
          signal,
        });
        failures = 0;
        if (worked) wait = 250;
      } catch (error) {
        if (signal?.aborted) break;
        if (error instanceof AuthError) {
          log(
            "Device authentication denied; execution paused. Check device revocation, owner access, and system clock.",
          );
          wait = 60000;
        } else if (
          error instanceof HttpError &&
          [400, 413].includes(error.status)
        ) {
          throw new Error(
            "Device protocol rejected; preserved journal for inspection",
          );
        } else {
          failures += 1;
          wait = Math.min(60000, 1000 * 2 ** Math.min(failures, 6));
          log(
            `Device connection or journal error; retrying in ${Math.ceil(wait / 1000)} seconds.`,
          );
        }
      }
      try {
        await delay(wait + Math.floor(Math.random() * 500), undefined, {
          signal,
        });
      } catch (error) {
        if (!signal?.aborted) throw error;
      }
    }
  } finally {
    await release();
  }
}

import { spawn } from "node:child_process";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute } from "node:path";

export const OUTPUT_LIMIT = 65536;
const id = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export function validateJob(job, deviceId, now = Date.now()) {
  if (
    !job ||
    !id(job.job_id) ||
    !id(job.claim_id) ||
    job.device_id !== deviceId ||
    typeof job.command !== "string" ||
    !job.command.length ||
    job.command.length > 16000 ||
    job.command.includes("\0") ||
    (job.cwd !== null &&
      job.cwd !== undefined &&
      (typeof job.cwd !== "string" ||
        !isAbsolute(job.cwd) ||
        job.cwd.includes("\0"))) ||
    !Number.isSafeInteger(job.timeout_ms) ||
    job.timeout_ms < 1 ||
    job.timeout_ms > 120000 ||
    !Number.isSafeInteger(job.expires_at) ||
    job.expires_at <= now
  )
    throw new Error("Invalid, expired, or wrongly targeted command job");
  return job;
}

function utf8Prefix(text, limit) {
  return new TextDecoder().decode(Buffer.from(text).subarray(0, limit), {
    stream: true,
  });
}

export async function executeJob(job, { signal, killGraceMs = 500 } = {}) {
  validateJob(job, job.device_id);
  const base = {
    job_id: job.job_id,
    claim_id: job.claim_id,
    stdout: "",
    stderr: "",
    exit_code: null,
    signal: null,
    timed_out: false,
    truncated: false,
  };
  if (signal?.aborted)
    return { ...base, error: "Execution cancelled during daemon shutdown" };
  return new Promise((resolve) => {
    const child = spawn(
      "/bin/bash",
      ["--noprofile", "--norc", "-c", job.command],
      {
        cwd: job.cwd ?? homedir(),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          HOME: homedir(),
          USER: userInfo().username,
          LOGNAME: userInfo().username,
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "en_US.UTF-8",
          TMPDIR: tmpdir(),
        },
      },
    );
    const output = { stdout: [], stderr: [] };
    let bytes = 0,
      spawnFailed = false,
      stopping = false,
      stopComplete,
      stopPromise = Promise.resolve();
    const killGroup = (kind) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, kind);
      } catch (error) {
        if (error.code !== "ESRCH")
          base.error = "Unable to terminate command process group";
      }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      stopPromise = new Promise((done) => {
        stopComplete = done;
      });
      killGroup("SIGTERM");
      setTimeout(() => {
        killGroup("SIGKILL");
        stopComplete();
      }, killGraceMs);
    };
    const abort = () => {
      base.error = "Execution cancelled during daemon shutdown";
      stop();
    };
    const timer = setTimeout(() => {
      base.timed_out = true;
      stop();
    }, job.timeout_ms);
    signal?.addEventListener("abort", abort, { once: true });
    for (const name of ["stdout", "stderr"])
      child[name].on("data", (chunk) => {
        const remaining = Math.max(0, OUTPUT_LIMIT - bytes);
        if (chunk.length > remaining) base.truncated = true;
        if (remaining) {
          const piece = chunk.subarray(0, remaining);
          output[name].push(piece);
          bytes += piece.length;
        }
      });
    child.on("error", () => {
      spawnFailed = true;
      base.error =
        "Failed to start bash (check working directory and executable)";
    });
    child.on("close", async (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      await stopPromise;
      const stdout = Buffer.concat(output.stdout).toString("utf8");
      const stderr = Buffer.concat(output.stderr).toString("utf8");
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > OUTPUT_LIMIT)
        base.truncated = true;
      base.stdout = utf8Prefix(stdout, OUTPUT_LIMIT);
      base.stderr = utf8Prefix(
        stderr,
        OUTPUT_LIMIT - Buffer.byteLength(base.stdout),
      );
      // Node reports spawn failures as negative libuv errors (for example
      // ENOENT is -2), not shell exit statuses. No process exited in that case.
      base.exit_code = spawnFailed ? null : code;
      base.signal = spawnFailed ? null : exitSignal;
      resolve(base);
    });
    if (signal?.aborted) abort();
  });
}

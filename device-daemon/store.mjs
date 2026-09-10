import { constants } from "node:fs";
import {
  mkdir,
  lstat,
  open,
  rename,
  unlink,
  readdir,
  rm,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("State directory must not be a symlink");
  if (info.mode & 0o077 || (process.getuid && info.uid !== process.getuid()))
    throw new Error(
      "State directory must be owned by this user with mode 0700",
    );
}

export async function privateWrite(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function privateRead(path, maxBytes = 524288) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error(
        "Private file permissions must be 0600 and owned by this user",
      );
    if (info.size > maxBytes) throw new Error("Private file is too large");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export class Journal {
  constructor(directory) {
    this.directory = join(directory, "jobs");
  }
  async init() {
    await ensurePrivateDirectory(this.directory);
  }
  path(id) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      throw new Error("Invalid journal job ID");
    return join(this.directory, `${id}.json`);
  }
  async read(id) {
    try {
      return JSON.parse(await privateRead(this.path(id)));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async save(id, value) {
    await privateWrite(this.path(id), JSON.stringify(value));
  }
  async start(job) {
    if (await this.read(job.job_id)) throw new Error("Job already journaled");
    await this.save(job.job_id, { state: "started", job });
  }
  async result(job, result) {
    await this.save(job.job_id, { state: "result", job, result });
  }
  async acknowledge(entry, rejected = false) {
    await this.save(entry.job.job_id, {
      state: "acknowledged",
      job: {
        job_id: entry.job.job_id,
        claim_id: entry.job.claim_id,
        expires_at: entry.job.expires_at,
      },
      rejected,
    });
  }
  async pending() {
    const entries = [];
    for (const name of await readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      const entry = await this.read(name.slice(0, -5));
      if (
        !entry ||
        !["started", "result", "acknowledged"].includes(entry.state) ||
        !entry.job
      )
        throw new Error("Invalid job journal; refusing to execute");
      if (entry.state !== "acknowledged") entries.push(entry);
      else if (entry.job.expires_at < Date.now() - 7 * 86400000)
        await unlink(this.path(entry.job.job_id));
    }
    return entries;
  }
}

export async function acquireLock(directory) {
  await ensurePrivateDirectory(directory);
  const gate = join(directory, ".startup-lock");
  try {
    await mkdir(gate, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Another daemon startup is running, or an interrupted startup left .startup-lock; inspect status before removing it",
      );
    throw error;
  }
  const path = join(directory, "daemon.lock");
  const token = randomUUID();
  try {
    let previous;
    try {
      previous = JSON.parse(await privateRead(path, 2048));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (previous) {
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0)
        throw new Error("Invalid daemon lock");
      let alive = true;
      try {
        process.kill(previous.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") alive = false;
        else throw error;
      }
      if (alive) throw new Error("Daemon already running");
    }
    await privateWrite(path, JSON.stringify({ pid: process.pid, token }));
  } finally {
    await rm(gate, { recursive: true });
  }
  return async () => {
    const current = JSON.parse(await privateRead(path, 2048));
    if (current.token === token) await unlink(path);
  };
}

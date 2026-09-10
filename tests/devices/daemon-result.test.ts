import { it, expect } from "vitest";
import Database from "better-sqlite3";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPrincipal, Env } from "../../src/types";
import { routeDevicePublic } from "../../src/devices/routes";
import { enqueueDeviceJob } from "../../src/devices/store";
import { deviceRequest } from "../../device-daemon/protocol.mjs";
import { Journal } from "../../device-daemon/store.mjs";
import { runCycle } from "../../device-daemon/daemon.mjs";

it("accepts a real daemon spawn failure and proceeds to the next approved command", async () => {
  const db = new Database(":memory:");
  const directory = await mkdtemp(join(tmpdir(), "durableclaw-result-"));
  try {
    db.exec(
      readFileSync(
        new URL("../../migrations/0003_devices.sql", import.meta.url),
        "utf8",
      ),
    );
    const statement = (
      query: string,
      values: unknown[] = [],
    ): D1PreparedStatement => {
      const prepared = db.prepare(query);
      const rows = () =>
        prepared.reader
          ? prepared.all(...values)
          : (prepared.run(...values), []);
      const execute = async () => ({
        results: rows(),
        success: true,
        meta: {
          changes: (db.prepare("SELECT changes() AS n").get() as { n: number })
            .n,
        },
      });
      return {
        bind: (...bindings: unknown[]) => statement(query, bindings),
        first: async (column?: string) => {
          const row = rows()[0] as Record<string, unknown> | undefined;
          return column ? (row?.[column] ?? null) : (row ?? null);
        },
        all: execute,
        run: execute,
      } as D1PreparedStatement;
    };
    const env = {
      AGENT_TOKEN: "test-owner-token",
      CONTROL_DB: {
        prepare: statement,
        batch: async (statements: D1PreparedStatement[]) => {
          db.exec("BEGIN");
          try {
            const results = [];
            for (const current of statements) results.push(await current.all());
            db.exec("COMMIT");
            return results;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        },
      },
    } as unknown as Env;
    const owner: AgentPrincipal = {
      userId: "owner",
      workspaceId: "default",
      role: "owner",
    };
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const deviceId = randomUUID();
    db.prepare(
      "INSERT INTO devices (device_id,user_id,workspace_id,name,public_key,created_at) VALUES (?,?,?,?,?,?)",
    ).run(
      deviceId,
      owner.userId,
      owner.workspaceId,
      "Test Mac",
      publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      Date.now(),
    );
    const journal = new Journal(directory);
    await journal.init();
    const uploads: number[] = [];
    const request = (path: string, body: unknown) =>
      deviceRequest(
        { deviceId, origin: "https://agent.example" },
        privateKey,
        path,
        body,
        {
          fetchImpl: async (url: string | URL, options: RequestInit) => {
            const response = await routeDevicePublic(
              new Request(url, options),
              env,
              async () => true,
            );
            if (path.endsWith("/result")) uploads.push(response!.status);
            return response!;
          },
        },
      );
    const first = await enqueueDeviceJob(env, owner, {
      device_id: deviceId,
      conversation_id: "test",
      confirmation_id: randomUUID(),
      command: "printf must-not-run",
      cwd: join(directory, "does-not-exist"),
      timeout_ms: 1000,
    });
    await runCycle({ journal, deviceId, request });
    expect((await journal.read(first.job_id)).state).toBe("acknowledged");
    const failed = db
      .prepare("SELECT status,result_json FROM device_jobs WHERE job_id=?")
      .get(first.job_id) as { status: string; result_json: string };
    expect(failed.status).toBe("completed");
    expect(JSON.parse(failed.result_json)).toMatchObject({
      exit_code: null,
      stdout: "",
      error: expect.stringContaining("Failed to start bash"),
    });

    const second = await enqueueDeviceJob(env, owner, {
      device_id: deviceId,
      conversation_id: "test",
      confirmation_id: randomUUID(),
      command: "printf next-command",
      cwd: directory,
      timeout_ms: 1000,
    });
    await runCycle({ journal, deviceId, request });
    expect((await journal.read(second.job_id)).state).toBe("acknowledged");
    const completed = db
      .prepare("SELECT result_json FROM device_jobs WHERE job_id=?")
      .get(second.job_id) as { result_json: string };
    expect(JSON.parse(completed.result_json)).toMatchObject({
      exit_code: 0,
      stdout: "next-command",
    });
    expect(uploads).toEqual([200, 200]);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

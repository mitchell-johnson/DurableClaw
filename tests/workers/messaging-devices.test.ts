import { beforeAll, describe, expect, it } from "vitest";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import migration1 from "../../migrations/0001_control.sql?raw";
import migration2 from "../../migrations/0002_messaging.sql?raw";
import migration3 from "../../migrations/0003_devices.sql?raw";
import migration4 from "../../migrations/0004_messaging_approvals.sql?raw";
import { createDeviceTools } from "../../src/devices/tools";
import { doName } from "../../src/durable-objects/assistant/principal";
import {
  createMessagingRegistry,
  type MessagingPlugin,
} from "../../src/channels/plugin";
import {
  handleMessagingOwnerRequest,
  handleMessagingWebhook,
} from "../../src/channels/service";

const runtime = env as any;
const origin = "https://app.example.invalid";
const auth = {
  authorization: "Bearer test-only-token",
  "content-type": "application/json",
};
const owner = { userId: "owner", workspaceId: "default", role: "owner" };
beforeAll(async () => {
  for (const migration of [migration1, migration2, migration3, migration4])
    for (const sql of migration
      .replace(/--.*$/gm, "")
      .split(";")
      .filter((part) => part.trim()))
      await runtime.CONTROL_DB.prepare(sql).run();
});
const api = (path: string, body?: object, method = body ? "POST" : "GET") =>
  SELF.fetch(origin + path, {
    method,
    headers: auth,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
async function paired() {
  const response = await api("/api/devices/enrollment", {
    name: "Native test Mac",
  });
  expect(response.status).toBe(201);
  const { code } = (await response.json()) as { code: string };
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
  const enrollment = { code, public_key, proof };
  const result = await SELF.fetch(origin + "/api/devices/enroll", {
    method: "POST",
    body: JSON.stringify(enrollment),
  });
  expect(result.status).toBe(201);
  const { device_id } = (await result.json()) as { device_id: string };
  const signed = async (path: string, data: object = {}) => {
    const body = JSON.stringify(data);
    const time = String(Date.now());
    const nonce = crypto.randomUUID();
    const hash = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    ).toString("hex");
    const signature = Buffer.from(
      await crypto.subtle.sign(
        "Ed25519",
        keys.privateKey,
        new TextEncoder().encode(
          `durableclaw-device-v1\n${device_id}\nPOST\n${origin + path}\n${time}\n${nonce}\n${hash}`,
        ),
      ),
    ).toString("base64");
    return new Request(origin + path, {
      method: "POST",
      body,
      headers: {
        "X-Device-Id": device_id,
        "X-Device-Timestamp": time,
        "X-Device-Nonce": nonce,
        "X-Device-Signature": signature,
      },
    });
  };
  return { device_id, signed, enrollment };
}
describe("integrated messaging and devices on native Cloudflare storage", () => {
  it("claims one approved command and preserves its result without granting device admin access", async () => {
    const device = await paired();
    const conversationId = crypto.randomUUID();
    await api("/api/agent/init", { conversation_id: conversationId });
    const stub = runtime.NANO_CHAT_AGENT.get(
      runtime.NANO_CHAT_AGENT.idFromName(doName("owner", "default")),
    );
    const input = {
      device_id: device.device_id,
      command: "printf 'native test'",
      cwd: "/tmp",
      timeout_ms: 10000,
    };
    const run = (approval?: string) =>
      runInDurableObject(
        stub,
        async (_agent: unknown, state: DurableObjectState) => {
          const tools = createDeviceTools({
            env: runtime,
            sql: state.storage.sql,
            context: {
              user_id: "owner",
              tenant_binding: "default",
              user_role: "owner",
            },
            conversationId,
          });
          return JSON.parse(
            await (tools.run_device_bash.execute as any)({
              ...input,
              ...(approval ? { confirmation_id: approval } : {}),
            }),
          );
        },
      );
    const preview = await run();
    expect(preview.needs_confirmation).toBe(true);
    expect(
      (
        (await (
          await SELF.fetch(await device.signed("/api/devices/poll"))
        ).json()) as any
      ).job,
    ).toBeNull();
    expect(
      (
        await api(
          `/api/agent/conversations/${conversationId}/confirmations/${preview.confirmation_id}`,
          { decision: "confirmed" },
        )
      ).status,
    ).toBe(200);
    const queued = await run(preview.confirmation_id);
    expect(queued.status).toBe("queued");
    const pollRequest = await device.signed("/api/devices/poll");
    const poll = await SELF.fetch(pollRequest.clone());
    const { job } = (await poll.json()) as any;
    expect(job.command).toBe(input.command);
    expect((await SELF.fetch(pollRequest)).status).toBe(401);
    expect(
      (
        (await (
          await SELF.fetch(await device.signed("/api/devices/poll"))
        ).json()) as any
      ).job,
    ).toBeNull();
    const result = {
      job_id: job.job_id,
      claim_id: job.claim_id,
      stdout: "native test",
      stderr: "",
      exit_code: 0,
      signal: null,
      timed_out: false,
      truncated: false,
    };
    expect(
      (await SELF.fetch(await device.signed("/api/devices/result", result)))
        .status,
    ).toBe(200);
    expect(
      (await SELF.fetch(await device.signed("/api/devices/result", result)))
        .status,
    ).toBe(200);
    const detail = (await (
      await api(`/api/devices/jobs/${job.job_id}`)
    ).json()) as any;
    expect(detail.job.result.stdout).toBe("native test");
    expect(
      (
        await SELF.fetch(
          await device.signed("/api/devices/enrollment", {
            name: "unauthorized",
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (await api(`/api/devices/${device.device_id}`, undefined, "DELETE"))
        .status,
    ).toBe(200);
    expect(
      (await SELF.fetch(await device.signed("/api/devices/poll"))).status,
    ).toBe(401);
    expect(
      (
        await SELF.fetch(origin + "/api/devices/enroll", {
          method: "POST",
          body: JSON.stringify(device.enrollment),
        })
      ).status,
    ).toBe(401);
  });
  it("atomically links and deduplicates normalized messaging events in real D1", async () => {
    let content = "";
    let eventId = "1";
    let sends = 0;
    let dispatches = 0;
    const plugin: MessagingPlugin = {
      id: "native-test",
      label: "Native test",
      configured: () => true,
      receive: async () => ({
        eventId,
        senderId: "42",
        chatId: "42",
        content,
        occurredAt: Date.now(),
      }),
      send: async () => {
        sends++;
      },
    };
    const registry = createMessagingRegistry([plugin]);
    const response = await handleMessagingOwnerRequest(
      new Request(origin + "/api/messaging/link-codes", {
        method: "POST",
        body: JSON.stringify({
          pluginId: plugin.id,
          conversationId: "native-conversation",
        }),
      }),
      runtime,
      owner,
      registry,
    );
    const { code } = (await response!.json()) as { code: string };
    content = `/start ${code}`;
    const webhook = () =>
      handleMessagingWebhook(
        new Request(origin + "/api/messaging/webhooks/native-test", {
          method: "POST",
          body: "{}",
        }),
        runtime,
        async (principal) => {
          expect(principal).toEqual(owner);
          dispatches++;
          return { text: "hello" };
        },
        registry,
      );
    expect((await webhook()).status).toBe(200);
    content = "hello";
    eventId = "2";
    await Promise.all([webhook(), webhook()]);
    expect(dispatches).toBe(1);
    expect(sends).toBe(2);
    const links = await handleMessagingOwnerRequest(
      new Request(origin + "/api/messaging/links"),
      runtime,
      owner,
      registry,
    );
    expect(((await links!.json()) as any).links[0].senderId).toBe("42");
  });
});

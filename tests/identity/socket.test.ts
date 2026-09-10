import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  env,
  SELF,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { doName } from "../../src/durable-objects/assistant/principal";
import migration from "../../migrations/0001_control.sql?raw";

const runtime = env as any;
const origin = "https://identity.example.test";
const identity = () =>
  runtime.IDENTITY.get(runtime.IDENTITY.idFromName("owner/default"));
const agent = () =>
  runtime.NANO_CHAT_AGENT.get(
    runtime.NANO_CHAT_AGENT.idFromName(doName("owner", "default")),
  );
beforeAll(async () => {
  for (const sql of migration.split(";").filter((part) => part.trim()))
    await runtime.CONTROL_DB.prepare(sql).run();
});
afterEach(async () => {
  // Both real Worker routes address the same owner object. Release its
  // hibernatable sockets before the test pool restores isolated storage.
  await evictDurableObject(agent(), { webSockets: "close" });
});

async function connected() {
  const bootstrap = await identity().bootstrapAccess(
    new Request(origin + "/api/auth/access"),
    {
      issuedAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
      authenticatedAt: null,
    },
  );
  expect(bootstrap.status).toBe(303);
  const cookie = bootstrap.headers
    .getSetCookie()
    .map((value: string) => value.split(";")[0])
    .join("; ");
  const headers = { origin, cookie, "content-type": "application/json" };
  const api = async (path: string, body: unknown) => {
    const response = await SELF.fetch(origin + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    // Finish the Worker request's response stream before isolated-storage
    // teardown; callers may only inspect the returned status.
    return new Response(await response.arrayBuffer(), response);
  };
  expect((await api("/api/agent/init", {})).status).toBe(200);
  const conversation = "auth_" + crypto.randomUUID().replaceAll("-", "");
  const ticket = (await (
    await api("/api/socket-ticket", { conversation_id: conversation })
  ).json()) as any;
  const upgrade = await SELF.fetch(
    `${origin}/api/agent/connect?conversation_id=${conversation}&ticket=${ticket.ticket}`,
    { headers: { ...headers, Upgrade: "websocket" } },
  );
  expect(upgrade.status).toBe(101);
  const socket = upgrade.webSocket!;
  // Match a real browser's close acknowledgement explicitly in the test client.
  socket.accept({ allowHalfOpen: true });
  for (const path of ["/api/agent/init", "/api/agent/persona"]) {
    const alternate = await SELF.fetch(
      origin + path + "?conversation_id=" + conversation,
      { headers: { ...headers, Upgrade: "websocket" } },
    );
    expect(alternate.status).toBe(400);
    await alternate.arrayBuffer();
  }
  const proof = await identity().sessionReference(
    new Request(origin + "/api/session", { headers }),
  );
  expect(proof).not.toBeNull();
  expect(
    await runInDurableObject(agent(), async (_instance, state) =>
      state
        .getWebSockets()
        .some(
          (ws) =>
            (ws.deserializeAttachment() as any)?.identitySessionId === proof.id,
        ),
    ),
  ).toBe(true);
  return { api, socket, conversation, proof };
}

function closed(socket: WebSocket) {
  return new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Revoked socket was not closed")),
      6000,
    );
    socket.addEventListener(
      "close",
      (event) => {
        clearTimeout(timeout);
        socket.close();
        resolve(event.code);
      },
      { once: true },
    );
  });
}

describe("native sessions on established chat connections", () => {
  it("rejects commands after logout through the real Worker route", async () => {
    const { api, socket, conversation } = await connected();
    await runInDurableObject(agent(), async (instance: any) =>
      instance.appendMessage({
        conversationId: conversation,
        role: "user",
        content: "Must survive a revoked clear command",
      }),
    );
    expect((await api("/api/auth/sign-out", {})).status).toBe(200);
    const closing = closed(socket);
    socket.send(JSON.stringify({ type: "clear" }));
    expect(await closing).toBe(1008);
    expect(
      await runInDurableObject(
        agent(),
        async (_instance, state) =>
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?",
              conversation,
            )
            .one().count,
      ),
    ).toBe(1);
  });

  it("closes an expired socket before an outbound broadcast after attachment rehydration", async () => {
    const { socket, conversation, proof } = await connected();
    await runInDurableObject(identity(), async (_instance, state) =>
      state.storage.sql
        .exec(
          "UPDATE identity_session SET expires_at=? WHERE id=?",
          Date.now() - 1,
          proof.id,
        )
        .toArray(),
    );
    const delivered: string[] = [];
    socket.addEventListener("message", (event) =>
      delivered.push(String(event.data)),
    );
    const closing = closed(socket);
    await runInDurableObject(agent(), async (instance: any, state) => {
      // Delivery must reconstruct its state from the persisted attachment.
      instance.socketContext.clear();
      instance.sendToConversation(conversation, {
        type: "secret_after_expiry",
      });
      await Promise.all(
        state.getWebSockets().map((ws) => instance.socketSendQueue.get(ws)),
      );
    });
    expect(await closing).toBe(1008);
    expect(
      delivered.some((value) => value.includes("secret_after_expiry")),
    ).toBe(false);
  });
});

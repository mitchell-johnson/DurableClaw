import { beforeAll, describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { createInternalAuthHeaders } from "../../src/utils/internalAuth";
import migration from "../../migrations/0001_control.sql?raw";

const runtime = env as any;
const principal = {
  userId: "owner",
  organizationId: "default",
  tenantBinding: "default",
  role: "owner",
};
beforeAll(async () => {
  for (const sql of migration.split(";").filter((s) => s.trim()))
    await runtime.CONTROL_DB.prepare(sql).run();
});
async function initialized() {
  const stub = runtime.NANO_CHAT_AGENT.get(
    runtime.NANO_CHAT_AGENT.idFromName(crypto.randomUUID()),
  );
  await stub.fetch("https://agent/init", {
    method: "POST",
    headers: await createInternalAuthHeaders(
      principal,
      "test-only-internal-secret",
    ),
    body: JSON.stringify({ conversation_id: "conversation" }),
  });
  return stub;
}
function socket(identitySessionId?: string) {
  const sent: unknown[] = [],
    closes: number[] = [];
  return {
    readyState: WebSocket.OPEN,
    sent,
    closes,
    deserializeAttachment: () => ({
      conversation_id: "conversation",
      ...(identitySessionId === undefined ? {} : { identitySessionId }),
    }),
    send(value: string) {
      sent.push(JSON.parse(value));
    },
    close(code: number) {
      closes.push(code);
      this.readyState = WebSocket.CLOSING;
    },
  };
}
function identity(check: (id: string) => Promise<boolean>) {
  return {
    idFromName: (name: string) => {
      if (name !== "owner/default") throw new Error("Wrong owner");
      return name;
    },
    get: () => ({ sessionActive: check }),
  };
}
describe("native WebSocket session lifetime", () => {
  it.each(["AUTH_ORIGIN", "AUTH_SECRET"])(
    "rejects a missing native reference at upgrade when %s is configured",
    async (field) => {
      const stub = await initialized();
      await runInDurableObject(stub, (agent: any) => {
        agent.env = { ...env, [field]: "configured" };
      });
      const response = await stub.fetch(
        "https://agent/connect?conversation_id=conversation",
        {
          headers: {
            ...(await createInternalAuthHeaders(
              principal,
              "test-only-internal-secret",
            )),
            Upgrade: "websocket",
          },
        },
      );
      if (response.webSocket) {
        const ws = response.webSocket;
        ws.accept();
        const closed = new Promise<void>((resolve) =>
          ws.addEventListener("close", () => resolve(), { once: true }),
        );
        ws.close();
        await closed;
      }
      expect(response.status).toBe(401);
    },
  );
  it.each(["incoming", "direct", "broadcast"])(
    "rejects an old unbound attachment on %s in a native installation",
    async (operation) => {
      const result = await runInDurableObject(
        await initialized(),
        async (agent: any, state: DurableObjectState) => {
          agent.env = {
            ...env,
            AUTH_ORIGIN: "https://identity.example.test",
            AUTH_SECRET: "configured",
          };
          agent.appendMessage({
            conversationId: "conversation",
            role: "user",
            content: "Preserve history",
          });
          const ws = socket();
          if (operation === "incoming")
            await agent.webSocketMessage(ws, JSON.stringify({ type: "clear" }));
          else if (operation === "direct")
            agent.sendWS(ws, { type: "private_update" });
          else {
            agent.state = {
              getWebSockets: () => [ws],
              waitUntil: (promise: Promise<unknown>) =>
                state.waitUntil(promise),
            };
            agent.sendToConversation("conversation", {
              type: "private_update",
            });
          }
          await agent.socketSendQueue?.get(ws);
          return {
            sent: ws.sent,
            closes: ws.closes,
            count: state.storage.sql
              .exec(
                "SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?",
                "conversation",
              )
              .one().n,
          };
        },
      );
      expect(result).toEqual({ sent: [], closes: [1008], count: 1 });
    },
  );
  it.each(["revoked", "expired", "unavailable"])(
    "blocks incoming conversation mutations for a %s session after attachment rehydration",
    async (reason) => {
      const result = await runInDurableObject(
        await initialized(),
        async (_instance: any, state: DurableObjectState) => {
          const references: string[] = [];
          const agent = _instance;
          agent.env = {
            ...env,
            IDENTITY: identity(async (id) => {
              references.push(id);
              if (reason === "unavailable")
                throw new Error("private identity failure");
              return false;
            }),
          };
          agent.appendMessage({
            conversationId: "conversation",
            role: "user",
            content: "Preserve history",
          });
          const ws = socket("native_session");
          await agent.webSocketMessage(ws, JSON.stringify({ type: "clear" }));
          return {
            count: state.storage.sql
              .exec(
                "SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?",
                "conversation",
              )
              .one().n,
            closes: ws.closes,
            sent: ws.sent,
            references,
          };
        },
      );
      expect(result).toEqual({
        count: 1,
        closes: [1008],
        sent: [],
        references: ["native_session"],
      });
    },
  );
  it("checks each queued native frame in order and drops output after revocation", async () => {
    const result = await runInDurableObject(
      await initialized(),
      async (_instance: any, state: DurableObjectState) => {
        let checks = 0;
        const agent = _instance;
        agent.env = {
          ...env,
          IDENTITY: identity(async () => ++checks === 1),
        };
        const ws = socket("native_session");
        agent.sendWS(ws, { type: "first" });
        agent.sendWS(ws, { type: "second" });
        agent.sendWS(ws, { type: "third" });
        await agent.socketSendQueue?.get(ws);
        return { sent: ws.sent, closes: ws.closes, checks };
      },
    );
    expect(result).toEqual({
      sent: [{ type: "first" }],
      closes: [1008],
      checks: 2,
    });
  });
  it("validates broadcasts without interrupting legacy sockets", async () => {
    const result = await runInDurableObject(
      await initialized(),
      async (_instance: any, state: DurableObjectState) => {
        const agent = _instance;
        agent.env = {
          ...env,
          IDENTITY: identity(async () => false),
        };
        const native = socket("native_session"),
          legacy = socket();
        agent.state = {
          getWebSockets: () => [native, legacy],
          waitUntil: (promise: Promise<unknown>) => state.waitUntil(promise),
        };
        agent.sendToConversation("conversation", { type: "private_update" });
        await agent.socketSendQueue?.get(native);
        return {
          native: native.sent,
          legacy: legacy.sent,
          closes: native.closes,
        };
      },
    );
    expect(result).toEqual({
      native: [],
      legacy: [{ type: "private_update" }],
      closes: [1008],
    });
  });
  it("never treats a malformed native attachment as a legacy session", async () => {
    const result = await runInDurableObject(
      await initialized(),
      async (_instance: any, state: DurableObjectState) => {
        const agent = _instance;
        const ws = socket("invalid/session");
        agent.sendWS(ws, { type: "private_update" });
        await agent.socketSendQueue?.get(ws);
        return { sent: ws.sent, closes: ws.closes };
      },
    );
    expect(result).toEqual({ sent: [], closes: [1008] });
  });
  it("stores the verified reference in a real accepted socket attachment", async () => {
    const stub = await initialized();
    await runInDurableObject(stub, (agent: any) => {
      agent.env = { ...env, IDENTITY: identity(async () => true) };
    });
    const response = await stub.fetch(
      "https://agent/connect?conversation_id=conversation",
      {
        headers: {
          ...(await createInternalAuthHeaders(
            { ...principal, identitySessionId: "native_session" },
            "test-only-internal-secret",
          )),
          Upgrade: "websocket",
        },
      },
    );
    response.webSocket?.accept();
    const attachment = await runInDurableObject(
      stub,
      (_agent: any, state: DurableObjectState) =>
        state.getWebSockets()[0]?.deserializeAttachment(),
    );
    const closed = new Promise<void>((resolve) =>
      response.webSocket!.addEventListener("close", () => resolve(), {
        once: true,
      }),
    );
    response.webSocket!.close();
    await closed;
    expect({ status: response.status, attachment }).toEqual({
      status: 101,
      attachment: {
        conversation_id: "conversation",
        identitySessionId: "native_session",
      },
    });
  });
});

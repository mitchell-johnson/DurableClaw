import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { NanoChatAgent } from "../../src/durable-objects/NanoChatAgent";
import { createInternalAuthHeaders } from "../../src/utils/internalAuth";
import { defineConfirmTool } from "../../src/action-library/helpers";
import {
  makeSqliteConfirmationCoordinator,
  pendingToolConfirmationReviews,
} from "../../src/durable-objects/assistant/toolConfirmations";
import { sendApprovalCards } from "../../src/channels/approvals";
import {
  createMessagingRegistry,
  type MessagingApprovalEvent,
  type MessagingDispatch,
  type MessagingPlugin,
  type MessagingReply,
} from "../../src/channels/plugin";
import { handleMessagingWebhook } from "../../src/channels/service";
import migration1 from "../../migrations/0001_control.sql?raw";
import migration2 from "../../migrations/0002_messaging.sql?raw";
import migration4 from "../../migrations/0004_messaging_approvals.sql?raw";

const runtime = env as any;
const principal = { userId: "owner", workspaceId: "default", role: "owner" };
beforeAll(async () => {
  for (const migration of [migration1, migration2, migration4])
    for (const statement of migration
      .replace(/--.*$/gm, "")
      .split(";")
      .filter((s) => s.trim()))
      await runtime.CONTROL_DB.prepare(statement).run();
});
beforeEach(async () => {
  await runtime.CONTROL_DB.batch(
    ["messaging_approvals", "messaging_deliveries", "messaging_links"].map(
      (table) => runtime.CONTROL_DB.prepare(`DELETE FROM ${table}`),
    ),
  );
});

async function withLinkedAgent(test: (fixture: any) => Promise<void>) {
  const conversationId = crypto.randomUUID();
  const link = {
    id: crypto.randomUUID(),
    user_id: "owner",
    workspace_id: "default",
    plugin_id: "telegram",
    sender_id: "42",
    chat_id: "42",
    conversation_id: conversationId,
  };
  await runtime.CONTROL_DB.prepare(
    "INSERT INTO messaging_links VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      link.id,
      link.user_id,
      link.workspace_id,
      link.plugin_id,
      link.sender_id,
      link.chat_id,
      conversationId,
      Date.now(),
    )
    .run();
  const stub = runtime.NANO_CHAT_AGENT.get(
    runtime.NANO_CHAT_AGENT.idFromName(crypto.randomUUID()),
  );
  await runInDurableObject(
    stub,
    async (_original: unknown, state: DurableObjectState) => {
      const background: Promise<unknown>[] = [];
      let initialized!: Promise<unknown>;
      const agent = new NanoChatAgent(
        {
          storage: state.storage,
          blockConcurrencyWhile: (work: () => Promise<unknown>) => {
            initialized = work();
          },
          getWebSockets: () => [],
          waitUntil: (work: Promise<unknown>) => background.push(work),
        } as any,
        { ...runtime },
      ) as any;
      await initialized;
      agent.persistContext({
        user_id: "owner",
        user_name: "Owner",
        user_role: "owner",
        organization_id: "default",
        organization_name: "Default",
        tenant_binding: "default",
      });
      agent.restoreContextFromSql();
      agent.ensureConversationRow(conversationId);
      const channel = {
        linkId: link.id,
        pluginId: link.plugin_id,
        senderId: link.sender_id,
        chatId: link.chat_id,
      };
      const send = async (
        body: object,
        path = "/channel-decision",
        identity = {
          userId: "owner",
          tenantBinding: "default",
          organizationId: "default",
          role: "owner",
        },
      ) =>
        agent.fetch(
          new Request(`https://agent.internal${path}`, {
            method: "POST",
            headers: await createInternalAuthHeaders(
              identity,
              "test-only-internal-secret",
            ),
            body: JSON.stringify(body),
          }),
        );
      const effects = vi.fn(async (input: { content: string }) =>
        JSON.stringify({ written: input.content }),
      );
      const tool = defineConfirmTool(
        "write_file",
        {
          description: "Native storage approval fixture",
          properties: { content: { type: "string" } },
          required: ["content"],
          buildPreview: (input) =>
            `Write test.txt with exactly: ${input.content}`,
          execute: effects,
        },
        {
          confirmations: makeSqliteConfirmationCoordinator(state.storage.sql),
          conversationId,
        },
      );
      const args = { content: "synthetic approved content" };
      const pending = JSON.parse(await tool.execute(args));
      const confirmationId = pending.confirmation_id;
      agent.handleUserMessage = vi.fn(async () => "Approved action ready");
      const data = {
        conversationId,
        requestId: crypto.randomUUID(),
        channel,
        approval: { confirmationId, decision: "confirmed" },
      };
      try {
        await test({
          agent,
          state,
          link,
          channel,
          conversationId,
          confirmationId,
          tool,
          args,
          effects,
          send,
          data,
        });
      } finally {
        while (background.length) await Promise.all(background.splice(0));
        await state.storage.deleteAlarm();
      }
    },
  );
}

describe("Telegram approval boundary on native D1 and Durable Object SQLite", () => {
  it("approves a signed linked request, preserves exact arguments and consumes it once", async () => {
    await withLinkedAgent(
      async ({
        agent,
        state,
        tool,
        args,
        effects,
        send,
        data,
        confirmationId,
      }: any) => {
        agent.handleUserMessage.mockImplementation(
          async (_socket: unknown, _conversation: string, content: string) => {
            expect(content).toContain(confirmationId);
            const changed = JSON.parse(
              await tool.execute({
                content: "changed by the model",
                confirmation_id: confirmationId,
              }),
            );
            expect(changed.needs_confirmation).toBe(true);
            expect(effects).not.toHaveBeenCalled();
            expect(
              JSON.parse(
                await tool.execute({
                  ...args,
                  confirmation_id: confirmationId,
                }),
              ),
            ).toEqual({ written: args.content });
            return "Exact action completed";
          },
        );
        expect((await send(data)).status).toBe(200);
        expect(agent.handleUserMessage).toHaveBeenCalledOnce();
        expect(effects).toHaveBeenCalledExactlyOnceWith(args);
        const row = state.storage.sql
          .exec(
            "SELECT status,consumed_at FROM tool_confirmations WHERE confirmation_id=?",
            confirmationId,
          )
          .one();
        expect(row.status).toBe("approved");
        expect(row.consumed_at).toEqual(expect.any(Number));
        expect(
          (await send({ ...data, requestId: crypto.randomUUID() })).status,
        ).toBe(409);
        expect(
          JSON.parse(
            await tool.execute({ ...args, confirmation_id: confirmationId }),
          ).needs_confirmation,
        ).toBe(true);
        expect(effects).toHaveBeenCalledOnce();
      },
    );
  });

  it("rejects invalid channel authority, owner identity, conversation and expiry before approval", async () => {
    await withLinkedAgent(
      async ({ agent, state, send, data, confirmationId, link }: any) => {
        for (const field of ["linkId", "pluginId", "senderId", "chatId"]) {
          expect(
            (
              await send({
                ...data,
                channel: { ...data.channel, [field]: "other" },
              })
            ).status,
          ).toBe(403);
        }
        expect((await send(data, "/channel-message")).status).toBe(400);
        expect(
          (
            await send(data, "/channel-decision", {
              userId: "other",
              tenantBinding: "default",
              organizationId: "default",
              role: "owner",
            })
          ).status,
        ).toBe(401);
        state.storage.sql.exec(
          "UPDATE tool_confirmations SET conversation_id='other' WHERE confirmation_id=?",
          confirmationId,
        );
        expect((await send(data)).status).toBe(404);
        state.storage.sql.exec(
          "UPDATE tool_confirmations SET conversation_id=?,expires_at=? WHERE confirmation_id=?",
          data.conversationId,
          Date.now() - 1,
          confirmationId,
        );
        expect((await send(data)).status).toBe(409);
        state.storage.sql.exec(
          "UPDATE tool_confirmations SET expires_at=? WHERE confirmation_id=?",
          Date.now() + 60000,
          confirmationId,
        );
        agent.env.AUTH = {
          fetch: async () => Response.json({ ...principal, role: "reader" }),
        };
        expect((await send(data)).status).toBe(403);
        delete agent.env.AUTH;
        await runtime.CONTROL_DB.prepare(
          "DELETE FROM messaging_links WHERE id=?",
        )
          .bind(link.id)
          .run();
        expect((await send(data)).status).toBe(403);
        expect(agent.handleUserMessage).not.toHaveBeenCalled();
        expect(
          state.storage.sql
            .exec(
              "SELECT status FROM tool_confirmations WHERE confirmation_id=?",
              confirmationId,
            )
            .one().status,
        ).toBe("pending");
      },
    );
  });

  it("claims a typed button callback once in D1 and dispatches only its exact DO confirmation", async () => {
    await withLinkedAgent(
      async ({
        agent,
        state,
        send,
        link,
        conversationId,
        confirmationId,
      }: any) => {
        const sendApproval = vi.fn<
          NonNullable<MessagingPlugin["sendApproval"]>
        >(async () => ({ messageId: "123" }));
        let event: MessagingApprovalEvent;
        const plugin: MessagingPlugin = {
          id: "telegram",
          label: "Native Telegram",
          configured: () => true,
          receive: async () => event,
          send: vi.fn(async () => {}),
          sendApproval,
          answerCallback: vi.fn(async () => {}),
          clearApproval: vi.fn(async () => {}),
        };
        await sendApprovalCards(
          runtime,
          link,
          pendingToolConfirmationReviews(state.storage.sql, conversationId),
          plugin,
        );
        expect(sendApproval).toHaveBeenCalledOnce();
        const card = sendApproval.mock.calls[0][1];
        expect(card.text).toContain("synthetic approved content");
        expect(card.approveData).toMatch(/^dc:a:[A-Za-z0-9_-]{32}$/);
        const registry = createMessagingRegistry([plugin]);
        const dispatch = vi.fn<MessagingDispatch>(async (owner, message) => {
          expect(owner).toEqual(principal);
          expect(message.approval).toEqual({
            confirmationId,
            decision: "confirmed",
          });
          const response = await send(message);
          expect(response.status).toBe(200);
          return (await response.json()) as MessagingReply;
        });
        event = {
          kind: "approval",
          eventId: "button-update",
          senderId: "42",
          chatId: "42",
          callbackId: "callback",
          messageId: "123",
          data: card.approveData,
          occurredAt: Date.now(),
        };
        const webhook = () =>
          handleMessagingWebhook(
            new Request(
              "https://app.example.invalid/api/messaging/webhooks/telegram",
              { method: "POST", body: "{}" },
            ),
            runtime,
            dispatch,
            registry,
          );
        event = { ...event, messageId: "different" };
        expect((await webhook()).status).toBe(200);
        expect(dispatch).not.toHaveBeenCalled();
        event = { ...event, messageId: "123" };
        const responses = await Promise.all([webhook(), webhook()]);
        expect(responses.map((response) => response.status)).toEqual([
          200, 200,
        ]);
        expect(dispatch).toHaveBeenCalledOnce();
        expect(agent.handleUserMessage).toHaveBeenCalledOnce();
        event = {
          ...event,
          eventId: "opposite-button",
          data: card.declineData,
        };
        expect((await webhook()).status).toBe(200);
        expect(dispatch).toHaveBeenCalledOnce();
        const row = await runtime.CONTROL_DB.prepare(
          "SELECT status,decision FROM messaging_approvals WHERE confirmation_id=?",
        )
          .bind(confirmationId)
          .first();
        expect(row).toEqual({ status: "consumed", decision: "confirmed" });
        expect(
          (
            await runtime.CONTROL_DB.prepare(
              "SELECT COUNT(*) AS count FROM messaging_deliveries WHERE link_id=?",
            )
              .bind(link.id)
              .first()
          ).count,
        ).toBe(1);
      },
    );
  });
});

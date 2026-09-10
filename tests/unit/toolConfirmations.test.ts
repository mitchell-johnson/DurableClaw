import { describe, it, expect, vi } from "vitest";
import { createSqliteStorage } from "../helpers/sqlite";
import {
  ensureToolConfirmationsSchema,
  issueToolConfirmation,
  decideToolConfirmation,
  isToolConfirmationExecutable,
  consumeToolConfirmation,
  CONFIRMATION_TTL_MS,
  makeSqliteConfirmationCoordinator,
  pendingToolConfirmationReviews,
  deleteConversationConfirmations,
} from "../../src/durable-objects/assistant/toolConfirmations";
import { computeArgsHash } from "../../src/action-library/confirmations";
import { defineConfirmTool } from "../../src/action-library/helpers";
import { createWorkspaceTools } from "../../src/durable-objects/assistant/tools";
import { sendApprovalCards } from "../../src/channels/approvals";
import { createMessagingDb } from "../helpers/messagingDb";
const now = 1000;
const args = {
  conversationId: "conversation-a",
  toolName: "write_file",
  argsHash: "hash",
};
function fixture() {
  const sql = createSqliteStorage();
  ensureToolConfirmationsSchema(sql);
  return sql;
}

describe("durable single-use confirmations", () => {
  it("uses complete production file contents for a Telegram card and falls back when they do not fit", async () => {
    const sql = fixture();
    const control = createMessagingDb();
    const sendApproval = vi.fn(async (_env: any, _reply: any) => ({
      messageId: "123",
    }));
    const send = vi.fn();
    const plugin = { id: "telegram", sendApproval, send } as any;
    const link = control.sql
      .exec("SELECT * FROM messaging_links WHERE id='link'")
      .one() as any;
    const tools = createWorkspaceTools({
      env: { CONTROL_DB: control.db } as any,
      sql: sql as any,
      context: {
        user_id: "owner",
        tenant_binding: "default",
        user_role: "owner",
      },
      conversationId: "conversation",
      schedule: async () => {},
    }) as any;
    const content = 'Hello\nExact content, including "quotes".';
    const result = JSON.parse(
      await tools.write_file.execute({ path: "notes.txt", content }),
    );
    const reviews = pendingToolConfirmationReviews(sql, "conversation");
    expect(reviews).toHaveLength(1);
    expect(reviews[0].preview).toContain(JSON.stringify(content));
    expect(reviews[0].confirmationId).toBe(result.confirmation_id);
    await sendApprovalCards(
      { CONTROL_DB: control.db } as any,
      link,
      reviews,
      plugin,
    );
    expect(sendApproval).toHaveBeenCalledOnce();
    expect(sendApproval.mock.calls[0][1].text).toContain(
      JSON.stringify(content),
    );
    decideToolConfirmation(sql, result.confirmation_id, "declined", Date.now());
    await tools.write_file.execute({
      path: "long.txt",
      content: "x".repeat(5000),
    });
    await sendApprovalCards(
      { CONTROL_DB: control.db } as any,
      link,
      pendingToolConfirmationReviews(sql, "conversation"),
      plugin,
    );
    expect(sendApproval).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        text: expect.stringContaining("complete details"),
      }),
    );
  });
  it("keeps web approval available when a tool withholds its channel review", async () => {
    const sql = fixture();
    const tool = defineConfirmTool(
      "write_file",
      {
        description: "Write",
        properties: {},
        buildPreview: () => "Web review",
        buildChannelPreview: () => null,
        execute: vi.fn(),
      },
      {
        confirmations: makeSqliteConfirmationCoordinator(sql),
        conversationId: args.conversationId,
      },
    );
    const preview = JSON.parse(await tool.execute({}));
    expect(preview.preview).toBe("Web review");
    expect(preview.needs_confirmation).toBe(true);
    expect(pendingToolConfirmationReviews(sql, args.conversationId)).toEqual(
      [],
    );
    expect(
      decideToolConfirmation(
        sql,
        preview.confirmation_id,
        "confirmed",
        Date.now(),
      ),
    ).toBe(true);
  });
  it("returns only trusted pending reviews in the same conversation, with the complete preview", () => {
    const sql = fixture();
    const preview = 'Write notes.txt with: "hello\\nworld"';
    const id = issueToolConfirmation(sql, { ...args, preview }, now);
    issueToolConfirmation(
      sql,
      { ...args, conversationId: "other", preview },
      now,
    );
    issueToolConfirmation(sql, args, now);
    issueToolConfirmation(sql, { ...args, preview: "x".repeat(20001) }, now);
    expect(
      pendingToolConfirmationReviews(sql, args.conversationId, now),
    ).toEqual([
      {
        confirmationId: id,
        toolName: args.toolName,
        preview,
        expiresAt: now + CONFIRMATION_TTL_MS,
      },
    ]);
    expect(
      pendingToolConfirmationReviews(
        sql,
        args.conversationId,
        now + CONFIRMATION_TTL_MS,
      ),
    ).toEqual([]);
    decideToolConfirmation(sql, id, "declined", now);
    expect(
      pendingToolConfirmationReviews(sql, args.conversationId, now),
    ).toEqual([]);
  });
  it("revokes confirmations and deletes private previews when a conversation is removed", () => {
    const sql = fixture();
    const id = issueToolConfirmation(
      sql,
      { ...args, preview: "Private review" },
      now,
    );
    const other = issueToolConfirmation(
      sql,
      { ...args, conversationId: "other", preview: "Other review" },
      now,
    );
    decideToolConfirmation(sql, id, "confirmed", now);
    deleteConversationConfirmations(sql, args.conversationId);
    expect(
      isToolConfirmationExecutable(sql, { ...args, confirmationId: id }, now),
    ).toBe(false);
    expect(
      sql
        .exec("SELECT confirmation_id FROM tool_confirmation_reviews")
        .toArray(),
    ).toEqual([{ confirmation_id: other }]);
    expect(pendingToolConfirmationReviews(sql, "other", now)).toHaveLength(1);
  });
  it("does not issue a confirmation when the trusted preview fails", async () => {
    const sql = fixture();
    const execute = vi.fn();
    const tool = defineConfirmTool(
      "write_file",
      {
        description: "Write",
        properties: {},
        buildPreview: () => {
          throw new Error("Review unavailable");
        },
        execute,
      },
      {
        confirmations: makeSqliteConfirmationCoordinator(sql),
        conversationId: args.conversationId,
      },
    );
    await expect(tool.execute({})).rejects.toThrow("Review unavailable");
    expect(sql.exec("SELECT * FROM tool_confirmations").toArray()).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects pending, wrong-scope, changed-argument, expired and consumed records", () => {
    const sql = fixture();
    const id = issueToolConfirmation(sql, args, now);
    const check = { ...args, confirmationId: id };
    expect(isToolConfirmationExecutable(sql, check, now)).toBe(false);
    expect(decideToolConfirmation(sql, id, "confirmed", now)).toBe(true);
    for (const mismatch of [
      { conversationId: "other" },
      { toolName: "delete_file" },
      { argsHash: "changed" },
    ])
      expect(
        isToolConfirmationExecutable(sql, { ...check, ...mismatch }, now),
      ).toBe(false);
    expect(
      isToolConfirmationExecutable(sql, check, now + CONFIRMATION_TTL_MS),
    ).toBe(false);
    expect(isToolConfirmationExecutable(sql, check, now)).toBe(true);
    expect(consumeToolConfirmation(sql, id, now)).toBe(true);
    expect(isToolConfirmationExecutable(sql, check, now)).toBe(false);
  });
  it("permits only one consumption even when competing calls share the same millisecond", async () => {
    const sql = fixture();
    const id = issueToolConfirmation(sql, args, now);
    decideToolConfirmation(sql, id, "confirmed", now);
    const results = await Promise.all(
      Array.from({ length: 20 }, async () =>
        consumeToolConfirmation(sql, id, now),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("canonicalizes argument order but never reuses approval for changed values", async () => {
    expect(
      await computeArgsHash({
        b: { x: 1, y: 2 },
        a: 0,
        confirmation_id: "one",
      }),
    ).toBe(
      await computeArgsHash({
        a: 0,
        b: { y: 2, x: 1 },
        confirmation_id: "two",
      }),
    );
    expect(await computeArgsHash({ a: 1 })).not.toBe(
      await computeArgsHash({ a: 2 }),
    );
  });
  it("requires a server decision before the model-facing tool executes", async () => {
    const sql = fixture();
    const execute = vi.fn().mockResolvedValue("done");
    const tool = defineConfirmTool(
      "write_file",
      {
        description: "Write a file",
        properties: { path: { type: "string" } },
        required: ["path"],
        buildPreview: (input) => `Write ${input.path}`,
        execute,
      },
      {
        confirmations: makeSqliteConfirmationCoordinator(sql),
        conversationId: "conversation-a",
      },
    );
    const preview = JSON.parse(await tool.execute({ path: "notes.txt" }));
    expect(preview.needs_confirmation).toBe(true);
    expect(pendingToolConfirmationReviews(sql, args.conversationId)).toEqual([
      expect.objectContaining({
        confirmationId: preview.confirmation_id,
        preview: "Write notes.txt",
      }),
    ]);
    expect(execute).not.toHaveBeenCalled();
    decideToolConfirmation(
      sql,
      preview.confirmation_id,
      "confirmed",
      Date.now(),
    );
    expect(
      await tool.execute({
        path: "notes.txt",
        confirmation_id: preview.confirmation_id,
      }),
    ).toBe("done");
    expect(
      JSON.parse(
        await tool.execute({
          path: "notes.txt",
          confirmation_id: preview.confirmation_id,
        }),
      ).needs_confirmation,
    ).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });
});

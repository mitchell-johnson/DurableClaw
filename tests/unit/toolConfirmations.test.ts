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
} from "../../src/durable-objects/assistant/toolConfirmations";
import { computeArgsHash } from "../../src/action-library/confirmations";
import { defineConfirmTool } from "../../src/action-library/helpers";
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

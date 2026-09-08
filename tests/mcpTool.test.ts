import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it, vi } from "vitest";
import { createMcpTool } from "../src/durable-objects/assistant/mcpTool";
import {
  decideToolConfirmation,
  ensureToolConfirmationsSchema,
  makeSqliteConfirmationCoordinator,
} from "../src/durable-objects/assistant/toolConfirmations";
import { createSqliteStorage } from "./helpers/sqlite";

function assemble(inputSchema: object, execute = vi.fn(async () => "done")) {
  const sql = createSqliteStorage();
  ensureToolConfirmationsSchema(sql);
  return {
    ...createMcpTool(
      {
        serverName: "example",
        tool: { name: "remote_action", inputSchema },
        execute,
      },
      {
        confirmations: makeSqliteConfirmationCoordinator(sql),
        conversationId: "conversation-a",
      },
    ),
    sql,
    execute,
  };
}

describe("assembled MCP tools", () => {
  it("retains local definitions, root combinators and restrictive properties with optional approval", async () => {
    const remoteSchema = {
      type: "object",
      $defs: { name: { type: "string", minLength: 3 } },
      properties: {
        name: { $ref: "#/$defs/name" },
        email: { type: "string", pattern: "@" },
        phone: { type: "string", minLength: 5 },
      },
      required: ["name"],
      allOf: [{ not: { required: ["blocked"] } }],
      oneOf: [{ required: ["email"] }, { required: ["phone"] }],
      additionalProperties: false,
      maxProperties: 2,
    };
    const { tool } = assemble(remoteSchema);
    const published = await tool.inputSchema.jsonSchema;
    const validate = new Ajv({ strict: false }).compile(published);
    for (const arguments_ of [
      { name: "Alice", email: "a@example.invalid" },
      { name: "Alice", phone: "12345" },
    ]) {
      expect(validate({ arguments: arguments_ })).toBe(true);
      expect(
        validate({ arguments: arguments_, confirmation_id: "server-id" }),
      ).toBe(true);
    }
    for (const arguments_ of [
      { name: "Al", phone: "12345" },
      { name: "Alice" },
      { name: "Alice", phone: "12345", email: "a@example.invalid" },
      { name: "Alice", phone: "12345", injected: true },
    ]) {
      expect(validate({ arguments: arguments_ })).toBe(false);
    }
    expect(remoteSchema).not.toHaveProperty("$id");
    expect(validate({ arguments: {}, injected: true })).toBe(false);
  });

  it("retains permissive additionalProperties and remote reserved-name collisions", async () => {
    const { tool, sql, execute } = assemble({
      type: "object",
      properties: { confirmation_id: { type: "integer" } },
      required: ["confirmation_id"],
      additionalProperties: true,
    });
    const validate = new Ajv({ strict: false }).compile(
      await tool.inputSchema.jsonSchema,
    );
    const arguments_ = { confirmation_id: 42, arbitrary: { nested: true } };
    expect(validate({ arguments: arguments_ })).toBe(true);
    const first = JSON.parse(await tool.execute({ arguments: arguments_ }));
    expect(first.needs_confirmation).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    // A remote confirmation_id is ordinary approved input, never our token.
    expect(
      JSON.parse(
        await tool.execute({
          arguments: arguments_,
          confirmation_id: first.confirmation_id,
        }),
      ).needs_confirmation,
    ).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    decideToolConfirmation(sql, first.confirmation_id, "confirmed", Date.now());
    const changed = JSON.parse(
      await tool.execute({
        arguments: { ...arguments_, confirmation_id: 43 },
        confirmation_id: first.confirmation_id,
      }),
    );
    expect(changed.needs_confirmation).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(
      await tool.execute({
        arguments: arguments_,
        confirmation_id: first.confirmation_id,
      }),
    ).toBe("done");
    expect(execute).toHaveBeenCalledExactlyOnceWith(arguments_);
    expect(
      JSON.parse(
        await tool.execute({
          arguments: arguments_,
          confirmation_id: first.confirmation_id,
        }),
      ).needs_confirmation,
    ).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("preserves existing resource identities and recursive root references", async () => {
    const { tool } = assemble({
      $id: "https://schemas.example.invalid/tree.json",
      type: "object",
      properties: {
        value: { type: "string" },
        child: { $ref: "#" },
      },
      required: ["value"],
      additionalProperties: false,
    });
    const validate = new Ajv({ strict: false }).compile(
      await tool.inputSchema.jsonSchema,
    );
    expect(
      validate({
        arguments: { value: "root", child: { value: "leaf" } },
        confirmation_id: "server-id",
      }),
    ).toBe(true);
    expect(
      validate({ arguments: { value: "root", child: { arguments: {} } } }),
    ).toBe(false);
  });

  it("keeps nested resource scopes and external references unchanged", async () => {
    const externalId = "https://schemas.example.invalid/positive.json";
    const { tool } = assemble({
      type: "object",
      properties: {
        count: { $ref: externalId },
        nested: {
          $id: "https://schemas.example.invalid/nested.json",
          type: "object",
          $defs: { label: { type: "string", minLength: 2 } },
          properties: { label: { $ref: "#/$defs/label" } },
          required: ["label"],
          additionalProperties: false,
        },
      },
      required: ["count", "nested"],
      propertyNames: { enum: ["count", "nested"] },
      additionalProperties: false,
    });
    const validator = new Ajv({ strict: false });
    validator.addSchema({ $id: externalId, type: "integer", minimum: 1 });
    const validate = validator.compile(await tool.inputSchema.jsonSchema);
    expect(
      validate({
        arguments: { count: 1, nested: { label: "OK" } },
        confirmation_id: "server-id",
      }),
    ).toBe(true);
    expect(validate({ arguments: { count: 0, nested: { label: "OK" } } })).toBe(
      false,
    );
    expect(validate({ arguments: { count: 1, nested: { label: "X" } } })).toBe(
      false,
    );
  });

  it("preserves newer dialect constraints, local anchors and root conditionals", async () => {
    const { tool } = assemble({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      $defs: { amount: { $anchor: "amount", type: "number", minimum: 1 } },
      properties: {
        kind: { enum: ["limited", "open"] },
        amount: { $ref: "#amount" },
      },
      required: ["kind", "amount"],
      if: { properties: { kind: { const: "limited" } } },
      then: { properties: { amount: { maximum: 5 } } },
      unevaluatedProperties: false,
    });
    const validate = new Ajv2020({ strict: false }).compile(
      await tool.inputSchema.jsonSchema,
    );
    expect(
      validate({
        arguments: { kind: "limited", amount: 5 },
        confirmation_id: "id",
      }),
    ).toBe(true);
    expect(validate({ arguments: { kind: "limited", amount: 6 } })).toBe(false);
    expect(validate({ arguments: { kind: "open", amount: 6 } })).toBe(true);
    expect(
      validate({ arguments: { kind: "open", amount: 6, unwanted: true } }),
    ).toBe(false);
  });

  it("rejects malformed or flattened envelopes before creating approvals", async () => {
    const { tool, sql, execute } = assemble({ type: "object" });
    for (const input of [
      null,
      [],
      { path: "file.txt" },
      { arguments: [] },
      { arguments: {}, confirmation_id: 42 },
      { arguments: {}, injected: true },
    ]) {
      expect(JSON.parse(await tool.execute(input))).toEqual({
        error: "Invalid MCP tool argument envelope",
      });
    }
    expect(execute).not.toHaveBeenCalled();
    expect(
      sql.exec("SELECT count(*) AS count FROM tool_confirmations").one(),
    ).toEqual({
      count: 0,
    });
  });
});

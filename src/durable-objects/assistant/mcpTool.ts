import { jsonSchema, type JSONSchema7 } from "ai";
import {
  defineConfirmTool,
  type ConfirmToolOptions,
} from "../../action-library/helpers";
import type { MCPTool } from "./mcpClient";
import { mcpToolId } from "./mcpToolId";

/**
 * Keep the remote argument schema in its own resource. Flattening an approval
 * field into that schema changes constraints such as additionalProperties,
 * propertyNames and oneOf, and can overwrite a real remote confirmation_id.
 * A resource id lets local references keep their original resolution scope.
 */
export function createMcpTool(
  config: {
    serverName: string;
    tool: MCPTool;
    execute: (arguments_: Record<string, unknown>) => Promise<string>;
  },
  options?: ConfirmToolOptions,
) {
  const toolId = mcpToolId(config.serverName, config.tool.name);
  const remoteSchema =
    config.tool.inputSchema && !Array.isArray(config.tool.inputSchema)
      ? (config.tool.inputSchema as JSONSchema7)
      : { type: "object" as const, additionalProperties: true };
  const argumentsSchema: JSONSchema7 = {
    ...remoteSchema,
    $id: remoteSchema.$id || `urn:durableclaw:mcp-arguments:${toolId}`,
  };
  const gated = defineConfirmTool<{ arguments: Record<string, unknown> }>(
    toolId,
    {
      description:
        (config.tool.description ??
          `MCP tool ${config.tool.name} from server ${config.serverName}`) +
        " Put the remote tool's complete input in arguments. The outer confirmation_id is reserved for user approval.",
      properties: { arguments: argumentsSchema },
      required: ["arguments"],
      buildPreview: (input) =>
        `Run remote tool ${config.tool.name} on ${config.serverName} with arguments: ${JSON.stringify(input.arguments)}`,
      execute: (input) => config.execute(input.arguments),
    },
    options,
  );
  const withDialect = (schema: JSONSchema7) =>
    jsonSchema({
      ...schema,
      ...(remoteSchema.$schema ? { $schema: remoteSchema.$schema } : {}),
    });
  return {
    toolId,
    tool: {
      ...gated,
      inputSchema: withDialect(gated.inputSchema.jsonSchema as JSONSchema7),
      directInputSchema: withDialect(
        gated.directInputSchema.jsonSchema as JSONSchema7,
      ),
      // Custom JSON Schema is passed to the model without an SDK validator.
      // Check our envelope even for direct invocations of execute; the remote
      // server remains responsible for validating its own argument schema.
      execute: async (input: unknown) => {
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).some(
            (key) => key !== "arguments" && key !== "confirmation_id",
          )
        ) {
          return JSON.stringify({
            error: "Invalid MCP tool argument envelope",
          });
        }
        const envelope = input as Record<string, unknown>;
        if (
          !envelope.arguments ||
          typeof envelope.arguments !== "object" ||
          Array.isArray(envelope.arguments) ||
          (envelope.confirmation_id !== undefined &&
            typeof envelope.confirmation_id !== "string")
        ) {
          return JSON.stringify({
            error: "Invalid MCP tool argument envelope",
          });
        }
        return gated.execute(input);
      },
    },
  };
}

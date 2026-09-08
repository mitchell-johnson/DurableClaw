import { z } from "zod";
import type { Env } from "../../types";
import {
  encryptCredentials,
  decryptStoredCredentials,
  validateMcpHeaders,
} from "./mcpCrypto";
import { requireHttpsURL, type MCPServerConfig } from "./mcpClient";
import { RequestValidationError } from "../../utils/validation";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const server = z
  .object({
    name: id,
    url: z.string().url().max(2048),
    headers: z.record(z.string().max(8192)).optional(),
    headers_encrypted: z.string().max(16384).optional(),
  })
  .strict();
const schema = z
  .object({
    identity_override: z.string().max(2000).nullable().optional(),
    persona: z.string().max(8000).nullable().optional(),
    enabled_tools: z.array(id).max(200).nullable().optional(),
    disabled_tools: z.array(id).max(200).nullable().optional(),
    mcp_servers: z.array(server).max(10).optional(),
    reasoning_effort: z.enum(["fast", "thorough"]).nullable().optional(),
    wake_interval_minutes: z
      .union([
        z.literal(10),
        z.literal(20),
        z.literal(30),
        z.literal(45),
        z.literal(60),
      ])
      .nullable()
      .optional(),
    dream_interval_hours: z.number().int().nullable().optional(),
    memory_enabled: z.boolean().optional(),
    memory_settings: z
      .object({
        summarize_after_turns: z.number().int().min(10).max(50).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export async function validatePersona(
  input: unknown,
  env: Env,
  owner: {
    userId: string;
    workspaceId: string;
    existingServers: MCPServerConfig[];
  },
) {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new RequestValidationError("Invalid persona settings");
  const result = parsed.data;
  if (result.mcp_servers) {
    const names = new Set<string>();
    const encrypted = [];
    for (const item of result.mcp_servers) {
      if (names.has(item.name))
        throw new RequestValidationError("Duplicate MCP server");
      names.add(item.name);
      let url: URL;
      try {
        url = requireHttpsURL(item.url);
        if (item.headers) validateMcpHeaders(item.headers);
      } catch (error) {
        throw new RequestValidationError((error as Error).message);
      }
      const scope = {
        userId: owner.userId,
        workspaceId: owner.workspaceId,
        serverName: item.name,
        serverUrl: url.href,
      };
      let headersEncrypted: string | undefined;
      if (item.headers) {
        headersEncrypted = await encryptCredentials(env, item.headers, scope);
      } else if (item.headers_encrypted) {
        const stored = owner.existingServers.find(
          (previous) => previous.name === item.name,
        );
        if (
          !stored ||
          new URL(stored.url).href !== url.href ||
          stored.headers_encrypted !== item.headers_encrypted
        )
          throw new RequestValidationError(
            "MCP credentials can only be retained on their existing server; provide new headers to change it",
          );
        try {
          const headers = await decryptStoredCredentials(
            env,
            item.headers_encrypted,
            scope,
          );
          headersEncrypted = item.headers_encrypted.startsWith("v2:")
            ? item.headers_encrypted
            : await encryptCredentials(env, headers, scope);
        } catch {
          throw new RequestValidationError(
            "MCP credentials cannot be retained; provide new headers",
          );
        }
      }
      encrypted.push({
        name: item.name,
        url: url.href,
        ...(headersEncrypted ? { headers_encrypted: headersEncrypted } : {}),
      });
    }
    result.mcp_servers = encrypted;
  }
  return result;
}

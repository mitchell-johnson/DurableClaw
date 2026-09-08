import { z } from "zod";
import type { Env } from "../../types";
import { encryptCredentials } from "./mcpCrypto";
import { isPrivateOrInternalHost } from "./mcpClient";
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
export async function validatePersona(input: unknown, env: Env) {
  const result = schema.parse(input);
  if (result.mcp_servers) {
    const names = new Set<string>();
    const encrypted = [];
    for (const item of result.mcp_servers) {
      if (names.has(item.name)) throw new Error("Duplicate MCP server");
      names.add(item.name);
      const url = new URL(item.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        isPrivateOrInternalHost(url.hostname)
      )
        throw new Error("MCP server must be public HTTPS");
      encrypted.push({
        name: item.name,
        url: item.url,
        ...(item.headers
          ? { headers_encrypted: await encryptCredentials(env, item.headers) }
          : item.headers_encrypted
            ? { headers_encrypted: item.headers_encrypted }
            : {}),
      });
    }
    result.mcp_servers = encrypted;
  }
  return result;
}

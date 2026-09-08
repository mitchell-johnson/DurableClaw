import { createHash } from "node:crypto";
/** Stable, collision-resistant aliases satisfying chat-provider function-name limits. */
export function mcpToolId(server: string, tool: string): string {
  const safe = (value: string, length: number) =>
    value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, length);
  const hash = createHash("sha256")
    .update(JSON.stringify([server, tool]))
    .digest("hex")
    .slice(0, 12);
  return `mcp_${safe(server, 20)}_${safe(tool, 24)}_${hash}`;
}

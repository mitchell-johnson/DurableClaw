import type { AgentPrincipal, Env } from "../../types";

export interface ChannelSource {
  linkId: string;
  pluginId: string;
  senderId: string;
  chatId: string;
}

/** Never infer channel authority from text, model arguments, or an old link. */
export async function channelSourceActive(
  env: Env,
  principal: AgentPrincipal,
  conversationId: string,
  value: unknown,
): Promise<boolean> {
  if (
    !env.CONTROL_DB ||
    principal.role !== "owner" ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return false;
  const source = value as Record<string, unknown>;
  if (
    Object.keys(source).length !== 4 ||
    ["linkId", "pluginId", "senderId", "chatId"].some(
      (key) =>
        typeof source[key] !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(source[key] as string),
    )
  )
    return false;
  const link = await env.CONTROL_DB.prepare(
    "SELECT id FROM messaging_links WHERE id=? AND user_id=? AND workspace_id=? AND plugin_id=? AND sender_id=? AND chat_id=? AND conversation_id=?",
  )
    .bind(
      source.linkId,
      principal.userId,
      principal.workspaceId,
      source.pluginId,
      source.senderId,
      source.chatId,
      conversationId,
    )
    .first();
  return !!link;
}

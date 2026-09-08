import type { AgentChatEndpoints, ConversationSummary } from "./useAgentChat";

/** Credentials remain in component memory; socket URLs contain only expiring tickets. */
export function createApi(token: string) {
  return async (path: string, init: RequestInit = {}): Promise<any> => {
    const response = await fetch(path, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? "Access expired. Sign in again."
          : `Request failed (${response.status}). Please try again.`,
      );
    return response.status === 204 ? null : response.json();
  };
}
export type Api = ReturnType<typeof createApi>;
export function createChatEndpoints(token: string): AgentChatEndpoints {
  const api = createApi(token);
  const mintWsPath = async (conversationId: string) => {
    const { ticket } = await api("/api/socket-ticket", {
      method: "POST",
      body: JSON.stringify({ conversation_id: conversationId }),
    });
    if (typeof ticket !== "string" || !ticket)
      throw new Error("A socket ticket was not issued.");
    return `/api/agent/connect?conversation_id=${encodeURIComponent(conversationId)}&ticket=${encodeURIComponent(ticket)}`;
  };
  const listConversationsPage = async (cursor?: string) => {
    const data = await api(
      `/api/agent/conversations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    return {
      conversations: data.conversations.map(
        (row: Record<string, any>): ConversationSummary => ({
          id: row.conversation_id,
          title: row.title,
          createdAt: new Date(row.created_at).toISOString(),
          lastActiveAt: new Date(row.last_active_at).toISOString(),
          wsPath: `/api/agent/connect?conversation_id=${encodeURIComponent(row.conversation_id)}`,
        }),
      ),
      nextCursor: data.next_cursor ?? null,
    };
  };
  return {
    createConversation: async () => {
      const conversationId = crypto.randomUUID();
      await api("/api/agent/init", {
        method: "POST",
        body: JSON.stringify({ conversation_id: conversationId }),
      });
      return { conversationId, wsPath: await mintWsPath(conversationId) };
    },
    mintWsPath,
    listConversations: async () =>
      (await listConversationsPage()).conversations,
    listConversationsPage,
    deleteConversation: async (id) => {
      await api(`/api/agent/conversations/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return new Response(null, { status: 204 });
    },
  };
}

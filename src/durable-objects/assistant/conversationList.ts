/** Keyset pagination keeps older conversations reachable even when timestamps tie. */
export function listConversationPage(sql: SqlStorage, url: URL): Response {
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit")) || 30, 1),
    100,
  );
  if (!Number.isInteger(limit))
    return Response.json({ error: "Invalid limit" }, { status: 400 });
  let cursor: [number, string] | null = null;
  const encoded = url.searchParams.get("cursor");
  if (encoded) {
    try {
      if (encoded.length > 1024) throw new Error();
      const parsed = JSON.parse(atob(encoded));
      if (
        !Array.isArray(parsed) ||
        parsed.length !== 2 ||
        !Number.isSafeInteger(parsed[0]) ||
        typeof parsed[1] !== "string" ||
        !parsed[1] ||
        parsed[1].length > 200
      )
        throw new Error();
      cursor = parsed as [number, string];
    } catch {
      return Response.json({ error: "Invalid cursor" }, { status: 400 });
    }
  }
  const rows = sql
    .exec(
      `SELECT conversation_id,title,created_at,last_active_at,message_count FROM conversations ${cursor ? "WHERE (last_active_at, conversation_id) < (?, ?)" : ""} ORDER BY last_active_at DESC, conversation_id DESC LIMIT ?`,
      ...(cursor || []),
      limit + 1,
    )
    .toArray();
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return Response.json({
    success: true,
    conversations: page,
    next_cursor:
      rows.length > limit && last
        ? btoa(JSON.stringify([last.last_active_at, last.conversation_id]))
        : null,
  });
}

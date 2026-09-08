import type { Observer, Signal } from "./types";
/** A functional observer for application events submitted through the authenticated event endpoint. */
export function createObservers(): Observer[] {
  return [
    {
      name: "workspace_events",
      async observe(ctx) {
        if (
          !ctx.user.permissions?.some(
            (p) =>
              p.resource_type === "workspace" && p.permission_type !== "none",
          )
        )
          throw new Error("Workspace read permission required");
        const saved = await ctx.readCursor("workspace_events");
        const after = saved && /^\d+$/.test(saved) ? Number(saved) : 0;
        const rows = await ctx.db
          .prepare(
            `SELECT sequence,kind,resource_id,summary,salience,occurred_at FROM workspace_events WHERE user_id=? AND workspace_id=? AND sequence>? ORDER BY sequence LIMIT 100`,
          )
          .bind(ctx.user.id, ctx.workspaceId, after)
          .all<{
            sequence: number;
            kind: string;
            resource_id: string;
            summary: string;
            salience: Signal["salience"];
            occurred_at: number;
          }>();
        const events = rows.results || [];
        if (events.length)
          await ctx.writeCursor(
            "workspace_events",
            String(events[events.length - 1].sequence),
          );
        return events.map((e) => ({
          kind: e.kind,
          entity_type: "file",
          entity_id: e.resource_id,
          summary: e.summary,
          salience: e.salience,
          occurred_at: e.occurred_at,
          dedupe_key: `event:${e.sequence}`,
        }));
      },
    },
  ];
}

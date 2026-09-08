import type { Env } from "../types";
import { createInternalAuthHeaders } from "../utils/internalAuth";
import { WAKE_GRACE_FLOOR_MS } from "../durable-objects/assistant/wakeSettings";
export async function reconcileWakes(env: Env): Promise<void> {
  const now = Date.now();
  const rows = await env.CONTROL_DB.prepare(
    "SELECT do_name,user_id,org_id FROM agent_wake_registry WHERE enabled=1 AND next_wake_at<? ORDER BY next_wake_at LIMIT 50",
  )
    .bind(now - WAKE_GRACE_FLOOR_MS)
    .all<{ do_name: string; user_id: string; org_id: string }>();
  for (const row of rows.results) {
    try {
      const headers = await createInternalAuthHeaders(
        {
          userId: row.user_id,
          organizationId: row.org_id,
          tenantBinding: row.org_id,
          role: "owner",
        },
        env.INTERNAL_AUTH_SECRET,
      );
      const response = await env.NANO_CHAT_AGENT.get(
        env.NANO_CHAT_AGENT.idFromName(row.do_name),
      ).fetch("https://agent.internal/wake-reconcile", {
        method: "POST",
        headers,
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error("Reconcile rejected");
    } catch {
      console.warn(JSON.stringify({ event: "wake.reconcile_failed" }));
    }
  }
}

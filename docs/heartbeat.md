# Agent heartbeat

Open **Settings → Heartbeat** to choose a cadence from 10 minutes to 24 hours, or turn it Off. New agents start at **Every 1 hour**. Existing saved settings, including Off, are preserved. The settings page shows the last outcome and next scheduled check.

The heartbeat checks authenticated workspace events and connected Gmail inboxes. It uses the agent's configured model and memory to decide whether an observed event deserves attention. Direct requests, deadlines, and meaningful changes can produce one concise digest; routine updates and empty checks stay quiet. A check with no new events makes no model call.

Important digests appear in the app's **Inbox** and are sent to the user's linked messaging apps, including Telegram. Link Telegram under Connections to receive notifications while the app is closed. Gmail must already be connected with its Gmail service grant. The heartbeat reads bounded email metadata; it does not send mail, modify messages, or execute proposed actions. See [Gmail polling details](heartbeat-gmail.md) for pagination, first-check scope, and busy-mailbox limits.

Scheduling uses the agent's existing Durable Object alarm multiplexer. Cursor changes, deduplication and the notification outbox are persisted in SQLite. Failed analysis retains events for a later check, including the initial Gmail observation window. Restart recovery restores pending delivery. Turning Off cancels future checks and unsent outbox entries; a message already handed to a provider cannot be recalled.

Delivery writes the Inbox record before attempting external messaging. Inbox IDs and channel delivery claims suppress duplicates, including a retried job or replaced messaging link. External messages have a 24-hour delivery window; older pending notifications are retained in the Inbox without sending a stale alert. A provider timeout can leave delivery uncertain; the system preserves the Inbox record and does not blindly resend that message.

`PROACTIVE_DISABLED=true` disables the scheduler globally. `WAKE_MAX_DAILY_TRIAGE_TURNS` limits paid analysis per UTC day (default 48), and `WAKE_MAX_DAILY_SUBAGENT_SPAWNS` limits investigations (default 100). Untriaged events remain pending when the analysis budget is exhausted. Source failures are visible in heartbeat status and retried at the next check.

Additional service observers implement the existing `Observer` interface and join `createObservers`. They must use authenticated read-only operations, bounded event pages, stable event IDs, staged cursors, and a persistent first-observation baseline. Events and email content are untrusted input and cannot authorize tool actions or change notification recipients.

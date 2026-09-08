# Runtime guarantees and limits

## Recovery

Durable intent is recorded before external dispatch, model-result reporting, batch submission, and retryable cleanup. Recovery can replay an attempt, so callback delivery, message insertion, task settlement, and inbox publication use stable identities and conditional writes. This is not a general exactly-once guarantee for arbitrary external tools.

Stop aborts the current model request and gates tools that have not started. Stop research cancels the conversation's admitted research batches. An operation already in flight may finish; completed external effects are not rolled back. A durable tool-call and pending-result pair is recorded before execution, and a late result updates that same pair after Stop. Interrupted tools with no confirmed result retain an explicit uncertain outcome. Completed provider steps are saved as they finish, and visible fallback replies survive reconnect. Clearing or deleting history removes the journal rows so late completions cannot recreate them. Late results cannot revive a cancelled batch or deleted conversation. On uncertain proactive synthesis, the transcript records failure rather than repeating possibly published effects.

The 100-task limit bounds admitted ledger work, not a measured count of live provider connections. Dispatch runs in bounded slices with durable continuation jobs. Unacknowledged dispatches are retried by the same task ID after restart or timeout; each request is bounded to five seconds, with up to three delivery attempts and a 30-second retry interval. Children cannot spawn children and receive a dedicated read-only tool factory. Admission filters their toolsets through the owner's persona policy; each child checks the current policy before assembly and before and after a read. Revoked results are withheld. Parent deadlines and child deadlines independently bound incomplete work.

Memory deletion first hides the content locally and invalidates pending work. Remote deletion then runs through retryable cleanup. R2 inventory records make remote writes discoverable even when a vector upsert response is ambiguous. Cleanup failure keeps intent durable; disabled/missing bindings do not count as completed deletion. Every owned memory write registers its exact ID and pending state in SQLite before publishing to R2. Pending writes stay hidden from recall, consolidation, and management. On restart, valid background jobs retain their deterministic IDs for retry; abandoned writes move to cleanup. Content-free tombstones retain the deleted vector ID and deletion timestamp so delayed vector queries or inventory repairs cannot revive forgotten content. A content-free ID-to-namespace record lets cleanup remove late inventory writes even if an earlier deletion removed their R2 locator. Recall requires both a live R2 inventory record and an eligible local SQLite record; unknown IDs fail closed. Management listings hide every pending deletion, while legitimate cold source memories remain visible. Listings select bounded IDs from the local index before fetching R2 bodies. Legacy inventory repair advances through bounded key pages; full forgetting persists its inventory cursor and schedules bounded deletion passes.

Forgetting source memories excludes their original message IDs from subsequent automatic summaries and removes existing copies derived from those sources. Explicitly remembered facts keep their originating user-turn anchor, so later replies and tool rows from that same turn—including a stopped partial reply—stay excluded without suppressing the next user turn. Forget-all also invalidates turns already generating a response. Conversation transcripts remain available to the conversation; forgetting semantic memory does not erase chat history or prevent a later reply from discussing text still in that history. Deleting a consolidated insight restores its retained source memories.

## Limits

| Surface                               | Default or bound                              |
| ------------------------------------- | --------------------------------------------- |
| Public JSON bodies / WebSocket frames | 64 KiB                                        |
| User message                          | 32,000 characters                             |
| Page context                          | 8,000 characters                              |
| File tool text payload                | 128 KiB                                       |
| Per-owner research admission          | 100 tasks                                     |
| Parent dispatch slice                 | 25 tasks                                      |
| Dispatch request timeout / attempts   | 5 seconds / 3                                 |
| MCP schema                            | 128 KiB / 64 levels / 10,000 nodes            |
| MCP catalog per server / combined     | 512 KiB / 1 MiB                               |
| Parent research batch deadline        | 5 minutes                                     |
| Alarm due slice                       | 8 jobs                                        |
| Proactive cadences                    | 10, 20, 30, 45, or 60 minutes; off by default |
| Consolidation cadences                | 12, 24, or 48 hours; off by default           |
| Wake daily budget                     | 20 triage turns and 100 child spawns          |
| Housekeeping submission               | 20 requests / 2 MiB                           |
| Housekeeping pending queue            | 500 tasks                                     |
| Housekeeping expiry                   | 48 hours                                      |
| Confirmation expiry                   | 10 minutes                                    |
| WebSocket ticket expiry               | 30 seconds, single use                        |
| Browser connection/replay timeout     | 30 seconds                                    |
| Trace buffer / default flush timeout  | 256 spans / 1.5 seconds                       |

`PROACTIVE_DISABLED=true` disables wake/consolidation execution globally. User preferences remain stored. Disabling wakes or changing their cadence during a running pass preserves the newly selected schedule. Wake registry entries support overdue reconciliation by the minute cron; ordinary initialization also repairs missing schedules.

## Models and telemetry

Model IDs are supplied through `CHAT_MODEL`, `BACKGROUND_MODEL`, and `BATCH_MODEL`. The synchronous transport uses OpenAI-compatible chat completions at OpenRouter, while housekeeping uses its asynchronous Batch API. Embeddings and optional reranking use Workers AI. Deployment-specific provider pinning can be added in `src/utils/aiProvider.ts`.

Set `OTLP_ENDPOINT` to the collector base URL and `OTLP_HEADERS` to a JSON object of authentication headers using secret configuration. `OTEL_TRACE_SAMPLE_RATE` and `OTEL_TRACE_SLOW_MS` control sampling. Each object invocation owns its exporter and flush; no global tracer registration or periodic metric timer is installed. Token usage is recorded without assuming a model price.

## Scheduling and outputs

`schedule_task` persists a due item and delivers its description/message to the inbox; it does not execute arbitrary generated code. File changes and submitted events feed the built-in observer. A quiet wake makes no model call. Wakes that exceed budget can publish capped high-salience events directly. Each wake can admit one research batch. Admission atomically saves the batch association and charges its tasks against the remaining daily allowance before dispatch; repeated calls reuse the existing admission. Failed triage does not erase admitted work or its budget charge. Observer cursor and dedupe changes have a durable recovery window. Restart during observation or triage restores the window for a later wake, unless a batch already owns delivery. Publication begins an uncertainty boundary: an interrupted publication is recorded as failed without replaying possibly delivered output. Research-backed wakes persist both findings and proposed follow-ups for human review; proposals do not execute application mutations. Ordinary triage remains visible in activity history and does not automatically notify the inbox when no research delivery is requested.

MCP uses bounded Streamable HTTP sessions, encrypted headers, public HTTPS endpoints, blocked redirects, and explicit approval before tool execution. Application integrations must still enforce authorization inside their services; sanitizing tool text is only advisory prompt-injection mitigation.

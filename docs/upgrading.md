# Upgrading an existing installation

Code execution adds the optional `CODE_LOADER` Worker Loader binding. Preserve the `[[worker_loaders]]` configuration when upgrading to enable the foreground `execute_code` tool, or omit it to disable execution. This needs no new storage migration or secret. See [code execution](code-execution.md) for account requirements and limits.

Browser tools add the optional `[browser]` binding in `wrangler.toml` and `@cloudflare/puppeteer` to the lockfile. Preserve that binding when merging your deployment settings to enable browsing. No new Durable Object migration is needed; see [browser setup](browsing.md).

New browser sessions prefer Kitesurf. Existing persisted browser records without an engine are treated as Chromium and remain reconnectable. To use Chromium for a new task, the agent supplies `engine: "chromium"` to `browser_navigate`. No new binding or secret is needed for Kitesurf.

The `NanoChatAgent` class and the existing `v1` migration are retained. The `v2` migration adds `ResearchSubagent`. Original SQLite tables and R2 objects remain stored. New sessions route by authenticated user/workspace rather than an unauthenticated browser session name.

Before updating, record the old browser session identifier from its URL fragment or the `durableclaw-session` local-storage entry. Keep that identifier private; the old installation did not attach ownership records to sessions.

After deploying the new runtime and control-database migration, a single-owner installation can adopt an old session through authenticated `POST /api/legacy/import`:

```json
{ "session_id": "old-session-id", "after": 0 }
```

The response contains the new `conversation_id` and `next_cursor`. Repeat with that cursor until it is null. Message imports are idempotent and preserve timestamps. Stored summaries and saved key/value memories are imported as readable messages. Original records are not deleted. The bounded first page imports up to 1,000 old summaries and 1,000 saved facts; installations exceeding either bound must export those tables separately before adopting this importer.

Legacy adoption is disabled when an `AUTH` service is configured: an old unowned session ID is not sufficient evidence to assign its data to a particular tenant. Such installations should export legacy content under administrative control and import it through an application-specific ownership migration.

Original flat R2 workspace objects are retained, but the new file tools use private owner prefixes. Copy selected old objects into the new prefix using your storage administration tooling after establishing ownership. The prefix is `files/<SHA-256 of JSON.stringify([workspaceId,userId])>/`. Do not bulk-copy a shared bucket into every user's prefix.

Old SDK schedules are not converted into new jobs automatically. Recreate desired reminders after upgrade. The previous WhatsApp channel module remains an unconnected prototype; Telegram is now available through the [messaging plugin interface](messaging.md).

## Messaging and device release

Apply additive migrations `0002_messaging.sql` and `0003_devices.sql` to the existing control database before deploying this release (`npx wrangler d1 migrations apply durable-claw-control --remote`). The existing Durable Object class bindings and migration history are unchanged. Channel receipts are created lazily in the owner's SQLite storage. Use Connections to link a private Telegram chat and enroll each Mac; no device or external chat gains access automatically.

Configure [Access](access-security.md) before production device use. Preserve the existing owner's identity when switching auth; the built-in Access mode maps to the original `owner/default` workspace. Test authenticated and rejected requests, then remove the legacy token. Returning to the previous Worker version leaves the new D1 tables intact but disables device polling and Telegram ingress; uninstall or stop local LaunchAgents when rolling back. Revoke/unlink before intentionally transferring workspace ownership.

Owner SQLite storage upgrades add content-free source-message exclusion records for memory forgetting. No transcript is removed by that migration. Existing version-1 MCP credential envelopes remain usable only from their persisted server configuration and upgrade to context-bound encryption when saved unchanged. Changing the server name or URL requires entering its credentials again. Legacy import record IDs distinguish message, summary, memory, and session identities while retaining matching records from earlier imports.

There is no automatic rollback migration. Back up/export data before changing runtime versions and test against a copy of your installation. Returning to the old unauthenticated routing would not expose new authenticated conversation history under its old session identifiers.

## Google Workspace connector deployment

The optional external-service connector is a separate Worker and credential Durable Object deployment. Follow [service connector setup](service-connectors.md), configure its dedicated secrets and named service binding, then deploy the main app. Its DO migration does not change the existing main D1 or agent objects. Existing installations without the binding remain supported. Google consent selects explicit services, and every generic gogcli command requires web approval.

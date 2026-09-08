# Upgrading an existing installation

The `NanoChatAgent` class and the existing `v1` migration are retained. The `v2` migration adds `ResearchSubagent`. Original SQLite tables and R2 objects remain stored. New sessions route by authenticated user/workspace rather than an unauthenticated browser session name.

Before updating, record the old browser session identifier from its URL fragment or the `durableclaw-session` local-storage entry. Keep that identifier private; the old installation did not attach ownership records to sessions.

After deploying the new runtime and control-database migration, a single-owner installation can adopt an old session through authenticated `POST /api/legacy/import`:

```json
{ "session_id": "old-session-id", "after": 0 }
```

The response contains the new `conversation_id` and `next_cursor`. Repeat with that cursor until it is null. Message imports are idempotent and preserve timestamps. Stored summaries and saved key/value memories are imported as readable messages. Original records are not deleted. The bounded first page imports up to 1,000 old summaries and 1,000 saved facts; installations exceeding either bound must export those tables separately before adopting this importer.

Legacy adoption is disabled when an `AUTH` service is configured: an old unowned session ID is not sufficient evidence to assign its data to a particular tenant. Such installations should export legacy content under administrative control and import it through an application-specific ownership migration.

Original flat R2 workspace objects are retained, but the new file tools use private owner prefixes. Copy selected old objects into the new prefix using your storage administration tooling after establishing ownership. The prefix is `files/<SHA-256 of JSON.stringify([workspaceId,userId])>/`. Do not bulk-copy a shared bucket into every user's prefix.

Old SDK schedules are not converted into new jobs automatically. Recreate desired reminders after upgrade. The previous WhatsApp channel module was an unconnected prototype; this runtime exposes generic authenticated events and inbox integration instead of claiming a working messaging transport.

Owner SQLite storage upgrades add content-free source-message exclusion records for memory forgetting. No transcript is removed by that migration. Existing version-1 MCP credential envelopes remain usable only from their persisted server configuration and upgrade to context-bound encryption when saved unchanged. Changing the server name or URL requires entering its credentials again. Legacy import record IDs distinguish message, summary, memory, and session identities while retaining matching records from earlier imports.

There is no automatic rollback migration. Back up/export data before changing runtime versions and test against a copy of your installation. Returning to the old unauthenticated routing would not expose new authenticated conversation history under its old session identifiers.

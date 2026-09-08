CREATE TABLE IF NOT EXISTS agent_wake_registry (
 do_name TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT NOT NULL,
 next_wake_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wake_registry_due ON agent_wake_registry(enabled,next_wake_at);
CREATE TABLE IF NOT EXISTS workspace_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
 kind TEXT NOT NULL, resource_id TEXT NOT NULL, summary TEXT NOT NULL,
 salience TEXT NOT NULL DEFAULT 'medium', occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_events_owner ON workspace_events(user_id,workspace_id,sequence);
CREATE TABLE IF NOT EXISTS inbox (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
 kind TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER
);
CREATE INDEX IF NOT EXISTS inbox_owner ON inbox(user_id,workspace_id,created_at);
CREATE TABLE IF NOT EXISTS socket_tickets (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS socket_tickets_expiry ON socket_tickets(expires_at);

-- Device credentials are public verification keys; enrollment secrets are hashed.
CREATE TABLE IF NOT EXISTS device_enrollments (
 code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
 name TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS device_enrollments_owner ON device_enrollments(user_id,workspace_id,expires_at);
CREATE TABLE IF NOT EXISTS devices (
 device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
 name TEXT NOT NULL, public_key TEXT NOT NULL, created_at INTEGER NOT NULL,
 last_seen_at INTEGER, revoked_at INTEGER,
 UNIQUE(user_id,workspace_id,public_key)
);
CREATE INDEX IF NOT EXISTS devices_owner ON devices(user_id,workspace_id,created_at);
CREATE TABLE IF NOT EXISTS device_nonces (
 device_id TEXT NOT NULL REFERENCES devices(device_id), nonce TEXT NOT NULL,
 expires_at INTEGER NOT NULL, PRIMARY KEY(device_id,nonce)
);
CREATE INDEX IF NOT EXISTS device_nonces_expiry ON device_nonces(expires_at);
CREATE TABLE IF NOT EXISTS device_jobs (
 job_id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(device_id),
 user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 confirmation_id TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL,
 timeout_ms INTEGER NOT NULL CHECK(timeout_ms BETWEEN 1 AND 120000),
 status TEXT NOT NULL CHECK(status IN ('queued','claimed','completed','cancelled','expired','unknown')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 claim_id TEXT, claimed_at INTEGER, claim_expires_at INTEGER,
 completed_at INTEGER, result_json TEXT,
 UNIQUE(user_id,workspace_id,confirmation_id)
);
CREATE INDEX IF NOT EXISTS device_jobs_queue ON device_jobs(device_id,status,created_at);
CREATE INDEX IF NOT EXISTS device_jobs_owner ON device_jobs(user_id,workspace_id,created_at);

-- Opaque, one-use button tokens. Exact action data remains in its Durable Object.
-- Retain claims after expiry/unlink so ambiguous sends cannot be repeated.
CREATE TABLE IF NOT EXISTS messaging_approvals (
  token_hash TEXT PRIMARY KEY,
  confirmation_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('sending','sent','send_unknown','consumed','unlinked')),
  decision TEXT CHECK(decision IN ('confirmed','declined')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL,
  UNIQUE(user_id, workspace_id, link_id, conversation_id, confirmation_id)
);
CREATE INDEX IF NOT EXISTS messaging_approval_owner ON messaging_approvals(user_id, workspace_id);
CREATE INDEX IF NOT EXISTS messaging_approval_retention ON messaging_approvals(retain_until);

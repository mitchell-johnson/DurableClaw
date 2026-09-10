CREATE TABLE IF NOT EXISTS messaging_link_codes (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(user_id, workspace_id, plugin_id)
);
CREATE INDEX IF NOT EXISTS messaging_codes_expiry ON messaging_link_codes(expires_at);

CREATE TABLE IF NOT EXISTS messaging_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(plugin_id, sender_id),
  UNIQUE(plugin_id, chat_id),
  UNIQUE(user_id, workspace_id, plugin_id)
);

-- Kept independently of links so unlink/relink cannot reset deduplication.
-- No message content or reply content is stored in the control database.
CREATE TABLE IF NOT EXISTS messaging_deliveries (
  request_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing', 'dispatch_unknown', 'sending', 'sent', 'send_unknown', 'unlinked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(plugin_id, event_id)
);
CREATE INDEX IF NOT EXISTS messaging_delivery_owner ON messaging_deliveries(user_id, workspace_id, created_at);
CREATE INDEX IF NOT EXISTS messaging_delivery_expiry ON messaging_deliveries(expires_at);

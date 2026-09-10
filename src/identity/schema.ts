import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });
export const user = sqliteTable("identity_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});
export const session = sqliteTable("identity_session", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  authMethod: text("auth_method").notNull(),
  authProof: text("auth_proof").notNull().default("none"),
});
export const account = sqliteTable(
  "identity_account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("identity_account_subject").on(
      table.providerId,
      table.accountId,
    ),
  ],
);
export const verification = sqliteTable("identity_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});
export const passkey = sqliteTable("identity_passkey", {
  id: text("id").primaryKey(),
  name: text("name"),
  publicKey: text("public_key").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  credentialID: text("credential_id").notNull().unique(),
  counter: integer("counter").notNull(),
  deviceType: text("device_type").notNull(),
  backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
  transports: text("transports"),
  createdAt: timestamp("created_at"),
  aaguid: text("aaguid"),
});
export const schema = { user, session, account, verification, passkey };

// SQL is bundled with the DO; neither D1 nor a migration service is involved.
export function migrateIdentity(storage: DurableObjectStorage): void {
  storage.transactionSync(() =>
    storage.sql.exec(`
    CREATE TABLE IF NOT EXISTS identity_user (
      id TEXT PRIMARY KEY CHECK (id = 'owner'), name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE, email_verified INTEGER NOT NULL CHECK (email_verified = 1),
      image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS identity_immutable_email BEFORE UPDATE OF email ON identity_user
      WHEN NEW.email != OLD.email BEGIN SELECT RAISE(ABORT, 'Owner identity is immutable'); END;
    CREATE TABLE IF NOT EXISTS identity_session (
      id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      ip_address TEXT, user_agent TEXT, auth_method TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS identity_session_user ON identity_session(user_id);
    CREATE TABLE IF NOT EXISTS identity_account (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL, provider_id TEXT NOT NULL, access_token TEXT, refresh_token TEXT, id_token TEXT,
      access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS identity_account_subject ON identity_account(provider_id, account_id);
    CREATE INDEX IF NOT EXISTS identity_account_user ON identity_account(user_id);
    CREATE TABLE IF NOT EXISTS identity_verification (
      id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS identity_verification_identifier ON identity_verification(identifier);
    CREATE TABLE IF NOT EXISTS identity_passkey (
      id TEXT PRIMARY KEY, name TEXT, public_key TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES identity_user(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE, counter INTEGER NOT NULL, device_type TEXT NOT NULL,
      backed_up INTEGER NOT NULL, transports TEXT, created_at INTEGER, aaguid TEXT
    );
    CREATE INDEX IF NOT EXISTS identity_passkey_user ON identity_passkey(user_id);
    CREATE TABLE IF NOT EXISTS identity_rate_limit (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_policy (id INTEGER PRIMARY KEY CHECK(id = 1), enrolled_at INTEGER);
    INSERT OR IGNORE INTO identity_policy(id,enrolled_at) VALUES(1,NULL);
  `),
  );
  storage.transactionSync(() => {
    if (
      !storage.sql
        .exec<{ name: string }>("PRAGMA table_info(identity_session)")
        .toArray()
        .some((column) => column.name === "auth_proof")
    )
      storage.sql.exec(
        "ALTER TABLE identity_session ADD COLUMN auth_proof TEXT NOT NULL DEFAULT 'none'",
      );
    // Existing installations with credentials cannot regain the initial exception.
    storage.sql.exec(
      `UPDATE identity_policy SET enrolled_at = ? WHERE id=1 AND enrolled_at IS NULL
      AND (EXISTS(SELECT 1 FROM identity_account WHERE password IS NOT NULL)
        OR EXISTS(SELECT 1 FROM identity_passkey))`,
      Date.now(),
    );
  });
}

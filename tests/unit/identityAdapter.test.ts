import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createIdentityAdapter } from "../../src/identity/adapter";
import { migrateIdentity } from "../../src/identity/schema";
import {
  accessSessionProof,
  boundedJson,
  completeEnrollment,
  consumeRateLimits,
  enrollmentCompleted,
  freshAuthority,
  freshSession,
  recoveryAuthority,
  requireUserVerification,
  validAccessEvidence,
} from "../../src/identity/security";

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

// Real SQLite and real Drizzle/Better Auth adapters; only the DO storage boundary
// is emulated. workerd integration tests independently exercise the real boundary.
function fixture() {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  const storage = {
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        if (query.includes(";") && bindings.length === 0) {
          sqlite.exec(query);
          return { toArray: () => [], rowsWritten: 0 };
        }
        const statement = sqlite.prepare(query);
        const rows = statement.reader
          ? (statement.all(...bindings) as Record<string, unknown>[])
          : [];
        const changes = statement.reader
          ? 0
          : statement.run(...bindings).changes;
        return {
          toArray: () => rows,
          one: () => {
            if (rows.length !== 1) throw new Error("Expected one row");
            return rows[0];
          },
          next: () => ({ value: rows[0] }),
          raw: () => ({ toArray: () => rows.map(Object.values) }),
          rowsWritten: changes,
        };
      },
    },
    transactionSync<T>(callback: () => T): T {
      return sqlite.transaction(callback)();
    },
    async transaction<T>(callback: () => Promise<T>): Promise<T> {
      sqlite.exec("BEGIN");
      try {
        const value = await callback();
        sqlite.exec("COMMIT");
        return value;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as DurableObjectStorage;
  migrateIdentity(storage);
  const identity = createIdentityAdapter(storage);
  const options = {
    emailAndPassword: { enabled: true },
    session: {
      additionalFields: {
        authMethod: {
          type: "string" as const,
          required: true,
          defaultValue: "password",
        },
      },
    },
  };
  const adapter = identity.database(options);
  const createOwner = () =>
    adapter.create({
      model: "user",
      forceAllowId: true,
      data: {
        id: "owner",
        name: "Owner",
        email: "owner@example.test",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  return { storage, sqlite, identity, adapter, createOwner };
}

describe("Durable Object identity adapter compatibility", () => {
  it("preserves affected-row counts for bulk writes and date/boolean mappings", async () => {
    const { adapter, createOwner } = fixture();
    await createOwner();
    const owner = await adapter.findOne<{
      emailVerified: boolean;
      createdAt: Date;
    }>({ model: "user", where: [{ field: "id", value: "owner" }] });
    expect(owner?.emailVerified).toBe(true);
    expect(owner?.createdAt).toBeInstanceOf(Date);
    expect(
      await adapter.updateMany({
        model: "user",
        where: [{ field: "id", value: "owner" }],
        update: { name: "Updated owner" },
      }),
    ).toBe(1);
    expect(
      await adapter.updateMany({
        model: "user",
        where: [{ field: "id", value: "missing" }],
        update: { name: "Absent" },
      }),
    ).toBe(0);
    expect(
      await adapter.deleteMany({
        model: "user",
        where: [{ field: "id", value: "owner" }],
      }),
    ).toBe(1);
    expect(
      await adapter.deleteMany({
        model: "user",
        where: [{ field: "id", value: "owner" }],
      }),
    ).toBe(0);
  });

  it("rolls back awaited writes without invoking a sync transaction with a Promise", async () => {
    const { adapter } = fixture();
    await expect(
      adapter.transaction(async (transaction) => {
        await transaction.create({
          model: "user",
          forceAllowId: true,
          data: {
            id: "owner",
            name: "Owner",
            email: "owner@example.test",
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
        await Promise.resolve();
        throw new Error("rollback sentinel");
      }),
    ).rejects.toThrow("rollback sentinel");
    expect(await adapter.count({ model: "user" })).toBe(0);
  });

  it("allows the handler and library to share one async transaction", async () => {
    const { identity, adapter, createOwner } = fixture();
    await identity.transaction(() =>
      adapter.transaction(async () => {
        await createOwner();
      }),
    );
    expect(await adapter.count({ model: "user" })).toBe(1);
  });

  it("atomically consumes challenges once", async () => {
    const { adapter } = fixture();
    await adapter.create({
      model: "verification",
      data: {
        identifier: "challenge",
        value: "opaque",
        expiresAt: new Date(Date.now() + 10_000),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const claims = await Promise.all(
      Array.from({ length: 10 }, () =>
        adapter.consumeOne({
          model: "verification",
          where: [{ field: "identifier", value: "challenge" }],
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });
});

describe("identity policy primitives", () => {
  it("never renews an initial JWT's five-minute enrollment deadline", () => {
    const evidence = {
      issuedAt: 1_000_000,
      expiresAt: 5_000_000,
      authenticatedAt: null,
    };
    const first = {
      authMethod: "access",
      ...accessSessionProof(evidence, false),
    };
    const repeated = {
      authMethod: "access",
      ...accessSessionProof(evidence, false),
    };
    expect(first.createdAt.getTime()).toBe(evidence.issuedAt);
    expect(repeated.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(freshAuthority(first, false, 1_000_001)).toBe(true);
    expect(freshAuthority(repeated, false, 1_300_000)).toBe(false);
    expect(freshAuthority(first, true, 1_000_001)).toBe(false);
    expect(recoveryAuthority(first, false, 1_000_001)).toBe(false);
    const renewed = {
      authMethod: "access",
      ...accessSessionProof({ ...evidence, issuedAt: 1_600_000 }, true),
    };
    expect(freshAuthority(renewed, true, 1_600_001)).toBe(false);
  });

  it("permits recovery only with fresh passkey or upstream authentication proof", () => {
    const evidence = {
      issuedAt: 1_100_000,
      expiresAt: 5_000_000,
      authenticatedAt: 1_000_000,
    };
    const access = {
      authMethod: "access",
      ...accessSessionProof(evidence, true),
    };
    expect(recoveryAuthority(access, true, 1_100_001)).toBe(true);
    expect(recoveryAuthority(access, true, 1_300_000)).toBe(false);
    expect(
      recoveryAuthority(
        { authMethod: "passkey", createdAt: 1_100_000 },
        true,
        1_100_001,
      ),
    ).toBe(true);
    expect(
      recoveryAuthority(
        { authMethod: "password", createdAt: 1_100_000 },
        true,
        1_100_001,
      ),
    ).toBe(false);
    expect(validAccessEvidence(evidence, 1_100_001)).toBe(true);
    for (const invalid of [
      { ...evidence, issuedAt: 1_200_000 },
      { ...evidence, expiresAt: 1_100_000 },
      { ...evidence, authenticatedAt: 1_200_000 },
      { ...evidence, issuedAt: Number.NaN },
    ])
      expect(validAccessEvidence(invalid, 1_100_001)).toBe(false);
  });

  it("permanently closes enrollment and revokes initial sessions without reopening after deletion", async () => {
    const { storage, sqlite, createOwner } = fixture();
    await createOwner();
    expect(enrollmentCompleted(storage)).toBe(false);
    for (const [id, method, proof] of [
      ["initial", "access", "enrollment"],
      ["upstream", "access", "upstream"],
      ["native", "passkey", "native"],
    ]) {
      sqlite
        .prepare(
          "INSERT INTO identity_session(id,token,user_id,expires_at,created_at,updated_at,auth_method,auth_proof) VALUES(?,?,'owner',9999999999999,1,1,?,?)",
        )
        .run(id, id + "-token", method, proof);
    }
    completeEnrollment(storage);
    expect(enrollmentCompleted(storage)).toBe(true);
    expect(
      sqlite.prepare("SELECT id FROM identity_session ORDER BY id").all(),
    ).toEqual([{ id: "native" }, { id: "upstream" }]);
    sqlite.exec("DELETE FROM identity_account; DELETE FROM identity_passkey;");
    migrateIdentity(storage);
    expect(enrollmentCompleted(storage)).toBe(true);
  });

  it("enforces combined IP/account limits atomically and expires the window", () => {
    const { storage, sqlite } = fixture();
    expect(consumeRateLimits(storage, ["ip-a", "owner"], 2, 1000, 10)).toBe(
      true,
    );
    expect(consumeRateLimits(storage, ["ip-b", "owner"], 2, 1000, 11)).toBe(
      true,
    );
    expect(consumeRateLimits(storage, ["ip-c", "owner"], 2, 1000, 12)).toBe(
      false,
    );
    expect(
      sqlite
        .prepare("SELECT * FROM identity_rate_limit WHERE key='ip-c'")
        .get(),
    ).toBeUndefined();
    expect(consumeRateLimits(storage, ["ip-a", "owner"], 2, 1000, 1010)).toBe(
      true,
    );
  });

  it("requires cryptographically verified UV and a bounded fresh session", () => {
    expect(() => requireUserVerification(true)).not.toThrow();
    for (const flag of [false, undefined])
      expect(() => requireUserVerification(flag)).toThrow();
    expect(freshSession(1000, 1001)).toBe(true);
    expect(freshSession(1000, 301000)).toBe(false);
    expect(freshSession(2000, 1000)).toBe(false);
    expect(freshSession("invalid", 1000)).toBe(false);
  });

  it("bounds the actual streamed body independently of content-length", async () => {
    const request = new Request("https://identity.example.test", {
      method: "POST",
      body: JSON.stringify({ password: "x".repeat(33 * 1024) }),
    });
    await expect(boundedJson(request)).rejects.toMatchObject({
      statusCode: 413,
    });
    await expect(
      boundedJson(
        new Request("https://identity.example.test", {
          method: "POST",
          body: "[]",
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

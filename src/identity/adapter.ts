import { AsyncLocalStorage } from "node:async_hooks";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/durable-sqlite";
import type { SQLiteDOSession } from "drizzle-orm/durable-sqlite/session";
import { schema } from "./schema";

/** Compatibility seam pinned to Drizzle 0.45.2 / Better Auth 1.7.3. */
export function createIdentityAdapter(storage: DurableObjectStorage) {
  const db = drizzle(storage, { schema, logger: false });
  const transactionContext = new AsyncLocalStorage<boolean>();
  const transaction = <T>(callback: () => Promise<T>): Promise<T> =>
    transactionContext.getStore()
      ? callback()
      : storage.transaction(() => transactionContext.run(true, callback));

  // The official DO driver returns void from run(). Better Auth needs the
  // affected row count. Capture changes() synchronously, before another query.
  const driver = (
    db as unknown as {
      session: SQLiteDOSession<typeof schema, Record<string, never>>;
    }
  ).session;
  const prepare = driver.prepareQuery.bind(driver);
  driver.prepareQuery = ((...args: Parameters<typeof prepare>) => {
    const query = prepare(...args);
    const run = query.run.bind(query);
    query.run = (...parameters) => {
      run(...parameters);
      return {
        changes: storage.sql
          .exec<{ count: number }>("SELECT changes() AS count")
          .one().count,
      };
    };
    return query;
  }) as typeof driver.prepareQuery;

  // Better Auth awaits transaction callbacks; the driver's transactionSync
  // cannot accept them. Keep its normal sync API untouched for migrations.
  const asyncDb = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return <T>(callback: (database: typeof db) => Promise<T>) =>
          transaction(() => callback(asyncDb));
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    db,
    transaction,
    database: drizzleAdapter(asyncDb, {
      provider: "sqlite",
      schema,
      transaction: true,
    }),
  };
}

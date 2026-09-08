import Database from "better-sqlite3";
import { afterEach } from "vitest";

const databases = new Set<Database.Database>();
afterEach(() => {
  for (const db of databases) db.close();
  databases.clear();
});

/** Run storage SQL on SQLite, including native rowid and ordering semantics. */
export function createSqliteStorage() {
  const db = new Database(":memory:");
  databases.add(db);
  return {
    exec(query: string, ...bindings: unknown[]) {
      let rows: Record<string, unknown>[] = [];
      // SqlStorage accepts DDL scripts. The statement API accepts one
      // statement, so bootstrap/migration scripts use SQLite's exec API.
      if (!bindings.length && /^\s*(CREATE|ALTER)\b/i.test(query)) {
        db.exec(query);
      } else {
        const statement = db.prepare(query);
        if (statement.reader)
          rows = statement.all(...bindings) as Record<string, unknown>[];
        else statement.run(...bindings);
      }
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1)
            throw new Error(`Expected one row, got ${rows.length}`);
          return rows[0];
        },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
  };
}

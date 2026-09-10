import { readFileSync } from "node:fs";
import { createSqliteStorage } from "./sqlite";

/** D1's statement surface over real SQLite, for single-statement channel jobs. */
export function createMessagingDb() {
  const sql = createSqliteStorage();
  sql.exec(
    readFileSync(
      new URL("../../migrations/0002_messaging.sql", import.meta.url),
      "utf8",
    ),
  );
  sql.exec(
    readFileSync(
      new URL("../../migrations/0004_messaging_approvals.sql", import.meta.url),
      "utf8",
    ).replace(/^--.*$/gm, ""),
  );
  const statement = (
    query: string,
    bindings: unknown[] = [],
  ): D1PreparedStatement =>
    ({
      bind: (...values: unknown[]) => statement(query, values),
      first: async () => sql.exec(query, ...bindings).toArray()[0] ?? null,
      run: async () => {
        const results = sql.exec(query, ...bindings).toArray();
        return {
          success: true,
          results,
          meta: { changes: sql.exec("SELECT changes() AS count").one().count },
        };
      },
    }) as D1PreparedStatement;
  const db = { prepare: statement } as D1Database;
  sql.exec(
    "INSERT INTO messaging_links VALUES ('link','owner','default','telegram','42','42','conversation',?)",
    Date.now(),
  );
  const claim = (requestId: string, status = "sent") =>
    sql.exec(
      "INSERT INTO messaging_deliveries VALUES (?,?,'link','owner','default','telegram',?,?,?,?)",
      requestId,
      requestId,
      status,
      Date.now(),
      Date.now(),
      Date.now() + 48 * 3600_000,
    );
  claim("request");
  return { sql, db, claim };
}
